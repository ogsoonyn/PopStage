/**
 * キーフレームのゴーストと経路の重ね表示。書き出す動画は画面がすべてなので、「各キーフレームで画面に絵がどう映るか」を基準にする。
 *
 * - ゴースト: 各キーフレームの視点で描いた絵を、主ビューと同じ大きさ・縦横比で半透明に重ねる(寄ったキーは大きく、引いたキーは小さく見える)。
 *   今の視点には関わらないので、視点を動かしても動かない(作画の参考資料のように見られる)。
 * - 絵の輪郭・番号: 各キーフレームで画面に映る絵の外枠と、絵の中心に番号。番号を押して離すとその視点へ移る。
 * - 経路: 実際に再生する曲線(keyCurve)で、絵の中心が画面の上を動く道筋を矢印で、各区間の「次まで」の秒数を添える。
 * - 出すのはキーフレームの部品が見えているとき(右パネル・スマホのシートでアニメーションを開いているとき)だけ。
 *   記録中・再生中・書き出し中は出さない。「経路」の切り替えはブラウザに覚える(ファイルには書かない)。
 * - ゴーストはキーフレーム・画面の大きさ・ドキュメントが変わったときだけ描き直す(少し待ってまとめる)。
 */
import type { App } from '../app';
import { keyCurve, type ViewKey } from '../physics/take';
import { prefs } from '../storage/prefs';
import { ui } from './ids';

type Pt = { x: number; y: number };

const NS = 'http://www.w3.org/2000/svg';
/** 番号の円の半径(px) */
const R = 10;
/** 1区間の経路を何点で描くか */
const SAMPLES = 32;
/** ゴーストを描く大きさの上限(長い辺の px)。描き直しを軽くするため、主ビューより粗くてよい */
const GHOST_MAX = 640;
/** 変わってからゴーストを描き直すまで待つ時間(ms)。塗っている間や秒数の入力中に何度も描かないように */
const GHOST_WAIT = 200;
/** ゴーストの濃さ(ふつう・強めたもの) */
const GHOST_ALPHA = 0.3, GHOST_STRONG = 0.7;
const PREF = 'keyPath';

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
const sameView = (a: ViewKey, b: ViewKey) => near(a.yaw, b.yaw, 1e-4) && near(a.pitch, b.pitch, 1e-4) && near(a.zoom, b.zoom, 1e-4)
  && near(a.target.x, b.target.x, 1e-3) && near(a.target.y, b.target.y, 1e-3) && near(a.target.z, b.target.z, 1e-3);
const fmt = (v: number) => v.toFixed(1);
const sec = (v: number) => `${v.toFixed(1)}秒`;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

