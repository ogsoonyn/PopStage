/**
 * 操作の記録(テイク)。「記録」を押してから止めるまでの、つかむ・揺らす・移動・視点の操作を物理の刻みごとに覚え、
 * 画面上でループ再生したり、書き出したり、.pukupop に保存したりする。
 *
 * - 1件は物理の1刻み(1/120 秒)。中身は書き出しの「直前の操作を再生」と同じ RecordSample(物理の控えは持たない)。
 * - 止めたときに finalizeTake で整える: 初めの何もしていない所を詰め、終わりの何もしていない所は揺れがおさまる分だけ残し、
 *   長さを書き出しのコマにそろえ、終わりを初めの位置へなめらかに寄せて、ループの継ぎ目で視点が飛ばないようにする。
 * - DOM に依存しない。
 */
import { LIMITS, type CameraState, type Vec3 } from '../model/project';
import { PHYSICS_DT } from './world';
import type { RecordSample } from './recorder';

export interface Take { readonly samples: readonly RecordSample[] }

/** 記録できる最長の長さ(秒) */
export const TAKE_MAX_SECONDS = 60;
/** これより短い記録は捨てる(秒) */
export const TAKE_MIN_SECONDS = 0.5;
/** 終わりの何もしていない所を残す長さ(秒)。揺れがおさまるまでの分 */
const TAIL_IDLE_SECONDS = 1;
/** 終わりを初めの位置へ寄せる時間(秒、全体の 1/3 まで) */
const BLEND_SECONDS = 0.5;
/** 長さをこの刻み数の倍数にそろえる(30fps・60fps の書き出しでちょうどのコマ数になるように) */
export const TAKE_STEP_MULTIPLE = 4;

export const takeSeconds = (t: Take | null | undefined): number => (t ? t.samples.length * PHYSICS_DT : 0);

const sameVec = (a: Vec3 | null | undefined, b: Vec3 | null | undefined) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z);
const sameCam = (a: CameraState, b: CameraState) =>
  a.yaw === b.yaw && a.pitch === b.pitch && a.zoom === b.zoom && sameVec(a.target, b.target);
/** a から b へ何も変わっていない(つかんでおらず、視点も注視点も同じ) */
function idle(a: RecordSample, b: RecordSample): boolean {
  return !a.grab && !b.grab && !b.viewCut && sameCam(a.camera, b.camera) && sameVec(a.viewTarget ?? a.camera.target, b.viewTarget ?? b.camera.target);
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) });

/** 記録したままの並びを、ループ再生できる形に整える。短すぎれば null */
export function finalizeTake(raw: readonly RecordSample[]): Take | null {
  let start = 0, end = raw.length;
  // 初めの何もしていない所を詰める(最後の1件は残す)
  while (start + 1 < end && idle(raw[start], raw[start + 1])) start++;
  // 終わりの何もしていない所は、揺れがおさまる分だけ残す
  let last = end - 1;
  while (last > start && idle(raw[last - 1], raw[last])) last--;
  end = Math.min(end, last + 1 + Math.round(TAIL_IDLE_SECONDS / PHYSICS_DT));
  let n = Math.min(end - start, Math.round(TAKE_MAX_SECONDS / PHYSICS_DT));
  n -= n % TAKE_STEP_MULTIPLE;
  if (n * PHYSICS_DT < TAKE_MIN_SECONDS - 1e-9) return null;
  const samples: RecordSample[] = raw.slice(start, start + n).map(s => ({
    grab: s.grab ? { ...s.grab } : null,
    grabGains: s.grabGains.map(([id, g]) => [id, g] as [string, number]),
    camera: { ...s.camera, target: { ...s.camera.target } },
    viewTarget: { ...(s.viewTarget ?? s.camera.target) },
    ...(s.viewCut ? { viewCut: true } : {}),
  }));
  // 最初の1件で視点を測り直す(再生の始まりと継ぎ目で、前の動きを持ち込まない)は再生側で行う。ここでは継ぎ目をならす
  blendTail(samples);
  return { samples };
}

/** 終わりを初めの視点・注視点・つかみへ寄せる */
function blendTail(s: RecordSample[]): void {
  const n = s.length, first = s[0];
  const F = Math.min(Math.round(BLEND_SECONDS / PHYSICS_DT), Math.floor(n / 3));
  if (F < 2) return;
  // 回転は1周ぶん違っても同じ向きなので、最後の向きにいちばん近い同じ向きへ寄せる(巻き戻して回らないように)
  const lastYaw = s[n - 1].camera.yaw, TAU = Math.PI * 2;
  const yawTo = first.camera.yaw + TAU * Math.round((lastYaw - first.camera.yaw) / TAU);
  for (let j = 0; j < F; j++) {
    const smp = s[n - F + j], t = smooth((j + 1) / (F + 1)), c = smp.camera;
    smp.camera = {
      ...c, yaw: lerp(c.yaw, yawTo, t), pitch: lerp(c.pitch, first.camera.pitch, t), zoom: lerp(c.zoom, first.camera.zoom, t),
      target: lerpVec(c.target, first.camera.target, t),
    };
    smp.viewTarget = lerpVec(smp.viewTarget!, first.viewTarget!, t);
    // つかみは両方つかんでいるときだけ寄せる(片方だけなら、継ぎ目で離す・つかむになる)
    if (smp.grab && first.grab) smp.grab = lerpVec(smp.grab, first.grab, t);
  }
}

