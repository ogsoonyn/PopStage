/**
 * 1回のストローク(押してから離すまで)の処理。DOM に依存しない。
 * - 前回位置からブラシサイズの 25% 間隔でスタンプを補間する
 * - 触れたタイルだけ作業用の浮動小数バッファへ取り込み、終了時に前後差分を返す
 */
import { WeightMap, TILE, type Rect } from '../model/weightmap';
import type { TileDiff } from '../commands/commands';

export type PaintMode = 'brush' | 'erase' | 'smooth';

export interface BrushSettings {
  size: number;     // 直径(ウェイトマップのピクセル単位)
  strength: number; // 0〜1
  hardness: number; // 0〜1
}

/** 1スタンプの最大加算量(強さ 100% のとき、ウェイト 0〜1 に対して) */
const STAMP_GAIN = 0.35;
const SMOOTH_R = 3;

export function falloff(d: number, hardness: number): number {
  if (d >= 1) return 0;
  if (d <= hardness) return 1;
  const t = (d - hardness) / (1 - hardness);
  return 1 - t * t * (3 - 2 * t);
}

export class Stroke {
  private work: Float32Array;
  private befores = new Map<number, Uint8Array>();
  private last: { x: number; y: number } | null = null;
  private dirty: Rect | null = null;

  constructor(readonly map: WeightMap, readonly mode: PaintMode, readonly settings: BrushSettings) {
    this.work = new Float32Array(map.width * map.height);
  }

  /**
   * x, y はウェイトマップのピクセル座標。sizeScale / strengthScale は筆圧による倍率。
   * 戻り値はこの呼び出しで変わった矩形。
   */
  addPoint(x: number, y: number, sizeScale = 1, strengthScale = 1): Rect | null {
    const r = Math.max(0.5, (this.settings.size * sizeScale) / 2);
    const a = this.settings.strength * strengthScale;
    this.dirty = null;
    if (!this.last) {
      this.stamp(x, y, r, a);
      this.last = { x, y };
      return this.dirty;
    }
    const from = this.last, step = Math.max(r * 0.5, 0.5); // 直径の 25%
    const dist = Math.hypot(x - from.x, y - from.y), n = Math.floor(dist / step);
    if (n === 0) return null;
    const ux = (x - from.x) / dist, uy = (y - from.y) / dist;
    for (let i = 1; i <= n; i++) this.stamp(from.x + ux * step * i, from.y + uy * step * i, r, a);
    this.last = { x: from.x + ux * step * n, y: from.y + uy * step * n };
    return this.dirty;
  }

  /** ストロークを終えて、変わったタイルの前後差分を返す。 */
  finish(): TileDiff[] {
    const out: TileDiff[] = [];
    const tx = this.map.tilesX;
    for (const [i, before] of this.befores) {
      const r = this.map.tileRect(i % tx, Math.floor(i / tx));
      const after = this.map.readRect(r);
      let same = true;
      for (let k = 0; k < after.length; k++) if (after[k] !== before[k]) { same = false; break; }
      if (!same) out.push({ tx: i % tx, ty: Math.floor(i / tx), before, after });
    }
    this.befores.clear();
    return out;
  }

  private ensureTiles(r: Rect): void {
    const m = this.map, tx0 = Math.floor(r.x / TILE), ty0 = Math.floor(r.y / TILE);
    const tx1 = Math.floor((r.x + r.w - 1) / TILE), ty1 = Math.floor((r.y + r.h - 1) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const i = ty * m.tilesX + tx;
      if (this.befores.has(i)) continue;
      const tr = m.tileRect(tx, ty);
      this.befores.set(i, m.readRect(tr));
      for (let y = tr.y; y < tr.y + tr.h; y++) for (let x = tr.x; x < tr.x + tr.w; x++) this.work[y * m.width + x] = m.data[y * m.width + x];
    }
  }

  private clip(cx: number, cy: number, r: number, margin = 0): Rect | null {
    const x0 = Math.max(0, Math.floor(cx - r - margin)), y0 = Math.max(0, Math.floor(cy - r - margin));
    const x1 = Math.min(this.map.width, Math.ceil(cx + r + margin)), y1 = Math.min(this.map.height, Math.ceil(cy + r + margin));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  }

  private stamp(cx: number, cy: number, r: number, strength: number): void {
    const rect = this.clip(cx, cy, r, this.mode === 'smooth' ? SMOOTH_R : 0);
    if (!rect) return;
    this.ensureTiles(rect);
    const W = this.map.width, work = this.work, h = this.settings.hardness;
    if (this.mode === 'smooth') {
      this.smooth(rect, cx, cy, r, strength);
    } else {
      const amount = 255 * STAMP_GAIN * strength * (this.mode === 'erase' ? -1 : 1);
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        const dy = (y + 0.5 - cy) / r;
        for (let x = rect.x; x < rect.x + rect.w; x++) {
          const f = falloff(Math.hypot((x + 0.5 - cx) / r, dy), h);
          if (f > 0) { const i = y * W + x; work[i] = Math.max(0, Math.min(255, work[i] + amount * f)); }
        }
      }
    }
    // 作業バッファから正本へ書き戻す
    const d = this.map.data;
    for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) {
      const i = y * W + x; d[i] = Math.round(work[i]);
    }
    this.dirty = this.dirty ? union(this.dirty, rect) : rect;
  }

  /** 周囲と平均化して段差をならす(分離可能なボックスぼかしとブラシ形状で混ぜる)。 */
  private smooth(rect: Rect, cx: number, cy: number, r: number, strength: number): void {
    const W = this.map.width, w = rect.w, hgt = rect.h, work = this.work;
    const src = new Float32Array(w * hgt), tmp = new Float32Array(w * hgt);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) src[y * w + x] = work[(rect.y + y) * W + rect.x + x];
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -SMOOTH_R; k <= SMOOTH_R; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += src[y * w + xx]; n++; } }
      tmp[y * w + x] = s / n;
    }
    const mix = Math.min(1, strength * 2.5);
    for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
      const f = falloff(Math.hypot((rect.x + x + 0.5 - cx) / r, (rect.y + y + 0.5 - cy) / r), this.settings.hardness) * mix;
      if (f <= 0) continue;
      let s = 0, n = 0;
      for (let k = -SMOOTH_R; k <= SMOOTH_R; k++) { const yy = y + k; if (yy >= 0 && yy < hgt) { s += tmp[yy * w + x]; n++; } }
      const i = (rect.y + y) * W + rect.x + x;
      work[i] = src[y * w + x] * (1 - f) + (s / n) * f;
    }
  }
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