/** 折れ線の長さ */
function lengthOf(pts: readonly Pt[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** 折れ線の始まりから長さ s の点と、そこでの向き(単位ベクトル) */
function pointAt(pts: readonly Pt[], s: number): { p: Pt; dir: Pt } {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = Math.hypot(b.x - a.x, b.y - a.y);
    if (l > 0 && acc + l >= s) {
      const t = (s - acc) / l;
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
    }
    acc += l;
  }
  const a = pts.at(-2) ?? pts[0], b = pts.at(-1)!, l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { p: { ...b }, dir: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
}

/** 折れ線の始まりから s0〜s1 の部分 */
function slice(pts: readonly Pt[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [pointAt(pts, s0).p];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc > s0 && acc < s1) out.push(pts[i]);
  }
  out.push(pointAt(pts, s1).p);
  return out;
}

/** 同じ所に重なった番号は横に並べる(回転やズームだけのキーフレームは、絵の中心が同じ所に来る) */
function spread(points: readonly (Pt | null)[]): (Pt | null)[] {
  const out = points.map(p => (p ? { ...p } : null));
  const done = new Set<number>();
  points.forEach((p, i) => {
    if (!p || done.has(i)) return;
    const group = points.flatMap((q, j) => (q && !done.has(j) && Math.hypot(q.x - p.x, q.y - p.y) < R * 1.6 ? [j] : []));
    group.forEach(j => done.add(j));
    if (group.length < 2) return;
    group.forEach((j, k) => { out[j] = { x: p.x + (k - (group.length - 1) / 2) * (R * 2 + 3), y: p.y }; });
  });
  return out;
}

/** 画面の上の形(主ビューの左上からの px)。キーフレーム・画角・主ビューの大きさ・画像の置き方が同じなら使い回す */
interface Shape { outlines: (Pt[] | null)[]; centers: (Pt | null)[]; paths: Pt[][]; seconds: number[] }

export function bindKeyPath(app: App): void {
  const host = ui.keyPath, toggle = ui.keyPathShow, section = ui.keySection;
  const ghosts = document.createElement('div');
  ghosts.className = 'kp-ghosts';
  host.append(ghosts);
  const svg = el('svg', { class: 'key-path', 'aria-hidden': 'true' }, host);
  toggle.checked = prefs.get<boolean>(PREF) ?? true;
  toggle.addEventListener('change', () => { prefs.set(PREF, toggle.checked); });

  // 番号を押して(ずらさずに)離すとその視点へ。押したときに一覧のフォーカスが外れて描き直しても届くよう、押した番号を覚えておく
  let press: { key: number; x: number; y: number; id: number } | null = null;
  svg.addEventListener('pointerdown', e => {
    const g = (e.target as Element).closest<SVGGElement>('[data-key]');
    if (!g || e.button !== 0) return;
    e.preventDefault();
    press = { key: Number(g.dataset.key), x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  window.addEventListener('pointerup', e => {
    const p = press;
    if (!p || p.id !== e.pointerId) return;
    press = null;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) app.gotoKey(p.key);
  });
  window.addEventListener('pointercancel', () => { press = null; });
  // 番号の上のホイールは3Dビューのズームに回す
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    ui.view.dispatchEvent(new WheelEvent('wheel', e));
  }, { passive: false });

  // 一覧の行に乗せた・フォーカスしたフレームを強める
  let hover = -1;
  const rowIndex = (t: EventTarget | null) => Number((t as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key ?? -1);
  ui.keyList.addEventListener('pointerover', e => { hover = rowIndex(e.target); });
  ui.keyList.addEventListener('pointerleave', () => { hover = -1; });
  ui.keyList.addEventListener('focusin', e => { hover = rowIndex(e.target); });
  ui.keyList.addEventListener('focusout', () => { hover = -1; });

  // ドキュメントの中身(塗り・ポップ量など)が変わったらゴーストを描き直す
  let docRev = 0, lastRev = 0;
  app.store.on('change', () => { docRev++; });
  app.store.on('replace', () => { docRev++; });

  function visible(): boolean {
    if (!toggle.checked || !app.keyDraft.length || !app.doc || !app.stage.hasDocument || app.exporting || app.takeState !== 'idle') return false;
    // スマホでシートを畳んでいるときは、キーフレームの部品は見えていない
    if (document.documentElement.classList.contains('mobile') && ui.mSheet.dataset.state === 'closed') return false;
    return section.checkVisibility?.() ?? section.offsetParent !== null;
  }

  /** 絵の輪郭・中心・経路を画面の上で求める(経路は実際の動きの曲線を区間ごとに細かく取る) */
  function buildShape(fov: number): Shape {
    const stage = app.stage, { w, h } = stage.imageDims, curve = keyCurve(app.keyDraft, fov);
    const keys = curve?.keys ?? app.keyDraft.slice(0, 1);
    const corners = [{ x: -w / 2, y: h / 2 }, { x: w / 2, y: h / 2 }, { x: w / 2, y: -h / 2 }, { x: -w / 2, y: -h / 2 }], center = [{ x: 0, y: 0 }];
    const outlines = keys.map(k => { const p = stage.projectLocal({ ...k.view, fov }, corners); return p.every(q => q) ? p as Pt[] : null; });
    const centers = keys.map(k => stage.projectLocal({ ...k.view, fov }, center)[0]);
    const paths: Pt[][] = [];
    if (curve) {
      keys.forEach((k, i) => {
        const pts: Pt[] = [];
        for (let s = 0; s <= SAMPLES; s++) {
          const p = stage.projectLocal(curve.at(Math.min(curve.starts[i] + (k.seconds * s) / SAMPLES, curve.total - 1e-6)), center)[0];
          if (p) pts.push(p);
        }
        paths.push(pts);
      });
    }
    return { outlines, centers, paths, seconds: keys.map(k => k.seconds) };
  }

  /** 各キーフレームの視点で絵を描き、ゴーストの画像にする */
  function renderGhosts(): void {
    const m = app.stage.mainView(), fov = app.project.camera.fov;
    const k = Math.min(1, GHOST_MAX / Math.max(m.w, m.h)), w = Math.max(1, Math.round(m.w * k)), h = Math.max(1, Math.round(m.h * k));
    app.flushWeights();
    const list = app.keyDraft.map((key, i) => {
      const px = app.stage.renderFrame(w, h, { ...key.view, fov }, null);
      const c = document.createElement('canvas');
      c.width = w; c.height = h; c.className = 'kp-ghost'; c.dataset.key = String(i);
      c.getContext('2d')!.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
      return c;
    });
    ghosts.replaceChildren(...list);
    // 書き出し用の描画でカメラが変わったので、当たり判定(pick)のために今の視点へ戻す
    app.stage.applyCamera(app.project.camera);
  }

  let shown = false, ghostSig = '', ghostDirty = 0, svgSig = '', shape: Shape | null = null;
  function hide(): void {
    if (!shown) return;
    shown = false; host.hidden = true;
    ghosts.replaceChildren(); svg.replaceChildren();
    ghostSig = ''; svgSig = '';
  }

  function update(): void {
    if (!visible()) { hide(); return; }
    const m = app.stage.mainView(), c = app.project.camera, d = app.doc!;
    if (hover >= app.keyDraft.length) hover = -1;
    // 画面の上の形とゴーストは今の視点に関わらない。強めるもの(一覧の行・今の視点と同じキー)だけ視点で変わる
    const gs = JSON.stringify([app.keyDraft, c.fov, m.w, m.h, d.position, d.rotation, d.scale, app.stage.imageDims]);
    const now = performance.now();
    if (gs !== ghostSig || !shown) {
      // 形はすぐ描き直し、ゴーストは変わり終わるのを少し待ってから描く(初めて出すときはすぐ描く)
      ghostSig = gs; shape = buildShape(c.fov); svgSig = '';
      if (shown) ghostDirty = now;
      else { shown = true; host.hidden = false; renderGhosts(); ghostDirty = 0; lastRev = docRev; }
      Object.assign(host.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
      svg.setAttribute('viewBox', `0 0 ${m.w} ${m.h}`);
    }
    if (docRev !== lastRev && !ghostDirty) { ghostDirty = now; lastRev = docRev; }
    if (ghostDirty && now - ghostDirty >= GHOST_WAIT) { ghostDirty = 0; lastRev = docRev; renderGhosts(); svgSig = ''; }
    const current = app.keyDraft.findIndex(k => sameView(k.view, c));
    const strong = hover >= 0 ? hover : current;
    const ss = `${strong}`;
    if (ss === svgSig) return;
    svgSig = ss;
    for (const g of ghosts.children) (g as HTMLElement).style.opacity = String(Number((g as HTMLElement).dataset.key) === strong ? GHOST_STRONG : GHOST_ALPHA);
    draw(shape!, strong);
  }

  const line = (pts: readonly Pt[]) => pts.map(p => `${fmt(p.x)},${fmt(p.y)}`).join(' ');

  function draw(sh: Shape, strong: number): void {
    const n = sh.centers.length;
    svg.replaceChildren();
    const outlines = el('g', { class: 'kp-outlines' }, svg), paths = el('g', { class: 'kp-paths' }, svg);
    const labels = el('g', { class: 'kp-labels' }, svg), marks = el('g', { class: 'kp-marks' }, svg);
    // 順番は濃さでも表す(最初が濃く、あとほど薄く)
    const alpha = (i: number) => (n < 2 ? 1 : 1 - (i / (n - 1)) * 0.5);
    // 線・矢じりは、暗い太い線を下に敷いて、画像の明暗どちらの上でも見えるようにする
    const stroke = (tag: 'polygon' | 'polyline', attrs: Record<string, string | number>, parent: Element) => {
      el(tag, { ...attrs, class: `${attrs.class} kp-halo` }, parent);
      el(tag, attrs, parent);
    };

    sh.outlines.forEach((o, i) => {
      if (!o) return;
      stroke('polygon', { class: `kp-outline${i === strong ? ' strong' : ''}`, points: line(o), 'stroke-opacity': i === strong ? 1 : alpha(i) * 0.75 }, outlines);
    });
    const centers = spread(sh.centers);

    const placed: Pt[] = [];
    sh.paths.forEach((pts, i) => {
      const a = centers[i];
      const back = i === n - 1, cls = `kp-path${back ? ' back' : ''}`, op = String(alpha(i));
      const L = pts.length >= 2 ? lengthOf(pts) : 0;
      let label: Pt | null = null;
      if (L > R * 2 + 14) {
        // 番号の円の内側は描かない。矢じりは着く側の円の手前に置く
        stroke('polyline', { class: cls, points: line(slice(pts, R + 2, L - R - 2)), 'stroke-opacity': op }, paths);
        const { p, dir } = pointAt(pts, L - R - 2), w = 5, h = 9;
        const bx = p.x - dir.x * h, by = p.y - dir.y * h;
        stroke('polygon', {
          class: 'kp-arrow', 'fill-opacity': op,
          points: `${fmt(p.x)},${fmt(p.y)} ${fmt(bx - dir.y * w)},${fmt(by + dir.x * w)} ${fmt(bx + dir.y * w)},${fmt(by - dir.x * w)}`,
        }, paths);
        // 秒数は区間の真ん中に置く。番号やほかの秒数と重なるなら、区間の中でずらし、だめなら横へ逃がす
        const free = (q: Pt) => centers.every(c => !c || Math.hypot(c.x - q.x, c.y - q.y) > R + 14)
          && placed.every(o => Math.abs(o.x - q.x) > 36 || Math.abs(o.y - q.y) > 17);
        for (const f of [0.5, 0.38, 0.62, 0.28, 0.72]) { const q = pointAt(pts, L * f).p; if (free(q)) { label = q; break; } }
        if (!label) { const { p: q, dir: dd } = pointAt(pts, L / 2); label = { x: q.x - dd.y * 16, y: q.y + dd.x * 16 }; }
      } else if (a) {
        // 絵の中心がほとんど動かない(回転・ズームだけ)ときは、秒数を番号の下に出す
        label = { x: a.x, y: a.y + R + 10 };
      }
      if (label) {
        placed.push(label);
        const g = el('g', { class: `kp-sec${back ? ' back' : ''}`, transform: `translate(${fmt(label.x)},${fmt(label.y)})` }, labels);
        el('rect', { x: -17, y: -8, width: 34, height: 16, rx: 8 }, g);
        el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g).textContent = sec(sh.seconds[i]);
      }
    });

    centers.forEach((c, i) => {
      if (!c) return;
      const g = el('g', { class: `kp-mark${i === strong ? ' strong' : ''}`, 'data-key': i, transform: `translate(${fmt(c.x)},${fmt(c.y)})` }, marks);
      el('title', {}, g).textContent = `${i + 1}: この視点を見る`;
      el('circle', { r: R }, g);
      el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g).textContent = String(i + 1);
    });
  }

  // 描くのは frame(描画の直後)だけにする。見えなくなったときは、ほかの知らせでもすぐ消す(書き出し中は frame が出ない)
  app.on('frame', update);
  const hideIfNeeded = () => { if (!visible()) hide(); };
  app.on('take', () => { hover = -1; hideIfNeeded(); });
  app.on('status', hideIfNeeded);
  toggle.addEventListener('change', hideIfNeeded);
}
