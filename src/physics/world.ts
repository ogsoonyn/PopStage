/**
 * 揺れの物理(レイヤー単位のバネ・ダンパ)。DOM と Three.js に依存しない。
 *
 *   m s'' = -k (s - b) - c (s' - b') + F_inertia + F_gravity + F_grab
 *
 * b は自動揺らしで動かす土台(アンカー)の位置。揺らし方ごとの軌道は motion.ts にある。
 * 土台が急に動いたり止まったりすると、塗った部分が遅れて付いてきて弾む。
 * 視点の平行移動で画像が画面上を動いたときも、その加速度を慣性力として加える(F_inertia)。
 * 揺らし方「ピストン」で画像全体が動くときも、その加速度を同じく慣性力として、揺れが有効なすべてのレイヤーに加える。
 * s は画像に対する変位なので、画面上の位置は「画像全体の位置(baseOffset)+ w·s」になる。
 * ためて膨らむ2・ふわっと膨らむ・一瞬膨らむ の塗った範囲の広がり r(中心からの距離に対する割合)は、同じ材質のバネで土台(motionSpread)に付いてくる
 * 1次元のばねとして別に持つ。つかむ・平行移動・重さは効かない。
 * 単位は「画像の長辺 = 2」の正規化座標。描画側で (長辺 / 2) を掛けてピクセルへ直す。
 * 積分は半陰的オイラー法、刻みは 1/120 秒固定。
 */
import type { Layer, PhysicsParams, AutoSwing, Vec3 } from '../model/project';
import { motionAnchor, motionSpread, pistonOffset, pistonReach } from './motion';

export const PHYSICS_DT = 1 / 120;
const MAX_DISPLACEMENT = 1.2;
const GRAB_GAIN = 140;
const GRAB_LIMIT = 0.7;
/** 広がりの範囲。-1 より小さいと裏返るので手前で止める */
const SPREAD_MIN = -0.8, SPREAD_MAX = 1.5;
/** 平行移動の速度をならす時定数(秒)。視点は描画フレームごとにしか動かないので、刻みごとのガタつきを消す */
const BASE_SMOOTH = 0.025;

/** s, v: 変位と速度。r, rv: 塗った範囲の広がりとその速さ */
export interface SpringState { s: Vec3; v: Vec3; r: number; rv: number }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function coefficients(p: PhysicsParams): { k: number; m: number; c: number; g: number } {
  return { k: lerp(20, 400, p.hardness), m: lerp(0.3, 3, p.mass), c: lerp(0.5, 12, p.damping), g: p.weight * 6 };
}

interface BaseState { pos: Vec3; vel: Vec3 }
export interface WorldSnapshot { time: number; acc: number; states: [string, SpringState][]; base?: BaseState | null }

export class PhysicsWorld {
  /** 物理の経過時間(秒)。自動揺らしの位相に使う。 */
  time = 0;
  paused = false;
  autoSwing: AutoSwing = { enabled: false, period: 2, strength: 0.5 };
  /** つかみ: ドラッグ開始点からのポインタ移動量(正規化座標) */
  grab: Vec3 | null = null;
  /** つかみの効き具合(レイヤーごと、0〜1) */
  grabGains = new Map<string, number>();
  /**
   * 視点の注視点(ワールド座標)。平行移動すると画像が画面上で逆向きに動くので、
   * 画像を手で動かしたのと同じように揺らす。刻みの前に毎回入れる。
   */
  viewTarget: Vec3 = v3();
  /** 正規化座標の 1 が何ピクセルか(画像の長辺 / 2)。ポップ量を正規化座標へ直すのに使う */
  unitPx = 1;

  private states = new Map<string, SpringState>();
  private acc = 0;
  private anchor = v3();
  private anchorPrev = v3();
  /** 画像の見かけの位置と、ならした速度(正規化座標)。null は「次の刻みで今の位置から測り直す」 */
  private base: BaseState | null = null;
  private drive = v3();
  private piston = [v3(), v3(), v3()];

  state(layerId: string): SpringState {
    let s = this.states.get(layerId);
    if (!s) this.states.set(layerId, (s = { s: v3(), v: v3(), r: 0, rv: 0 }));
    return s;
  }

  displacement(layerId: string): Vec3 { return this.states.get(layerId)?.s ?? v3(); }

  /** 塗った範囲の広がり(中心からの距離に対する割合、ためて膨らむ2・ふわっと膨らむ・一瞬膨らむ) */
  spread(layerId: string): number { return this.states.get(layerId)?.r ?? 0; }

  reset(): void { this.states.clear(); this.acc = 0; this.base = null; }

  /** 視点が飛んだ(視点のリセットなど)ことを知らせる。その動きでは揺らさない */
  cutView(): void { this.base = null; }
  /** 次の刻みで視点を測り直すか(操作の記録に残し、再生でも同じ所で測り直す) */
  get viewCut(): boolean { return this.base === null; }

