import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { smoothZoom } from '../../src/ui/smoothZoom';

/** requestAnimationFrame を手で進める */
let queue: FrameRequestCallback[] = [];
let now = 0;
const frame = (ms = 1000 / 60) => {
  now += ms;
  const q = queue; queue = [];
  for (const cb of q) cb(now);
};
const run = (n: number) => { for (let i = 0; i < n; i++) frame(); };

beforeEach(() => {
  queue = []; now = 0;
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { queue.push(cb); return queue.length; };
});
afterEach(() => { delete (globalThis as any).requestAnimationFrame; });

const target = (z = 1, min = 0.05, max = 10) => {
  const s = { z, writes: [] as number[], owner: {} as object };
  const zoom = smoothZoom({ get: () => s.z, set: v => { s.z = v; s.writes.push(v); }, owner: () => s.owner, min, max });
  return { s, zoom };
};

describe('ホイールのズームをなめらかにする(ui/smoothZoom.ts)', () => {
  it('その場では変えず、毎フレーム目標へ寄せて、最後は寄せずに変えたときと同じ値で止まる', () => {
    const { s, zoom } = target();
    zoom.add(0.24);
    expect(s.z).toBe(1);
    run(60);
    expect(s.z).toBe(Math.exp(0.24));
    expect(queue).toHaveLength(0); // 着いたらフレームを頼まない
    // 少しずつ増え、1フレームの動きは目標との差に比例して小さくなっていく
    const steps = s.writes.map((v, i) => Math.log(v / (i ? s.writes[i - 1] : 1)));
    expect(steps.every(d => d > 0)).toBe(true);
    for (let i = 1; i < steps.length - 1; i++) expect(steps[i]).toBeLessThan(steps[i - 1]);
  });

  it('途中で続けて回すと、今の値ではなく目標から先へ延ばす', () => {
    const { s, zoom } = target();
    zoom.add(0.2);
    run(3);
    zoom.add(0.2);
    run(60);
    expect(s.z).toBeCloseTo(Math.exp(0.4), 10);
  });

  it('途中で逆向きに回すと、目標から戻す', () => {
    const { s, zoom } = target();
    zoom.add(0.3);
    run(3);
    zoom.add(-0.5);
    run(60);
    expect(s.z).toBeCloseTo(Math.exp(-0.2), 10);
  });

  it('上限・下限で止まる', () => {
    const { s, zoom } = target(9);
    zoom.add(1);
    run(60);
    expect(s.z).toBe(10);
    const low = target(0.06);
    low.zoom.add(-1);
    run(60);
    expect(low.s.z).toBe(0.05);
  });

  it('寄せている途中でほかの操作が拡大率を変えたら、寄せるのをやめる', () => {
    const { s, zoom } = target();
    zoom.add(0.5);
    run(2);
    s.z = 1; // 視点のリセットなど
    run(30);
    expect(s.z).toBe(1);
    // そのあとのホイールは、変えられた値から始める
    zoom.add(0.1);
    run(60);
    expect(s.z).toBeCloseTo(Math.exp(0.1), 10);
  });

  it('最初のフレームより前に、ほかの操作がオブジェクトごと差し替えて同じ値を書いても、寄せるのをやめる', () => {
    const { s, zoom } = target();
    zoom.add(0.5);
    s.owner = {}; s.z = 1; // ホイールの直後に視点のリセットや読み込みで、拡大率 1 の視点に差し替わった
    run(30);
    expect(s.z).toBe(1);
  });

  it('倍率で書く図で丸めの誤差が出ても、途中で止まらない', () => {
    const s = { z: 1 }, owner = {};
    const zoom = smoothZoom({ get: () => s.z, set: (_v, f) => { s.z = s.z * f * (1 + 1e-14); }, owner: () => owner, min: 0.5, max: 20 });
    zoom.add(0.3);
    run(60);
    expect(s.z).toBeCloseTo(Math.exp(0.3), 6);
  });
});
