import { describe, it, expect } from 'vitest';
import { PhysicsWorld, coefficients, PHYSICS_DT } from '../../src/physics/world';
import { motionAnchor } from '../../src/physics/motion';
import { MotionRecorder } from '../../src/physics/recorder';
import { createDocument, PRESETS, PRESET_ORDER, MOTIONS, applyPreset, defaultCamera, type Layer, type MotionPattern } from '../../src/model/project';

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

  it('どの揺らし方も周期 T ごとに同じ位置に戻る(ループ書き出しの前提)', () => {
    for (const m of Object.keys(MOTIONS) as MotionPattern[]) {
      for (const t of [0.05, 0.31, 0.77, 1.2, 1.66]) {
        const p = motionAnchor(m, t, 1.7, 0.6), q = motionAnchor(m, t + 1.7 * 3, 1.7, 0.6);
        expect(q.x, m).toBeCloseTo(p.x, 6); expect(q.y, m).toBeCloseTo(p.y, 6); expect(q.z, m).toBeCloseTo(p.z, 6);
      }
    }
  });

  it('揺らし方の向き: 上下に小刻みは y だけ、鼓動は z だけ、ゆっくり左右は x だけ', () => {
    const axes = (m: MotionPattern) => {
      let x = 0, y = 0, z = 0;
      for (let t = 0; t < 2; t += 0.005) { const p = motionAnchor(m, t, 2, 1); x = Math.max(x, Math.abs(p.x)); y = Math.max(y, Math.abs(p.y)); z = Math.max(z, Math.abs(p.z)); }
      return { x, y, z };
    };
    const j = axes('jiggle'); expect(j.x).toBe(0); expect(j.z).toBe(0); expect(j.y).toBeGreaterThan(0.05);
    const h = axes('heartbeat'); expect(h.x).toBe(0); expect(h.y).toBe(0); expect(h.z).toBeGreaterThan(0.05);
    const s = axes('sway'); expect(s.y).toBe(0); expect(s.z).toBe(0); expect(s.x).toBeGreaterThan(0.05);
    expect(axes('none')).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('ジャンプ: 跳んでいる間は上、着地後は地面(0)', () => {
    const T = 2, at = (u: number) => motionAnchor('jump', u * T, T, 1).y;
    expect(at(0.33)).toBeGreaterThan(0.25); // 跳躍の頂点付近
    expect(at(0.05)).toBeLessThan(0);       // 踏み切り前に沈み込む
    expect(at(0.8)).toBe(0);                // 着地後
  });

  /** プリセットを当てて慣らしたあと、1周期ぶんの変位を記録する */
  const cycle = (preset: keyof typeof PRESETS) => {
    const l = layerWith(); l.physics = applyPreset(l.physics, preset);
    const w = new PhysicsWorld(), T = PRESETS[preset].period;
    w.autoSwing = { enabled: true, period: T, strength: 0.5 };
    run(w, [l], Math.ceil(20 / T) * T);
    const xs: number[] = [], ys: number[] = [], zs: number[] = [];
    for (let i = 0; i < Math.round(T / PHYSICS_DT); i++) { w.step([l]); const d = w.displacement(l.id); xs.push(d.x); ys.push(d.y); zs.push(d.z); }
    return { xs, ys, zs, rest: -coefficients(l.physics).g * coefficients(l.physics).m / coefficients(l.physics).k };
  };
  const crossings = (v: number[], c: number) => { let n = 0; for (let i = 1; i < v.length; i++) if ((v[i - 1] - c) * (v[i] - c) < 0) n++; return n; };

  it('ぷるぷる: 横には動かず、上下に何度も震える', () => {
    const { xs, ys, rest } = cycle('puru');
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-9);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.03);
    expect(crossings(ys, rest)).toBeGreaterThanOrEqual(6);
  });

  it('ばいんばいん: 跳び上がり、着地で静止位置より沈み込んでから上下に弾む', () => {
    const { xs, ys, rest } = cycle('bain');
    expect(Math.max(...xs.map(Math.abs))).toBeLessThan(1e-9);
    expect(Math.max(...ys)).toBeGreaterThan(0.08);           // 跳ぶ
    expect(Math.min(...ys)).toBeLessThan(rest - 0.03);       // 着地で沈み込む
    // 着地後(周期の後半)に静止位置をまたいで何度も弾む
    expect(crossings(ys.slice(Math.round(ys.length * 0.55)), rest)).toBeGreaterThanOrEqual(3);
  });

  it('どのプリセットも発散せず、それぞれ違う動きになる', () => {
    const sig = PRESET_ORDER.map(p => {
      const { xs, ys, zs } = cycle(p);
      const all = [...xs, ...ys, ...zs].map(Math.abs);
      expect(Math.max(...all), p).toBeLessThan(0.6);
      expect(Math.max(...all), p).toBeGreaterThan(0.005);
      return [xs, ys, zs].map(v => (Math.max(...v) - Math.min(...v)).toFixed(3)).join('/') + ':' + crossings(ys, ys[0]);
    });
    expect(new Set(sig).size).toBe(PRESET_ORDER.length);
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
