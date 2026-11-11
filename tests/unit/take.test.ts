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
