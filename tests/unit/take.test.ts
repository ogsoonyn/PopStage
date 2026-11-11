import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { finalizeTake, takeToJson, takeFromJson, takeSeconds, TAKE_STEP_MULTIPLE, type Take } from '../../src/physics/take';
import type { RecordSample } from '../../src/physics/recorder';
import { PHYSICS_DT } from '../../src/physics/world';
import { serializeProject, deserializeProject, TAKE_PATH } from '../../src/storage/popstage';
import { createDocument, createProject } from '../../src/model/project';

const cam = (yaw = 0, tx = 0) => ({ fov: 30, yaw, pitch: 0.1, zoom: 1.5, target: { x: tx, y: 0, z: 0 } });
const smp = (yaw: number, tx = 0, grab: RecordSample['grab'] = null): RecordSample => ({
  grab, grabGains: grab ? [['L1', 0.5]] : [], camera: cam(yaw, tx), viewTarget: { x: tx, y: 0, z: 0 },
});
const seconds = (s: number) => Math.round(s / PHYSICS_DT);

describe('操作の記録を整える', () => {
  it('初めの何もしていない所を詰め、終わりは1秒だけ残し、長さを刻みの倍数にそろえる', () => {
    const raw: RecordSample[] = [];
    for (let i = 0; i < seconds(2); i++) raw.push(smp(0));            // 何もしていない2秒
    for (let i = 0; i < seconds(1.5) + 3; i++) raw.push(smp(i * 0.01)); // 回した1.5秒ちょっと
    const lastYaw = raw.at(-1)!.camera.yaw;
    for (let i = 0; i < seconds(5); i++) raw.push(smp(lastYaw));      // 止めるまでの5秒
    const take = finalizeTake(raw)!;
    expect(take.samples.length % TAKE_STEP_MULTIPLE).toBe(0);
    const len = takeSeconds(take);
    expect(len).toBeGreaterThan(2.4); expect(len).toBeLessThan(2.6);
  });

  it('終わりを初めの視点へ寄せて、継ぎ目で飛ばないようにする(1周回っていても巻き戻さない)', () => {
    const raw: RecordSample[] = [];
    const n = seconds(3);
    for (let i = 0; i < n; i++) raw.push(smp((i / n) * Math.PI * 2 + 0.3 + (i * 0.0001), i * 0.1));
    const take = finalizeTake(raw)!, s = take.samples, first = s[0], last = s.at(-1)!;
    const TAU = Math.PI * 2, dyaw = last.camera.yaw - first.camera.yaw;
    // 同じ向きへ寄る(差は 2π の整数倍にごく近い)
    expect(Math.abs(dyaw - TAU * Math.round(dyaw / TAU))).toBeLessThan(0.05);
    expect(Math.round(dyaw / TAU)).toBe(1);
    expect(Math.abs(last.camera.target.x - first.camera.target.x)).toBeLessThan(1);
    expect(Math.abs(last.viewTarget!.x - first.viewTarget!.x)).toBeLessThan(1);
    // 元の並びは書き換えない
    expect(raw.at(-1)!.camera.target.x).toBeCloseTo((n - 1) * 0.1);
  });

  it('短すぎる記録は捨てる', () => {
    expect(finalizeTake(Array.from({ length: 20 }, (_, i) => smp(i * 0.1)))).toBeNull();
    expect(finalizeTake(Array.from({ length: seconds(3) }, () => smp(0)))).toBeNull();
  });
});

