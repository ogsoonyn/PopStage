/**
 * 範囲(楕円・矩形)を指定して一括で膨らませる処理(DOM に依存しない)。
 * 範囲の「縁からの深さ」(縁が 0、いちばん奥が 1)を、なだらかさで割ってから断面の形に通し、
 * 頂上のウェイト(level)を掛けて元のウェイトと重ねる。楕円をなだらかさ 100%・ドームにすると回転楕円体になる。
 */
import type { WeightMap, Rect } from '../model/weightmap';

export type InflateProfile = 'dome' | 'cushion' | 'cone';
export type InflateBlend = 'max' | 'add' | 'replace';

/** 中心と半径はウェイトマップのピクセル単位(行 0 が上) */
export interface InflateShape { kind: 'ellipse' | 'rect'; cx: number; cy: number; rx: number; ry: number }

export interface InflateParams {
  /** 頂上のウェイト 0〜1(高さ ÷ ポップ量) */
  level: number;
  /** 0 で縁が切り立った平らな台、1 で中心までずっと傾く */
  softness: number;
  profile: InflateProfile;
  blend: InflateBlend;
}

/** 断面の形。t は縁から奥への位置 0〜1、戻り値は高さ 0〜1 */
export function profileAt(t: number, p: InflateProfile): number {
  t = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (p === 'dome') return Math.sqrt(1 - (1 - t) * (1 - t)); // 断面が円弧(縁で切り立ち、頂上は丸い)
  if (p === 'cushion') return t * t * (3 - 2 * t);           // 縁も頂上もなめらか
  return t;
}

/** なだらかさ 0 でも縁がギザギザにならないよう、最低 1.5px の傾きを残す */
const ramp = (depth: number, softness: number, radiusPx: number) => depth / Math.max(softness, Math.min(1, 1.5 / Math.max(0.5, radiusPx)));

function blend(base: number, v: number, mode: InflateBlend): number {
  const n = v * 255;
  const out = mode === 'max' ? Math.max(base, n) : mode === 'add' ? base + n : n;
  return Math.round(out < 0 ? 0 : out > 255 ? 255 : out);
}

/** 図形の中の、縁からの深さ 0〜1(外は 0 以下)。x, y はピクセルの中心 */
export function shapeDepth(s: InflateShape, x: number, y: number): number {
  const dx = x - s.cx, dy = y - s.cy;
  if (s.kind === 'ellipse') return 1 - Math.hypot(dx / s.rx, dy / s.ry);
  // 矩形は縁からの距離を短い方の半径で割る(長い辺に沿って稜線ができる寄棟屋根の形)
  return Math.min(s.rx - Math.abs(dx), s.ry - Math.abs(dy)) / Math.min(s.rx, s.ry);
}

function shapeBounds(s: InflateShape, w: number, h: number): Rect | null {
  const x0 = Math.max(0, Math.floor(s.cx - s.rx)), y0 = Math.max(0, Math.floor(s.cy - s.ry));
  const x1 = Math.min(w, Math.ceil(s.cx + s.rx)), y1 = Math.min(h, Math.ceil(s.cy + s.ry));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * base(同じ大きさの元のウェイト)に図形の膨らみを重ねて wm へ書く。図形の外接矩形の外には触れない。
 * 戻り値は書いた矩形。
 */
export function inflateShape(wm: WeightMap, base: Uint8Array, s: InflateShape, p: InflateParams): Rect | null {
  if (s.rx < 0.5 || s.ry < 0.5) return null;
  const r = shapeBounds(s, wm.width, wm.height); if (!r) return null;
  const W = wm.width, d = wm.data, R = Math.min(s.rx, s.ry);
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const depth = shapeDepth(s, x + 0.5, y + 0.5);
    if (depth <= 0) continue;
    const i = y * W + x;
    d[i] = blend(base[i], p.level * profileAt(ramp(depth, p.softness, R), p.profile), p.blend);
  }
  return r;
}

/* ---------- 高さがポップ量を超えるとき ---------- */

/** 頂上を height(px)にするのに要るポップ量。今のポップ量で足りればそのまま */
export function popForHeight(height: number, pop: number): number {
  return height > pop ? Math.ceil(height) : pop;
}

/**
 * ポップ量を oldPop から newPop に上げても、今の塗りの高さ(ウェイト × ポップ量)が変わらないよう、
 * ウェイトを oldPop / newPop 倍した配列を返す。oldPop が 0 のときは(高さの手がかりが無いので)そのまま写す。
 */
export function rescaleForPop(src: Uint8Array, oldPop: number, newPop: number): Uint8Array {
  if (oldPop <= 0 || newPop <= 0 || oldPop === newPop) return src.slice();
  const k = oldPop / newPop, out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = Math.round(src[i] * k);
  return out;
}
