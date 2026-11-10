/**
 * 揺れの物理(7章、A案: レイヤー単位のバネ・ダンパ)。DOM と Three.js に依存しない。
 *
 *   m s'' = -k s - c s' + F_inertia + F_gravity + F_grab
 *
 * 単位は「画像の長辺 = 2」の正規化座標。描画側で (長辺 / 2) を掛けてピクセルへ直す。
 * 積分は半陰的オイラー法、刻みは 1/120 秒固定。
 */
import type { Layer, PhysicsParams, AutoSwing, Vec3 } from '../model/project';

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

/**
 * 自動揺らしでドキュメントに与える加速度。周期 T の中で、1/4 で右、3/4 で左へ短く押す。
 * 周期 T ごとに同じ形を繰り返すので、T の整数倍の長さで書き出せばループする。
 */
export function autoSwingAccel(t: number, a: AutoSwing, out: Vec3 = v3()): Vec3 {
  out.x = out.y = out.z = 0;
  if (!a.enabled || a.strength <= 0) return out;
  const T = Math.max(0.05, a.period), sigma = Math.min(0.035, T / 16);
  const phase = ((t % T) + T) % T;
  const impulse = 2.2 * a.strength; // 1回の押しで与える速度変化
  const peak = impulse / (sigma * Math.sqrt(2 * Math.PI));
  const g1 = Math.exp(-0.5 * ((phase - 0.25 * T) / sigma) ** 2), g2 = Math.exp(-0.5 * ((phase - 0.75 * T) / sigma) ** 2);
  out.x = peak * (g1 - g2);
  out.y = -peak * 0.45 * (g1 + g2); // 慣性力は加速度の逆向きなので、上向きに跳ねる
  return out;
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
  private tmpA = v3();

  state(layerId: string): SpringState {
    let s = this.states.get(layerId);
    if (!s) this.states.set(layerId, (s = { s: v3(), v: v3() }));
    return s;
  }

  displacement(layerId: string): Vec3 { return this.states.get(layerId)?.s ?? v3(); }

  reset(): void { this.states.clear(); this.acc = 0; }

  /** 実時間で進める(描画フレームから呼ぶ)。1フレームの上限は 0.1 秒。 */
  advance(dt: number, layers: readonly Layer[]): void {
    if (this.paused) return;
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= PHYSICS_DT) { this.step(layers); this.acc -= PHYSICS_DT; }
  }

  /** 固定刻みで1回進める。 */
  step(layers: readonly Layer[], dt = PHYSICS_DT): void {
    const drive = autoSwingAccel(this.time, this.autoSwing, this.tmpA);
    drive.x += this.externalAccel.x; drive.y += this.externalAccel.y; drive.z += this.externalAccel.z;
    const grab = this.grab;
    for (const layer of layers) {
      const st = this.state(layer.id);
      if (!layer.physics.enabled || !layer.visible) { zero(st.s); zero(st.v); continue; }
      const { k, m, c, g } = coefficients(layer.physics);
      const gain = grab ? (this.grabGains.get(layer.id) ?? 1) * GRAB_GAIN : 0;
      let gx = 0, gy = 0, gz = 0;
      if (grab) {
        const len = Math.hypot(grab.x, grab.y, grab.z), sc = len > GRAB_LIMIT ? GRAB_LIMIT / len : 1;
        gx = grab.x * sc; gy = grab.y * sc; gz = grab.z * sc;
      }
      const fx = -k * st.s.x - c * st.v.x - m * drive.x + gain * gx;
      const fy = -k * st.s.y - c * st.v.y - m * drive.y + gain * gy - g * m;
      const fz = -k * st.s.z - c * st.v.z - m * drive.z + gain * gz;
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
