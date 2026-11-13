/**
 * キーフレームの枠と経路の重ね表示。各キーフレームの視点で映る範囲を細い枠で、順番を番号で、
 * フレームからフレームへの動き(実際に再生する曲線と同じ keyCurve)を矢印と秒数で、3Dビューの上に SVG で重ねる。
 *
 * - キーフレームの部品が見えているとき(右パネル・スマホのシートで「アニメーション」を開いているとき)だけ出す。
 *   記録中・再生中・書き出し中は出さない。「経路」の切り替えはブラウザに覚える(ファイルには書かない)。
 * - 視点・キーフレーム・画面の大きさが変わったフレームだけ描き直す。
 * - 番号を押すとその視点へ移る。一覧の行にポインタを乗せる・フォーカスすると、そのフレームを強める。
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

/** 同じ所に重なった番号は横に並べる(回転やズームだけのキーフレームは、画面の中心が同じ所に来る) */
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

export function bindKeyPath(app: App): void {
  const host = ui.keyPath, toggle = ui.keyPathShow, section = ui.keySection;
  const svg = el('svg', { class: 'key-path', 'aria-hidden': 'true' }, host);
  toggle.checked = prefs.get<boolean>(PREF) ?? true;
  toggle.addEventListener('change', () => { prefs.set(PREF, toggle.checked); last = ''; });

  // 番号を押すとその視点へ。押した時点で動かす(押したときに一覧のフォーカスが外れて描き直すと、click が届かないため)
  svg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const g = (e.target as Element).closest<SVGGElement>('[data-key]');
    if (!g) return;
    e.preventDefault();
    app.gotoKey(Number(g.dataset.key));
  });
  // 一覧の行に乗せた・フォーカスしたフレームを強める
  let hover = -1;
  const rowIndex = (t: EventTarget | null) => Number((t as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key ?? -1);
  ui.keyList.addEventListener('pointerover', e => { hover = rowIndex(e.target); });
  ui.keyList.addEventListener('pointerleave', () => { hover = -1; });
  ui.keyList.addEventListener('focusin', e => { hover = rowIndex(e.target); });
  ui.keyList.addEventListener('focusout', () => { hover = -1; });

  let last = '';
  function visible(): boolean {
    const keys = app.keyDraft;
    return toggle.checked && keys.length > 0 && !!app.doc && !app.exporting && app.takeState === 'idle'
      && (section.checkVisibility?.() ?? section.offsetParent !== null);
  }

  function update(): void {
    const on = visible();
    if (!on) {
      if (last !== 'off') { host.hidden = true; svg.replaceChildren(); last = 'off'; }
      return;
    }
    const m = app.stage.mainView(), cam = app.project.camera, d = app.doc!;
    const sig = JSON.stringify([m, cam, app.keyDraft, hover, d.position, d.rotation, d.scale]);
    if (sig === last) return;
    last = sig;
    host.hidden = false;
    Object.assign(host.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.w}px`, height: `${m.h}px` });
    svg.setAttribute('viewBox', `0 0 ${m.w} ${m.h}`);
    draw(cam.fov);
  }

  function draw(fov: number): void {
    const keys = app.keyDraft, n = keys.length, stage = app.stage, cam = app.project.camera;
    const current = keys.findIndex(k => sameView(k.view, cam));
    const strong = hover >= 0 ? hover : current;
    svg.replaceChildren();
    const frames = el('g', { class: 'kp-frames' }, svg), paths = el('g', { class: 'kp-paths' }, svg);
    const labels = el('g', { class: 'kp-labels' }, svg), marks = el('g', { class: 'kp-marks' }, svg);
    // 順番は濃さでも表す(最初が濃く、あとほど薄く)
    const alpha = (i: number) => (n < 2 ? 1 : 1 - (i / (n - 1)) * 0.5);

    const views = keys.map(k => stage.projectView({ ...k.view, fov }));
    views.forEach((v, i) => {
      if (!v.corners) return;
      el('polygon', {
        class: `kp-frame${i === strong ? ' strong' : ''}`, points: v.corners.map(c => `${fmt(c.x)},${fmt(c.y)}`).join(' '),
        'stroke-opacity': i === strong ? 1 : alpha(i) * 0.75,
      }, frames);
    });
    const centers = spread(views.map(v => v.center));

    // 経路: 実際の動きの曲線を区間ごとに細かく取り、画面の中心が当たる点を結ぶ
    const curve = n >= 2 ? keyCurve(keys, fov) : null;
    const placed: Pt[] = [];
    if (curve) {
      for (let i = 0; i < n; i++) {
        const t0 = curve.starts[i], dt = keys[i].seconds, pts: Pt[] = [];
        for (let s = 0; s <= SAMPLES; s++) {
          const p = stage.projectView(curve.at(Math.min(t0 + (dt * s) / SAMPLES, curve.total - 1e-6)), false).center;
          if (p) pts.push(p);
        }
        const a = centers[i];
        const back = i === n - 1, cls = `kp-path${back ? ' back' : ''}`, op = String(alpha(i));
        const L = pts.length >= 2 ? lengthOf(pts) : 0;
        let label: Pt | null = null;
        if (L > R * 2 + 14) {
          // 番号の円の内側は描かない。矢じりは着く側の円の手前に置く
          const body = slice(pts, R + 2, L - R - 2);
          el('polyline', { class: cls, points: body.map(p => `${fmt(p.x)},${fmt(p.y)}`).join(' '), 'stroke-opacity': op }, paths);
          const { p, dir } = pointAt(pts, L - R - 2), w = 5, h = 9;
          const bx = p.x - dir.x * h, by = p.y - dir.y * h;
          el('polygon', {
            class: 'kp-arrow', 'fill-opacity': op,
            points: `${fmt(p.x)},${fmt(p.y)} ${fmt(bx - dir.y * w)},${fmt(by + dir.x * w)} ${fmt(bx + dir.y * w)},${fmt(by - dir.x * w)}`,
          }, paths);
          // 秒数は区間の真ん中に置く。番号やほかの秒数と重なるなら、区間の中でずらし、だめなら横へ逃がす
          const free = (q: Pt) => centers.every(c => !c || Math.hypot(c.x - q.x, c.y - q.y) > R + 14)
            && placed.every(o => Math.abs(o.x - q.x) > 36 || Math.abs(o.y - q.y) > 17);
          for (const f of [0.5, 0.38, 0.62, 0.28, 0.72]) { const q = pointAt(pts, L * f).p; if (free(q)) { label = q; break; } }
          if (!label) { const { p: q, dir: dd } = pointAt(pts, L / 2); label = { x: q.x - dd.y * 16, y: q.y + dd.x * 16 }; }
        } else if (a) {
          // 経路がほとんど動かない(回転・ズームだけ)ときは、秒数を番号の下に出す
          label = { x: a.x, y: a.y + R + 10 };
        }
        if (label) {
          placed.push(label);
          const g = el('g', { class: `kp-sec${back ? ' back' : ''}`, transform: `translate(${fmt(label.x)},${fmt(label.y)})` }, labels);
          el('rect', { x: -17, y: -8, width: 34, height: 16, rx: 8 }, g);
          el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g).textContent = sec(keys[i].seconds);
        }
      }
    }

    centers.forEach((c, i) => {
      if (!c) return;
      const g = el('g', { class: `kp-mark${i === strong ? ' strong' : ''}`, 'data-key': i, transform: `translate(${fmt(c.x)},${fmt(c.y)})` }, marks);
      el('title', {}, g).textContent = `${i + 1}: この視点を見る`;
      el('circle', { r: R }, g);
      el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central' }, g).textContent = String(i + 1);
    });
  }

  app.on('frame', update);
  app.on('take', () => { last = ''; update(); });
  app.on('view', () => { last = ''; });
  // タブの切り替えは frame で拾う(見えているかを毎フレーム確かめる)
  update();
}
