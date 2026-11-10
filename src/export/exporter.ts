/**
 * 書き出し。実時間の画面録画ではなく、1フレームずつ物理を進めて描画した画像を連結する。
 * PC の負荷に関係なく、常に指定 fps でコマ落ちの無い動画になる。
 */
import type { Stage } from '../stage/stage';
import type { Store, CameraState, Document } from '../model/project';
import { PhysicsWorld, PHYSICS_DT } from '../physics/world';
import { applySample, type MotionRecorder, type RecordSample } from '../physics/recorder';
import { createEncoder, FORMAT_INFO, even, type ExportFormat } from './encoders';

export type MotionSource = 'auto' | 'replay';

export interface ExportSettings {
  format: ExportFormat;
  width: number;
  height: number;
  fps: 60 | 30;
  duration: number;           // 秒
  background: string | null;  // null で透過
  motion: MotionSource;
}

export interface ExportContext {
  stage: Stage;
  store: Store;
  recorder: MotionRecorder;
  /** 現在のスイングを Stage へ反映する関数(App と同じ処理) */
  applySwing: (world: PhysicsWorld, doc: Document) => void;
}

export interface ExportResult { blob: Blob; filename: string; frames: number }

/** 自動揺らしを定常状態まで慣らす時間(秒) */
const WARMUP_SECONDS = 20;

export async function runExport(
  ctx: ExportContext, s: ExportSettings,
  onProgress: (done: number, total: number) => void, signal: AbortSignal,
): Promise<ExportResult> {
  const doc = ctx.store.doc;
  if (!doc) throw new Error('書き出す画像がありません');
  const width = even(s.width), height = even(s.height);
  const total = Math.max(1, Math.round(s.duration * s.fps));
  const stepsPerFrame = Math.round(1 / s.fps / PHYSICS_DT);
  const info = FORMAT_INFO[s.format];
  const background = info.alpha ? s.background : (s.background ?? '#ffffff');
  const project = ctx.store.project;

  // 書き出し専用の物理。画面側の状態には触れない
  const world = new PhysicsWorld();
  world.unitPx = Math.max(doc.image.width, doc.image.height) / 2;
  let samples: RecordSample[] | null = null;
  let camera: CameraState = structuredClone(project.camera);

  if (s.motion === 'replay') {
    const rec = ctx.recorder.lastSeconds(s.duration);
    if (!rec || rec.samples.length < 2) throw new Error('再生できる操作の記録がありません。「つかむ」で揺らしてから書き出してください。');
    world.restore(rec.start);
    world.autoSwing = { ...project.autoSwing };
    for (const smp of rec.warmup) { applySample(world, smp); world.step(doc.layers); }
    samples = rec.samples;
  } else {
    world.autoSwing = { ...project.autoSwing, enabled: true };
    // 周期の頭から始まるように、周期の整数倍だけ慣らす
    const T = world.autoSwing.period, warm = Math.ceil(WARMUP_SECONDS / T) * T;
    for (let i = 0, n = Math.round(warm / PHYSICS_DT); i < n; i++) world.step(doc.layers);
  }

  const encoder = createEncoder(s.format, { width, height, fps: s.fps, transparent: info.alpha && background === null });
  const frame = new Uint8ClampedArray(width * height * 4);
  try {
    for (let f = 0; f < total; f++) {
      if (signal.aborted) throw new DOMException('書き出しを中止しました', 'AbortError');
      if (samples) {
        const smp = samples[Math.min(samples.length - 1, f * stepsPerFrame)];
        camera = smp.camera;
      }
      ctx.applySwing(world, doc);
      ctx.stage.renderFrame(width, height, camera, background, frame);
      await encoder.addFrame(frame, f);
      for (let k = 0; k < stepsPerFrame; k++) {
        if (samples) applySample(world, samples[Math.min(samples.length - 1, f * stepsPerFrame + k)]);
        world.step(doc.layers);
      }
      onProgress(f + 1, total);
      if (f % 4 === 3) await new Promise(r => setTimeout(r, 0));
    }
    const blob = await encoder.finish();
    const base = (doc.name || 'popstage').replace(/\.[^.]+$/, '');
    return { blob, filename: `${base}.${info.ext}`, frames: total };
  } catch (e) {
    await encoder.cancel();
    throw e;
  }
}
