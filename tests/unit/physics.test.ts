import { describe, it, expect } from 'vitest';
import { PhysicsWorld, coefficients, autoSwingAccel, PHYSICS_DT } from '../../src/physics/world';
import { MotionRecorder } from '../../src/physics/recorder';
import { createDocument, PRESETS, defaultCamera, type Layer } from '../../src/model/project';

const image = { bytes: new Uint8Array(), mime: 'image/png', ext: 'png', width: 100, height: 100 };
const layerWith = (patch: Partial<Layer['physics']> = {}): Layer => {
  const l = createDocument(image, 'd').layers[0];
  l.physics = { ...l.physics, ...patch };
  return l;
};
const run = (w: PhysicsWorld, layers: Layer[], seconds: number) => { for (let i = 0; i < seconds / PHYSICS_DT; i++) w.step(layers); };

describe('揺れの物理', () => {
  it('重さだけが効くとき、静止位置は -g·m/k に収束する', () => {
    const l = layerWith({ weight: 0.5 }), w = new PhysicsWorld();
    run(w, [l], 30);
    const { k, m, g } = coefficients(l.physics);
    expect(w.displacement(l.id).y).toBeCloseTo(-g * m / k, 4);
    expect(w.state(l.id).v.y).toBeCloseTo(0, 4);
  });

  it('初速を与えると減衰して止まる', () => {
    const l = layerWith({ weight: 0 }), w = new PhysicsWorld();
    w.state(l.id).v.x = 2;
    run(w, [l], 0.1);
    expect(Math.abs(w.displacement(l.id).x)).toBeGreaterThan(0.01);
    run(w, [l], 40);
    expect(Math.abs(w.displacement(l.id).x)).toBeLessThan(1e-4);
  });

  it('おさまりが大きいほど早く止まる', () => {
    const energyAfter = (damping: number) => {
      const l = layerWith({ weight: 0, damping }), w = new PhysicsWorld();
      w.state(l.id).v.x = 2; run(w, [l], 1.5);
      const s = w.state(l.id); return s.s.x ** 2 + s.v.x ** 2;
    };
    expect(energyAfter(0.9)).toBeLessThan(energyAfter(0.1));
  });

  it('硬いほど細かく速く揺れる(ゼロ交差が多い)', () => {
    const crossings = (hardness: number) => {
      const l = layerWith({ weight: 0, damping: 0, hardness }), w = new PhysicsWorld();
      w.state(l.id).v.x = 1;
      let n = 0, prev = 0;
      for (let i = 0; i < 240; i++) { w.step([l]); const x = w.displacement(l.id).x; if (prev * x < 0) n++; prev = x; }
      return n;
    };
    expect(crossings(PRESETS.buru.hardness)).toBeGreaterThan(crossings(PRESETS.bain.hardness));
  });

  it('つかむとポインタの方向へ引っ張られ、離すと戻る', () => {
    const l = layerWith({ weight: 0 }), w = new PhysicsWorld();
    w.grab = { x: 0.3, y: 0, z: 0 };
    run(w, [l], 5);
    expect(w.displacement(l.id).x).toBeGreaterThan(0.05);
    w.grab = null;
    run(w, [l], 40);
    expect(Math.abs(w.displacement(l.id).x)).toBeLessThan(1e-3);
  });

  it('揺れ無効・非表示のレイヤーは動かない', () => {
    const a = layerWith({ enabled: false, weight: 1 }), w = new PhysicsWorld();
    run(w, [a], 1);
    expect(w.displacement(a.id)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('自動揺らしは周期 T ごとに同じ加速度になる(ループ書き出しの前提)', () => {
    const a = { enabled: true, period: 1.7, strength: 0.6 };
    for (const t of [0.1, 0.42, 0.9, 1.3]) {
      expect(autoSwingAccel(t, a).x).toBeCloseTo(autoSwingAccel(t + 1.7 * 3, a).x, 6);
    }
    // 1周期の積分(速度変化)は x で打ち消し合う
    let sum = 0; for (let t = 0; t < 1.7; t += 0.0005) sum += autoSwingAccel(t, a).x * 0.0005;
    expect(Math.abs(sum)).toBeLessThan(1e-3);
  });

  it('十分に慣らしたあとは周期ごとに同じ状態に戻る', () => {
    const l = layerWith(), w = new PhysicsWorld();
    w.autoSwing = { enabled: true, period: 1.5, strength: 0.5 };
    run(w, [l], 30);
    const a = { ...w.displacement(l.id) };
    run(w, [l], 1.5);
    const b = w.displacement(l.id);
    expect(b.x).toBeCloseTo(a.x, 3); expect(b.y).toBeCloseTo(a.y, 3);
  });

  it('スナップショットから復元すると同じ結果になる', () => {
    const l = layerWith(), w = new PhysicsWorld();
    w.autoSwing = { enabled: true, period: 1, strength: 1 };
    run(w, [l], 0.7);
    const snap = w.snapshot();
    run(w, [l], 1); const x1 = w.displacement(l.id).x;
    w.restore(snap); run(w, [l], 1);
    expect(w.displacement(l.id).x).toBe(x1);
  });
});

describe('操作の記録', () => {
  it('直近 N 秒を返し、控えから開始点までの記録も付く', () => {
    const rec = new MotionRecorder(), w = new PhysicsWorld(), l = layerWith();
    for (let i = 0; i < 600; i++) {
      rec.record({ grab: i > 300 ? { x: 0.1, y: 0, z: 0 } : null, grabGains: [], camera: defaultCamera() }, () => w.snapshot());
      w.step([l]);
    }
    const r = rec.lastSeconds(2)!;
    expect(r.samples.length).toBe(240);
    expect(r.warmup.length).toBe(0); // 開始点(360)は控え(120の倍数)にちょうど乗る
    const r2 = rec.lastSeconds(1.5)!;
    expect(r2.samples.length).toBe(180);
    expect(r2.warmup.length + r2.samples.length).toBe(600 - 360);
  });

  it('60秒を超える古い記録は捨てる', () => {
    const rec = new MotionRecorder(), w = new PhysicsWorld();
    for (let i = 0; i < 120 * 70; i++) rec.record({ grab: null, grabGains: [], camera: defaultCamera() }, () => w.snapshot());
    expect(rec.seconds).toBeLessThanOrEqual(61.01);
    expect(rec.seconds).toBeGreaterThanOrEqual(60);
  });
});