/* ---------- 保存の形(.pukupop の motion/take.json) ---------- */

/**
 * 1件を数の並びにする: [yaw, pitch, zoom, tx, ty, tz, vx, vy, vz, gx, gy, gz, gains, cut]
 * つかんでいないときは gx・gy・gz が null。gains はつかみの効き具合の組(gainSets)の番号(無ければ -1)。cut は 1 で視点を測り直す。
 * 画角は記録しない(再生ではその時のプロジェクトの画角を使う)。
 */
export interface TakeJson { version: 1; dt: number; gainSets: [string, number][][]; samples: (number | null)[][] }

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function takeToJson(take: Take): TakeJson {
  const sets: [string, number][][] = [], keys = new Map<string, number>();
  const samples = take.samples.map(s => {
    let gi = -1;
    if (s.grabGains.length) {
      const key = JSON.stringify(s.grabGains);
      gi = keys.get(key) ?? -1;
      if (gi < 0) { gi = sets.length; sets.push(s.grabGains.map(([id, g]) => [id, r6(g)])); keys.set(key, gi); }
    }
    const c = s.camera, v = s.viewTarget ?? c.target, g = s.grab;
    return [
      r6(c.yaw), r6(c.pitch), r6(c.zoom), r6(c.target.x), r6(c.target.y), r6(c.target.z), r6(v.x), r6(v.y), r6(v.z),
      g ? r6(g.x) : null, g ? r6(g.y) : null, g ? r6(g.z) : null, gi, s.viewCut ? 1 : 0,
    ];
  });
  return { version: 1, dt: PHYSICS_DT, gainSets: sets, samples };
}

const BIG = 1e6;
const fin = (v: unknown, min: number, max: number, def = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;

/** 読み込み。形が違う・壊れているものは null(記録なしとして開く)。fov はその時のプロジェクトの画角 */
export function takeFromJson(v: unknown, fov: number): Take | null {
  if (!v || typeof v !== 'object') return null;
  const j = v as Partial<TakeJson>;
  if (j.version !== 1 || !Array.isArray(j.samples)) return null;
  if (typeof j.dt === 'number' && Math.abs(j.dt - PHYSICS_DT) > 1e-9) return null;
  const max = Math.round(TAKE_MAX_SECONDS / PHYSICS_DT);
  if (j.samples.length > max) return null;
  // つかみの効き具合の組。組の数はサンプル数まで、1組はレイヤーの上限の枚数まで。同じ組はサンプル間で共有する(書き換えない)
  const sets: [string, number][][] = Array.isArray(j.gainSets)
    ? j.gainSets.slice(0, j.samples.length).map(set => {
      const seen = new Set<string>(), out: [string, number][] = [];
      for (const e of Array.isArray(set) ? set : []) {
        if (out.length >= LIMITS.maxLayers) break;
        if (!Array.isArray(e) || typeof e[0] !== 'string' || e[0].length > 64 || seen.has(e[0])) continue;
        seen.add(e[0]); out.push([e[0], fin(e[1], 0, 1, 1)]);
      }
      return out;
    })
    : [];
  const samples: RecordSample[] = [];
  for (const a of j.samples) {
    if (!Array.isArray(a) || a.length < 14) return null;
    const n = (i: number, min = -BIG, max = BIG) => fin(a[i], min, max);
    const target = { x: n(3), y: n(4), z: n(5) };
    const grab = typeof a[9] === 'number' ? { x: n(9, -10, 10), y: n(10, -10, 10), z: n(11, -10, 10) } : null;
    const gi = a[12];
    samples.push({
      camera: { fov, yaw: n(0, -1e3, 1e3), pitch: n(1, -1.5, 1.5), zoom: n(2, 0.05, 20) || 1, target },
      viewTarget: { x: n(6), y: n(7), z: n(8) },
      grab,
      grabGains: typeof gi === 'number' && Number.isInteger(gi) && sets[gi] ? sets[gi] : [],
      ...(a[13] === 1 ? { viewCut: true } : {}),
    });
  }
  // 長さは書き出しのコマにそろえる(手で直したファイルなどで端数があれば切り捨てる)
  samples.length -= samples.length % TAKE_STEP_MULTIPLE;
  return samples.length * PHYSICS_DT >= TAKE_MIN_SECONDS - 1e-9 ? { samples } : null;
}
