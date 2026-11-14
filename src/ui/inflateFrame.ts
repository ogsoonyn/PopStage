/**
 * 「膨らませる」のプレビュー中に、範囲の枠とハンドルを3Dビュー(主ビュー)に SVG で重ねる。
 * 枠は膨らむ前の平らな画像の面に描くので、視点を回すと台形に見える。楕円のときは楕円の輪郭も重ねる。
 *   辺・角の8点: 大きさ(反対側を止める。Shift で縦横比を保つ、Alt で中心を止める)
 *   枠の中: 移動 / 枠の上の丸: 回す(Shift で 15° ごと) / 枠の外: 範囲を描き直す(ui/input.ts)
 * ポインタの操作は ui/input.ts が受け、どこを掴んだかをここの hitFrame で決める。重ね表示自体はポインタを通す。
 * 枠が画面上で小さいときは、辺のハンドルを隠し、角の当たりも小さくして、枠の中を掴んで動かせるようにする。
 */
import type { App } from '../app';
import { HANDLES, areaPoint, type Handle } from '../paint/areaEdit';
import { ui } from './ids';

type Pt = { x: number; y: number };

const NS = 'http://www.w3.org/2000/svg';
/** ハンドルの当たりの半径(px)。マウス・ペンと指 */
const HIT = 10, HIT_TOUCH = 22;
/** 回すハンドルを枠の上の辺から離す距離(px) */
const ROT_GAP = 28;
/** 枠の短い辺がこれより短い(px)ときは、辺のハンドルを出さない。指では当たりが大きいので、中を掴む所が残るよう長めにする */
const EDGE_MIN = 40, EDGE_MIN_TOUCH = HIT_TOUCH * 3;
/** 楕円の輪郭を何点で描くか */
const ELLIPSE_SAMPLES = 64;

export type FrameHit = { kind: 'resize'; handle: Handle } | { kind: 'move' } | { kind: 'rotate' };

interface Geometry {
  /** 枠の四隅(右上・右下・左下・左上)。主ビューの左上からの CSS ピクセル */
  corners: Pt[];
  handles: { h: Handle; p: Pt }[];
  /** 上の辺の中点と、回すハンドル */
  top: Pt; rot: Pt;
  center: Pt;
  /** 枠の短い辺の画面上の長さ */
  minSide: number;
  /** 楕円の輪郭(矩形なら null) */
  ellipse: Pt[] | null;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * 回す丸を付ける辺(1: 形の上、-1: 形の下)。回して ±90° を越えると角度は反対側へ回り込み、形の上下が入れ替わるので、
 * そのときは付ける辺も入れ替えて、丸が画面上で跳ばないようにする
 */
let rotSide: 1 | -1 = 1, lastAngle = 0;
function trackAngle(angle: number): void {
  if (Math.abs(angle - lastAngle) > 90) rotSide = rotSide === 1 ? -1 : 1;
  lastAngle = angle;
}

/** 今の範囲の枠を、主ビューの画面の位置で求める。プレビュー中でない・画面に収まらない(カメラの後ろ)ときは null */
function geometry(app: App, withEllipse = true): Geometry | null {
  const s = app.inflateState; if (!s || !app.stage.hasDocument) return null;
  const a = s.area, ang = s.settings.angle;
  trackAngle(ang);
  const at = (su: number, sv: number) => { const q = areaPoint(a, ang, su, sv); return app.stage.imageToMainScreen(q.x, q.y); };
  const handles: { h: Handle; p: Pt }[] = [];
  for (const h of HANDLES) { const p = at(h.su, h.sv); if (!p) return null; handles.push({ h, p }); }
  const center = at(0, 0); if (!center) return null;
  const corner = (su: number, sv: number) => handles.find(e => e.h.su === su && e.h.sv === sv)!.p;
  const corners = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)];
  const top = corner(0, rotSide);
  // 回すハンドルは、中心から上の辺の中点へ向かう向きに離して置く。枠が潰れて向きが決まらないときは、形の「上」を少し先で測る
  let dx = top.x - center.x, dy = top.y - center.y, l = Math.hypot(dx, dy);
  if (l < 1) { const far = at(0, rotSide * (1 + 1000 / Math.max(1, a.h))); if (far) { dx = far.x - center.x; dy = far.y - center.y; l = Math.hypot(dx, dy); } }
  if (l < 1e-6) { dx = 0; dy = -1; l = 1; }
  const rot = { x: top.x + dx / l * ROT_GAP, y: top.y + dy / l * ROT_GAP };
  const minSide = Math.min(dist(corners[0], corners[1]), dist(corners[1], corners[2]));
  let ellipse: Pt[] | null = null;
  if (withEllipse && s.settings.shape === 'ellipse') {
    ellipse = [];
    for (let i = 0; i < ELLIPSE_SAMPLES; i++) {
      const t = (i / ELLIPSE_SAMPLES) * Math.PI * 2, p = at(Math.cos(t), Math.sin(t));
      if (!p) { ellipse = null; break; }
      ellipse.push(p);
    }
  }
  return { corners, handles, top, rot, center, minSide, ellipse };
}

