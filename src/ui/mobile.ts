/**
 * スマホの画面(幅が狭いとき)。3Dビューを全面に出し、ツールは下のバー、設定は下から引き上げるシートにまとめる。
 * 設定の部品(スライダー・レイヤー一覧・膨らませるのパネルなど)は作り直さず、PC の画面から DOM ごとシートへ移す。
 * イベントの結び付けはそのまま残るので、PC とスマホで同じ処理が動く。幅が戻ったら元の場所へ戻す。
 * ツールは「つかむ・揺らす・移動・視点」を主にし、膨らみ・塗り・消しゴム・ぼかしは「塗って直す」の中に置く。
 */
import type { App, Tool } from '../app';
import { $ } from './dom';
import { setFineLock } from './fine';

/** スマホの配置にする条件。横向きのスマホ(高さが低く、指で触る)も含める */
export const MOBILE_QUERY = '(max-width: 767px), (max-height: 500px) and (pointer: coarse)';

type SheetState = 'closed' | 'half' | 'full';
type Tab = 'motion' | 'tool' | 'layer' | 'view' | 'file';

/** 「塗って直す」の中で使うツール。ブラシの設定を出すのは塗りの3つだけ */
const PAINT_TOOLS: Tool[] = ['inflate', 'brush', 'erase', 'smooth'];
const BRUSH_TOOLS: Tool[] = ['brush', 'erase', 'smooth'];
const TOOL_DESC: Record<Tool, string> = {
  inflate: '画像の上をドラッグして範囲を描くと、ここで高さや断面を決めて適用できます。2本目の指を置くと描くのをやめます。',
  grab: 'つかむ: 画像を引っぱって離すと揺れます。',
  shake: '揺らす: 指で振ると、画像は動かずに揺れだけが出ます。',
  view: '視点: 画像の上でも1本指で回転します。',
  pan: '移動: 1本指で画像を動かします。動かした勢いで揺れます。',
  brush: 'ブラシ: なぞった所を持ち上げます。',
  erase: '消しゴム: なぞった所を元に戻します。',
  smooth: 'ぼかし: 塗りの段差をならします。',
};