describe('操作の記録の保存', () => {
  const makeTake = (): Take => finalizeTake(Array.from({ length: seconds(1) }, (_, i) => smp(i * 0.01, i, i > 30 && i < 80 ? { x: 0.1, y: -0.2, z: 0 } : null)))!;

  it('JSON の往復で中身が変わらない(画角は読み込み側の値)', () => {
    const take = makeTake(), back = takeFromJson(JSON.parse(JSON.stringify(takeToJson(take))), 42)!;
    expect(back.samples.length).toBe(take.samples.length);
    back.samples.forEach((b, i) => {
      const a = take.samples[i];
      expect(b.camera.fov).toBe(42);
      expect(b.camera.yaw).toBeCloseTo(a.camera.yaw, 5);
      expect(b.camera.target.x).toBeCloseTo(a.camera.target.x, 5);
      expect(b.viewTarget!.x).toBeCloseTo(a.viewTarget!.x, 5);
      expect(b.grab === null).toBe(a.grab === null);
      expect(b.grabGains).toEqual(a.grabGains);
    });
    // つかみの効き具合は組にまとめて持つ
    expect(takeToJson(take).gainSets.length).toBe(1);
  });

  it('細工した記録でも、つかみの組は上限まで・サンプル間で共有して読み、長さは刻みの倍数に切り捨てる', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => [`L${i}`, 0.5]);
    const row = [0, 0, 1, 0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, 0];
    const t = takeFromJson({ version: 1, gainSets: [huge, ...Array(100000).fill([])], samples: Array.from({ length: 61 + 60 }, () => row) }, 30)!;
    expect(t.samples.length).toBe(120);
    expect(t.samples[0].grabGains.length).toBe(8);
    expect(t.samples[0].grabGains).toBe(t.samples[1].grabGains);
  });

  it('最長を超えて積まれた記録は最長で切る', () => {
    const t = finalizeTake(Array.from({ length: seconds(60) + 11 }, (_, i) => smp(i * 0.001)))!;
    expect(t.samples.length).toBeLessThanOrEqual(seconds(60));
    expect(takeFromJson(JSON.parse(JSON.stringify(takeToJson(t))), 30)).not.toBeNull();
  });

  it('壊れた記録は読まない', () => {
    expect(takeFromJson(null, 30)).toBeNull();
    expect(takeFromJson({ version: 2, samples: [] }, 30)).toBeNull();
    expect(takeFromJson({ version: 1, dt: 1 / 60, samples: [] }, 30)).toBeNull();
    expect(takeFromJson({ version: 1, samples: [[1, 2, 3]] }, 30)).toBeNull();
    expect(takeFromJson({ version: 1, samples: Array.from({ length: 10000 }, () => Array(14).fill(0)) }, 30)).toBeNull();
  });

  it('.pukupop に入れて読み戻せる。記録の無いファイル・読めない記録は記録なしで開く', async () => {
    const doc = createDocument({ bytes: new Uint8Array([9, 8, 7, 6]), mime: 'image/jpeg', ext: 'jpg', width: 300, height: 200 }, 'プリン');
    const p = createProject(doc);
    expect((await deserializeProject(serializeProject(p))).project.take).toBeNull();
    expect(unzipSync(serializeProject(p))[TAKE_PATH]).toBeUndefined();

    p.take = makeTake();
    const bytes = serializeProject(p), back = (await deserializeProject(bytes)).project;
    expect(back.take?.samples.length).toBe(p.take.samples.length);

    const broken = zipSync({ ...unzipSync(bytes), [TAKE_PATH]: strToU8('{oops') });
    const opened = (await deserializeProject(broken)).project;
    expect(opened.take).toBeNull();
    expect(opened.documents[0].name).toBe('プリン');
  });
});

describe('スタートとエンドから動きを作る', () => {
  const start = { yaw: 0, pitch: 0, zoom: 1, target: { x: 0, y: 0, z: 0 } };
  const end = { yaw: 1, pitch: 0.4, zoom: 4, target: { x: 100, y: -50, z: 0 } };

  it('往復: 1周は片道の2倍で、真ん中でエンド、終わりはスタートへ戻る。端で速さが 0(なめらか)', async () => {
    const { takeFromPath, TAKE_STEP_MULTIPLE } = await import('../../src/physics/take');
    const t = takeFromPath({ start, end, seconds: 1, ease: 'smooth', repeat: 'pingpong' }, 30), s = t.samples, n = s.length;
    expect(n).toBe(seconds(2)); expect(n % TAKE_STEP_MULTIPLE).toBe(0);
    expect(s[0].camera.yaw).toBe(0);
    expect(s[n / 2].camera.yaw).toBeCloseTo(1); expect(s[n / 2].camera.zoom).toBeCloseTo(4); expect(s[n / 2].viewTarget!.x).toBeCloseTo(100);
    // ズームは比で補間する(4分の1の所で √2 ではなく、半分の所で 2)
    const half = s.findIndex(x => x.camera.yaw >= 0.5);
    expect(s[half].camera.zoom).toBeCloseTo(2, 1);
    expect(Math.abs(s[1].camera.yaw - s[0].camera.yaw)).toBeLessThan(1e-3);
    expect(Math.abs(s[n - 1].camera.yaw)).toBeLessThan(1e-3);
    expect(s.some(x => x.viewCut)).toBe(false);
    expect(t.path?.repeat).toBe('pingpong');
    expect(s[0].camera.fov).toBe(30);
  });

  it('片道: 終わりでエンドに着き、初めの1件で視点を測り直す(スタートへ飛ぶ所で揺らさない)。一定は同じ速さ', async () => {
    const { takeFromPath, TAKE_STEP_MULTIPLE } = await import('../../src/physics/take');
    const t = takeFromPath({ start, end, seconds: 1.5, ease: 'linear', repeat: 'loop' }, 30), s = t.samples, n = s.length;
    expect(n % TAKE_STEP_MULTIPLE).toBe(0);
    expect(s[0].viewCut).toBe(true);
    expect(s[n - 1].camera.yaw).toBeCloseTo(1);
    const d1 = s[1].camera.yaw - s[0].camera.yaw, d2 = s[n - 1].camera.yaw - s[n - 2].camera.yaw;
    expect(d1).toBeCloseTo(d2, 6);
  });

  it('設定は記録と一緒に保存され、範囲外は丸める', async () => {
    const { takeFromPath } = await import('../../src/physics/take');
    const t = takeFromPath({ start, end, seconds: 99, ease: 'linear', repeat: 'loop' }, 30);
    expect(t.path!.seconds).toBe(20);
    const back = takeFromJson(JSON.parse(JSON.stringify(takeToJson(t))), 30)!;
    expect(back.path).toEqual(t.path);
    const bad = takeFromJson({ ...takeToJson(t), path: { start: 'x', ease: 'zzz', seconds: -1 } }, 30)!;
    expect(bad.path).toMatchObject({ ease: 'smooth', repeat: 'pingpong', seconds: 0.5 });
  });
});