/** 点が(凸の)四角形の中にあるか */
function insideQuad(q: readonly Pt[], p: Pt): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c === 0) continue;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** 辺のハンドルを出すか(枠が画面上で十分大きいとき) */
const edgesShown = (g: Geometry, touch: boolean) => g.minSide >= (touch ? EDGE_MIN_TOUCH : EDGE_MIN);

/**
 * 画面の点(clientX/Y)で掴むものを決める。回すハンドル > いちばん近い大きさのハンドル > 枠の中(移動)。
 * 当たるものが無ければ null(範囲の描き直しになる)
 */
export function hitFrame(app: App, clientX: number, clientY: number, touch: boolean): FrameHit | null {
  const g = geometry(app, false); if (!g) return null;
  const r = ui.view.getBoundingClientRect(), m = app.stage.mainView();
  const p = { x: clientX - r.left - m.x, y: clientY - r.top - m.y };
  const R = touch ? HIT_TOUCH : HIT;
  if (dist(p, g.rot) <= R) return { kind: 'rotate' };
  // 枠が小さいときは、角の当たりを小さくして、中を掴めるようにする
  const edges = edgesShown(g, touch), cornerR = edges ? R : Math.max(5, Math.min(R, g.minSide / 3));
  let best: { h: Handle; d: number } | null = null;
  for (const { h, p: q } of g.handles) {
    const isCorner = h.su !== 0 && h.sv !== 0;
    if (!isCorner && !edges) continue;
    const d = dist(p, q);
    if (d <= (isCorner ? cornerR : R) && (!best || d < best.d)) best = { h, d };
  }
  if (best) return { kind: 'resize', handle: best.h };
  if (insideQuad(g.corners, p)) return { kind: 'move' };
  return null;
}

/** 掴むものに合わせたカーソル。大きさのハンドルは、画面上で中心から見た向きの両矢印にする */
export function frameCursor(app: App, hit: FrameHit, dragging: boolean): string {
  if (hit.kind === 'move') return 'move';
  if (hit.kind === 'rotate') return dragging ? 'grabbing' : 'grab';
  const g = geometry(app, false);
  const q = g?.handles.find(e => e.h.su === hit.handle.su && e.h.sv === hit.handle.sv)?.p;
  if (!g || !q) return 'move';
  const deg = ((Math.atan2(q.y - g.center.y, q.x - g.center.x) * 180 / Math.PI) % 180 + 180) % 180;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4];
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}

export function bindInflateFrame(app: App): void {
  const host = ui.inflateFrame;
  const svg = el('svg', { class: 'inflate-frame', 'aria-hidden': 'true' }, host);
  let last = '';

  function update(): void {
    const g = app.exporting ? null : geometry(app);
    if (!g) {
      if (last !== 'off') { host.hidden = true; svg.replaceChildren(); last = 'off'; }
      return;
    }
    const m = app.stage.mainView();
    const f = (v: number) => v.toFixed(1), line = (pts: readonly Pt[]) => pts.map(p => `${f(p.x)},${f(p.y)}`).join(' ');
    // ハンドルは膨らみツールのときだけ出す(ほかのツールでは掴めないので、枠の線だけにする)。スマホでは辺のハンドルを出す境目を指に合わせる
    const handles = app.tool === 'inflate', touch = document.documentElement.classList.contains('mobile');
    const sig = `${m.x},${m.y},${m.w},${m.h}|${line(g.corners)}|${f(g.rot.x)},${f(g.rot.y)}|${g.ellipse ? 1 : 0}|${handles}|${touch}`;
    if (sig === last) return;
    last = sig;
    host.hidden = false;
    Object.assign(host.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
    svg.setAttribute('viewBox', `0 0 ${m.w} ${m.h}`);
    svg.replaceChildren();
    // 線は暗い太い線を下に敷いて、画像の明暗どちらの上でも見えるようにする
    const stroke = (tag: 'polygon' | 'polyline' | 'line', attrs: Record<string, string | number>) => {
      el(tag, { ...attrs, class: `${attrs.class} if-halo` }, svg);
      el(tag, attrs, svg);
    };
    if (g.ellipse) stroke('polygon', { class: 'if-shape', points: line(g.ellipse) });
    stroke('polygon', { class: 'if-box', points: line(g.corners) });
    if (!handles) return;
    stroke('line', { class: 'if-stem', x1: f(g.top.x), y1: f(g.top.y), x2: f(g.rot.x), y2: f(g.rot.y) });
    const edges = edgesShown(g, touch);
    for (const { h, p } of g.handles) {
      if (!edges && (h.su === 0 || h.sv === 0)) continue;
      el('rect', { class: 'if-handle', x: f(p.x - 4.5), y: f(p.y - 4.5), width: 9, height: 9, rx: 1.5 }, svg);
    }
    el('circle', { class: 'if-handle if-rot', cx: f(g.rot.x), cy: f(g.rot.y), r: 5.5 }, svg);
  }

  app.on('frame', update);
  app.on('inflate', phase => { if (phase === 'begin') { rotSide = 1; lastAngle = app.inflateState?.settings.angle ?? 0; } update(); });
  app.on('tool', update);
}