export function bindMobileLayout(app: App): { readonly active: boolean } {
  const root = document.documentElement;
  const mq = window.matchMedia(MOBILE_QUERY);
  const sheet = $('mSheet'), grip = $('mGrip'), presets = $('mPresets'), panes = $('mPanes');
  const presetSel = $<HTMLSelectElement>('pPreset'), auto = $<HTMLInputElement>('pAuto');
  const pane = (t: Tab) => panes.querySelector<HTMLElement>(`[data-mpane="${t}"]`)!;

  /* ---------- 部品を移す・戻す ---------- */

  /** 移したものと元の場所。戻すときは逆順に戻す */
  let moved: { el: Element; parent: Node; next: Node | null }[] = [];
  let desktopTool: Tool | null = null;
  const move = (el: Element | null | undefined, to: Element, prepend = false) => {
    if (!el?.parentNode) return;
    moved.push({ el, parent: el.parentNode, next: el.nextSibling });
    if (prepend) to.prepend(el); else to.append(el);
  };
  const sectionOf = (id: string) => $(id).closest('section');

  function enter(): void {
    root.classList.add('mobile');
    move(sectionOf('pPop'), pane('motion'));
    move(sectionOf('pSwing'), pane('motion'));
    move(sectionOf('pAuto'), pane('motion'));
    move(sectionOf('takeRec'), pane('motion'));
    move($('keySection'), pane('motion'));
    move($('inflateDialog'), pane('tool'));
    for (const el of document.querySelectorAll('[data-brush-opt]')) move(el, $('mBrushOpts'));
    move(sectionOf('layerList'), pane('layer'), true);
    move(sectionOf('vOverlay'), pane('view'));
    move(sectionOf('pDensity'), pane('view'));
    move(sectionOf('pFov'), pane('view'));
    // 3面図は縦長の画面では狭すぎるので使わない。塗りのツールのまま来たら、主のツールにする
    if (app.view.multi) app.setViewOption('multi', false);
    desktopTool = app.tool;
    if (PAINT_TOOLS.includes(app.tool)) app.setTool('grab');
    setPaintMode(false);
    renderPresets(); syncAuto(); syncTitle(); syncTool();
    setSheet('closed', false);
  }
  function leave(): void {
    for (const m of moved.reverse()) m.parent.insertBefore(m.el, m.next);
    moved = [];
    root.classList.remove('mobile');
    root.style.removeProperty('--m-sheet');
    setFineLock(false); $('mFine').setAttribute('aria-pressed', 'false');
    // スマホの間に塗りから切り替えていたら、PC で使っていたツールに戻す
    if (desktopTool && PAINT_TOOLS.includes(desktopTool) && !PAINT_TOOLS.includes(app.tool)) app.setTool(desktopTool);
    desktopTool = null;
  }

  /* ---------- シート ---------- */

  let state: SheetState = 'closed';
  const heights = () => {
    const avail = window.innerHeight - $('mTop').offsetHeight - $('mTools').offsetHeight;
    const peek = grip.offsetHeight + presets.offsetHeight + sheet.querySelector<HTMLElement>('.m-tabs')!.offsetHeight;
    return { closed: peek, half: Math.max(peek, Math.round(avail * 0.48)), full: Math.max(peek, avail - 8) };
  };
  /** シートの高さを変える。3Dビューはシートの上に収まるよう縮める(全部のときは半分の高さで止める) */
  function setSheet(s: SheetState, animate = true): void {
    state = s;
    const h = heights();
    sheet.classList.toggle('anim', animate);
    sheet.style.height = `${h[s]}px`;
    sheet.dataset.state = s;
    root.style.setProperty('--m-sheet', `${Math.min(h[s], h.half)}px`);
  }

  {
    let drag: { y: number; h: number; t: number; moved: boolean } | null = null;
    grip.addEventListener('pointerdown', e => {
      drag = { y: e.clientY, h: sheet.offsetHeight, t: performance.now(), moved: false };
      grip.setPointerCapture(e.pointerId);
      sheet.classList.remove('anim');
    });
    grip.addEventListener('pointermove', e => {
      if (!drag) return;
      const dy = e.clientY - drag.y, h = heights();
      if (Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) sheet.style.height = `${Math.max(h.closed, Math.min(h.full, drag.h - dy))}px`;
    });
    const up = (e: PointerEvent) => {
      if (!drag) return;
      const d = drag; drag = null;
      const order: SheetState[] = ['closed', 'half', 'full'];
      if (!d.moved) { setSheet(order[(order.indexOf(state) + 1) % 3]); return; }
      const v = (e.clientY - d.y) / Math.max(1, performance.now() - d.t);
      if (Math.abs(v) > 0.6) { setSheet(order[Math.max(0, Math.min(2, order.indexOf(state) + (v > 0 ? -1 : 1)))]); return; }
      const h = heights(), cur = sheet.offsetHeight;
      setSheet(order.reduce((a, b) => Math.abs(h[a] - cur) <= Math.abs(h[b] - cur) ? a : b));
    };
    grip.addEventListener('pointerup', up);
    // 取り消されたときはタップとみなさず、いちばん近い高さに止める
    grip.addEventListener('pointercancel', () => {
      if (!drag) return;
      drag = null;
      const h = heights(), cur = sheet.offsetHeight, order: SheetState[] = ['closed', 'half', 'full'];
      setSheet(order.reduce((a, b) => Math.abs(h[a] - cur) <= Math.abs(h[b] - cur) ? a : b));
    });
    grip.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSheet(state === 'closed' ? 'half' : state === 'half' ? 'full' : 'closed'); }
    });
  }

  function selectTab(t: Tab): void {
    for (const b of sheet.querySelectorAll<HTMLElement>('[data-mtab]')) b.setAttribute('aria-selected', String(b.dataset.mtab === t));
    for (const p of panes.querySelectorAll<HTMLElement>('[data-mpane]')) p.hidden = p.dataset.mpane !== t;
  }
  for (const b of sheet.querySelectorAll<HTMLElement>('[data-mtab]')) b.addEventListener('click', () => {
    selectTab(b.dataset.mtab as Tab);
    if (state === 'closed') setSheet('half');
  });
  window.addEventListener('resize', () => { if (mq.matches) setSheet(state, false); });

  /* ---------- 揺れのプリセット(右パネルの選択肢をそのまま並べる) ---------- */

  function renderPresets(): void {
    presets.replaceChildren(...[...presetSel.options].filter(o => !o.disabled && !o.hidden).map(o => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = o.textContent; b.dataset.value = o.value;
      b.addEventListener('click', () => {
        if (presetSel.disabled || presetSel.value === o.value) return;
        presetSel.value = o.value;
        presetSel.dispatchEvent(new Event('change', { bubbles: true }));
        syncPresets();
      });
      return b;
    }));
    syncPresets();
  }
  function syncPresets(): void {
    for (const b of presets.querySelectorAll<HTMLButtonElement>('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.value === presetSel.value));
      b.disabled = presetSel.disabled;
    }
  }

  /* ---------- 上のバー ---------- */

  const syncAuto = () => { const b = $('mAuto'); b.setAttribute('aria-pressed', String(auto.checked)); (b as HTMLButtonElement).disabled = auto.disabled; };
  $('mAuto').addEventListener('click', () => auto.click());
  const syncTitle = () => { $('mTitle').textContent = $('docTitle').textContent; };
  new MutationObserver(syncTitle).observe($('docTitle'), { childList: true, characterData: true, subtree: true });

  // 右パネルの表示を更新したあとに、こちらも合わせる(panels.ts が先に登録している)
  for (const ev of ['replace', 'layers', 'layer', 'project', 'document'] as const) app.store.on(ev, () => { syncPresets(); syncAuto(); });
  app.on('active', () => { syncPresets(); syncAuto(); });
  app.on('inflate', () => { syncPresets(); syncAuto(); });

  /* ---------- 微調整 ---------- */

  $('mFine').addEventListener('click', e => {
    const b = e.currentTarget as HTMLElement, on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    setFineLock(on);
  });

  /* ---------- ツールと「塗って直す」 ---------- */

  let lastMain: Tool = 'grab';
  function setPaintMode(on: boolean): void {
    root.dataset.mset = on ? 'paint' : 'main';
    $('mModeBar').hidden = !on;
    if (on && !PAINT_TOOLS.includes(app.tool)) app.setTool('brush');
    if (!on && PAINT_TOOLS.includes(app.tool)) app.setTool(lastMain);
  }
  $('mPaintMode').addEventListener('click', () => { if (app.previewingInflate) return; setPaintMode(true); setSheet('closed'); });
  $('mPaintDone').addEventListener('click', () => { if (!app.previewingInflate) setPaintMode(false); });
  // PC の左のツールボタン(.tool)とは別に結び付ける(同じ data-tool のボタンが2つになるので、クラスは分ける)
  for (const b of document.querySelectorAll<HTMLButtonElement>('#mTools [data-mtool]')) b.addEventListener('click', () => { if (!app.previewingInflate) app.setTool(b.dataset.mtool as Tool); });
  function syncTool(): void {
    // 画像を開いたときなどに、塗りのツールへ切り替わることがある。スマホでは塗りは「塗って直す」の中だけなので戻す
    if (mq.matches && root.dataset.mset !== 'paint' && PAINT_TOOLS.includes(app.tool)) { app.setTool(lastMain); return; }
    for (const b of document.querySelectorAll<HTMLButtonElement>('#mTools [data-mtool]')) b.setAttribute('aria-pressed', String(b.dataset.mtool === app.tool));
    if (!PAINT_TOOLS.includes(app.tool)) lastMain = app.tool;
    $('mToolDesc').textContent = TOOL_DESC[app.tool];
    $('mBrushOpts').hidden = !BRUSH_TOOLS.includes(app.tool);
  }
  app.on('tool', syncTool);

  // 範囲を描いたら、高さや断面を決められるよう「ツール」タブを開く。終わったら元の高さに戻す
  let before: SheetState | null = null;
  app.on('inflate', phase => {
    if (!mq.matches) return;
    if (phase === 'begin') { before = state; selectTab('tool'); if (state === 'closed') setSheet('half'); }
    if (phase === 'end' && before) { setSheet(before); before = null; }
  });

  const apply = () => { if (mq.matches) enter(); else if (root.classList.contains('mobile')) leave(); };
  mq.addEventListener('change', apply);
  apply();
  return { get active() { return mq.matches; } };
}
