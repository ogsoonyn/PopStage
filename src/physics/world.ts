/**
 * 揺れの物理(7章、A案: レイヤー単位のバネ・ダンパ)。DOM と Three.js に依存しない。
 *
 *   m s'' = -k (s - b) - c (s' - b') + F_inertia + F_gravity + F_grab
 *
 * b は自動揺らしで動かす土台(アンカー)の位置。揺らし方ごとの軌道は motion.ts にある。
 * 土台が急に動いたり止まったりすると、塗った部分が遅れて付いてきて弾む。
 * 単位は「画像の長辺 = 2」の正規化座標。描画側で (長辺 / 2) を掛けてピクセルへ直す。
 * 積分は半陰的オイラー法、刻みは 1/120 秒固定。
 */
import type { Layer, PhysicsParams, AutoSwing, Vec3 } from '../model/project';
import { motionAnchor } from './motion';

export const PHYSICS_DT = 1 / 120;
const MAX_DISPLACEMENT = 1.2;
const GRAB_GAIN = 140;
const GRAB_LIMIT = 0.7;

export interface SpringState { s: Vec3; v: Vec3 }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function coefficients(p: PhysicsParams): { k: number; m: number; c: number; g: number } {
  return { k: lerp(20, 400, p.hardness), m: lerp(0.3, 3, p.mass), c: lerp(0.5, 12, p.damping), g: p.weight * 6 };
}

export interface WorldSnapshot { time: number; acc: number; states: [string, SpringState][] }

export class PhysicsWorld {
  /** 物理の経過時間(秒)。自動揺らしの位相に使う。 */
  time = 0;
  paused = false;
  autoSwing: AutoSwing = { enabled: false, period: 2, strength: 0.5 };
  /** つかみ: ドラッグ開始点からのポインタ移動量(正規化座標) */
  grab: Vec3 | null = null;
  /** つかみの効き具合(レイヤーごと、0〜1) */
  grabGains = new Map<string, number>();
  /** 外から与えるドキュメントの加速度(画像を振った時など) */
  externalAccel: Vec3 = v3();

  private states = new Map<string, SpringState>();
  private acc = 0;
  private anchor = v3();
  private anchorPrev = v3();

  state(layerId: string): SpringState {
    let s = this.states.get(layerId);
    if (!s) this.states.set(layerId, (s = { s: v3(), v: v3() }));
    return s;
  }

  displacement(layerId: string): Vec3 { return this.states.get(layerId)?.s ?? v3(); }

  reset(): void { this.states.clear(); this.acc = 0; }

  /** 実時間で進める(描画フレームから呼ぶ)。1フレームの上限は 0.1 秒。 */
  advance(dt: number, layers: readonly Layer[], beforeStep?: () => void): void {
    if (this.paused) return;
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= PHYSICS_DT) { beforeStep?.(); this.step(layers); this.acc -= PHYSICS_DT; }
  }

  /** 固定刻みで1回進める。 */
  step(layers: readonly Layer[], dt = PHYSICS_DT): void {
    const drive = this.externalAccel, grab = this.grab, auto = this.autoSwing, on = auto.enabled;
    const b = this.anchor, bp = this.anchorPrev;
    for (const layer of layers) {
      const st = this.state(layer.id);
      if (!layer.physics.enabled || !layer.visible) { zero(st.s); zero(st.v); continue; }
      const { k, m, c, g } = coefficients(layer.physics);
      // 土台の位置と速度(速度は1刻み前との差から求める)
      if (on) {
        motionAnchor(layer.physics.motion, this.time + dt, auto.period, auto.strength, b);
        motionAnchor(layer.physics.motion, this.time, auto.period, auto.strength, bp);
      } else { zero(b); zero(bp); }
      const bvx = (b.x - bp.x) / dt, bvy = (b.y - bp.y) / dt, bvz = (b.z - bp.z) / dt;
      const gain = grab ? (this.grabGains.get(layer.id) ?? 1) * GRAB_GAIN : 0;
      let gx = 0, gy = 0, gz = 0;
      if (grab) {
        const len = Math.hypot(grab.x, grab.y, grab.z), sc = len > GRAB_LIMIT ? GRAB_LIMIT / len : 1;
        gx = grab.x * sc; gy = grab.y * sc; gz = grab.z * sc;
      }
      const fx = -k * (st.s.x - b.x) - c * (st.v.x - bvx) - m * drive.x + gain * gx;
      const fy = -k * (st.s.y - b.y) - c * (st.v.y - bvy) - m * drive.y + gain * gy - g * m;
      const fz = -k * (st.s.z - b.z) - c * (st.v.z - bvz) - m * drive.z + gain * gz;
      st.v.x += (fx / m) * dt; st.v.y += (fy / m) * dt; st.v.z += (fz / m) * dt;
      st.s.x += st.v.x * dt; st.s.y += st.v.y * dt; st.s.z += st.v.z * dt;
      const len = Math.hypot(st.s.x, st.s.y, st.s.z);
      if (len > MAX_DISPLACEMENT) {
        const sc = MAX_DISPLACEMENT / len;
        st.s.x *= sc; st.s.y *= sc; st.s.z *= sc;
      }
    }
    this.time += dt;
  }

  snapshot(): WorldSnapshot {
    return { time: this.time, acc: this.acc, states: [...this.states].map(([id, s]) => [id, { s: { ...s.s }, v: { ...s.v } }]) };
  }

  restore(snap: WorldSnapshot): void {
    this.time = snap.time; this.acc = snap.acc;
    this.states = new Map(snap.states.map(([id, s]) => [id, { s: { ...s.s }, v: { ...s.v } }]));
  }
}

function zero(v: Vec3): void { v.x = v.y = v.z = 0; }