  /** 実時間で進める(描画フレームから呼ぶ)。1フレームの上限は 0.1 秒。 */
  advance(dt: number, layers: readonly Layer[], beforeStep?: () => void): void {
    if (this.paused) { this.base = null; return; }
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= PHYSICS_DT) { beforeStep?.(); this.step(layers); this.acc -= PHYSICS_DT; }
  }

  /**
   * 画像全体の位置(正規化座標、画像のローカル座標)。揺らし方「ピストン」で動かす。
   * 画像は1枚なので、揺れが有効で表示中のレイヤーのうち、並びで最初(一覧の一番下)のピストンのレイヤーの設定で決める。
   * 自動揺らしが切れているとき・一時停止中は動かさない。t は物理の経過時間(省略時は今)。
   */
  baseOffset(layers: readonly Layer[], t = this.time, out: Vec3 = v3()): Vec3 {
    zero(out);
    const l = this.baseDriver(layers), auto = this.autoSwing;
    return l ? pistonOffset(t, auto.period, auto.strength, out, l.physics.motionParams) : out;
  }

  /** 画像全体の動きを決めるレイヤー(無ければ画像は動かない) */
  baseDriver(layers: readonly Layer[]): Layer | undefined {
    if (this.paused || !this.autoSwing.enabled) return undefined;
    return layers.find(l => l.visible && l.physics.enabled && l.physics.motion === 'piston');
  }

  /** 画像全体がいちばん上がったときのずれ(正規化座標)。3面図の図の大きさを決めるのに使う */
  baseReach(layers: readonly Layer[]): number {
    const l = this.baseDriver(layers);
    return l ? pistonReach(this.autoSwing.strength, l.physics.motionParams) : 0;
  }

  /** 固定刻みで1回進める。 */
  step(layers: readonly Layer[], dt = PHYSICS_DT): void {
    const drive = this.viewAccel(dt), grab = this.grab, auto = this.autoSwing, on = auto.enabled;
    const b = this.anchor, bp = this.anchorPrev;
    // 画像全体の動き(ピストン)の加速度。前後の刻みの位置の2階差分で求めると、画面上の位置
    // (画像の位置 + 変位)が、動かない座標で同じ積分をしたものとちょうど一致する
    const [g0, g1, g2] = this.piston;
    this.baseOffset(layers, this.time - dt, g0); this.baseOffset(layers, this.time, g1); this.baseOffset(layers, this.time + dt, g2);
    drive.x += (g2.x - 2 * g1.x + g0.x) / (dt * dt);
    drive.y += (g2.y - 2 * g1.y + g0.y) / (dt * dt);
    drive.z += (g2.z - 2 * g1.z + g0.z) / (dt * dt);
    for (const layer of layers) {
      const st = this.state(layer.id);
      if (!layer.physics.enabled || !layer.visible) { zero(st.s); zero(st.v); st.r = st.rv = 0; continue; }
      const { k, m, c, g } = coefficients(layer.physics);
      // 土台の位置と速度(速度は1刻み前との差から求める)
      if (on) {
        const pop = layer.pop / this.unitPx;
        motionAnchor(layer.physics.motion, this.time + dt, auto.period, auto.strength, b, pop, layer.physics.motionParams);
        motionAnchor(layer.physics.motion, this.time, auto.period, auto.strength, bp, pop, layer.physics.motionParams);
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
      // 塗った範囲の広がり(土台が動かないレイヤーでは 0 に戻るだけ)
      const motion = layer.physics.motion, mp = layer.physics.motionParams;
      const rb = on ? motionSpread(motion, this.time + dt, auto.period, auto.strength, mp) : 0;
      const rbp = on ? motionSpread(motion, this.time, auto.period, auto.strength, mp) : 0;
      if (rb !== 0 || rbp !== 0 || st.r !== 0 || st.rv !== 0) {
        st.rv += ((-k * (st.r - rb) - c * (st.rv - (rb - rbp) / dt)) / m) * dt;
        st.r = Math.max(SPREAD_MIN, Math.min(SPREAD_MAX, st.r + st.rv * dt));
      }
    }
    this.time += dt;
  }

  /** 平行移動による画像の見かけの加速度。速度をならしてから、1刻みでの変化を加速度にする */
  private viewAccel(dt: number): Vec3 {
    const u = this.unitPx || 1, t = this.viewTarget, a = this.drive;
    // 注視点が右へ動くと、画像は画面上で左へ動いて見える
    const pos = v3(-t.x / u, -t.y / u, -t.z / u);
    const b = this.base;
    if (!b) { this.base = { pos, vel: v3() }; zero(a); return a; }
    const k = 1 - Math.exp(-dt / BASE_SMOOTH);
    const nx = b.vel.x + ((pos.x - b.pos.x) / dt - b.vel.x) * k;
    const ny = b.vel.y + ((pos.y - b.pos.y) / dt - b.vel.y) * k;
    const nz = b.vel.z + ((pos.z - b.pos.z) / dt - b.vel.z) * k;
    a.x = (nx - b.vel.x) / dt; a.y = (ny - b.vel.y) / dt; a.z = (nz - b.vel.z) / dt;
    b.pos = pos; b.vel = v3(nx, ny, nz);
    return a;
  }

  snapshot(): WorldSnapshot {
    const b = this.base;
    return {
      time: this.time, acc: this.acc,
      states: [...this.states].map(([id, s]) => [id, { s: { ...s.s }, v: { ...s.v }, r: s.r, rv: s.rv }]),
      base: b ? { pos: { ...b.pos }, vel: { ...b.vel } } : null,
    };
  }

  restore(snap: WorldSnapshot): void {
    this.time = snap.time; this.acc = snap.acc;
    this.states = new Map(snap.states.map(([id, s]) => [id, { s: { ...s.s }, v: { ...s.v }, r: s.r ?? 0, rv: s.rv ?? 0 }]));
    const b = snap.base;
    this.base = b ? { pos: { ...b.pos }, vel: { ...b.vel } } : null;
  }
}

function zero(v: Vec3): void { v.x = v.y = v.z = 0; }
