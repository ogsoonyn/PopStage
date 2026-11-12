/**
 * コマンド(メニュー・ボタン・ショートカットで使う操作)と、左のツールバー。
 * 左のツールバーは、押すと選んだ状態になる「ツール」と、押すとその場で効く「操作」を見た目で分ける
 * (ツールは塗りつぶしのボタン、操作は見出し付きの枠に入れた枠なしのボタン)。
 * 名前・ショートカット・使える条件はこの表だけに書き、メニューの <kbd>・ボタンのツールチップ・aria-keyshortcuts・
 * ヘルプのショートカット一覧・キーの処理は、すべて表から作る。
 */
import type { App } from '../app';
import { ui } from './ids';
import { toast } from './dom';
import { isTyping } from './input';
import { TOOL_GROUPS, TOOLS, toolDef } from './tools';
import { icon, type IconName } from './icons';

export interface Action {
  /** ツールチップ・ヘルプでの名前 */
  label: string;
  /** ツールチップに足す説明 */
  desc?: string;
  /** ショートカット('Ctrl+Shift+Z' の形。Ctrl は Mac の ⌘ も含む)。最初のものをメニューとツールチップに出す */
  keys?: string[];
  run: () => unknown;
  enabled?: () => boolean;
  /** 膨らませるのプレビュー中も使えるか(表示の切り替えなど、ウェイトにも履歴にも触れないもの) */
  duringPreview?: boolean;
  /** ヘルプでの名前(名前と違うときだけ) */
  helpLabel?: string;
  /** ヘルプで同じ行にまとめる(キーは / でつなぐ) */
  helpRow?: string;
  /** ヘルプに出さない */
  hidden?: boolean;
}

/** 画面の部品のうち、コマンドから開くもの */
export interface ActionDeps {
  openImage: () => unknown;
  openProject: () => unknown;
  openRecent: () => unknown;
  openExport: () => unknown;
  openBlur: () => unknown;
  togglePerf: () => unknown;
}

function defineActions(app: App, d: ActionDeps) {
  const layer = () => !!app.activeLayer;
  const brushStep = (dir: 1 | -1) => () => {
    const el = ui.brushSize, step = Math.max(2, Math.round(app.brush.size * 0.15));
    el.value = String(app.brush.size + dir * step);
    el.dispatchEvent(new Event('input'));
  };
  return {
    // ファイル
    openImage: { label: '画像を開く', keys: ['Ctrl+Shift+O'], run: d.openImage },
    open: { label: 'プロジェクトを開く', keys: ['Ctrl+O'], run: d.openProject },
    recent: { label: '最近開いたファイル', run: d.openRecent },
    save: { label: '保存', keys: ['Ctrl+S'], run: () => app.save(false), enabled: () => !!app.doc },
    saveAs: { label: '名前を付けて保存', keys: ['Ctrl+Shift+S'], run: () => app.save(true), enabled: () => !!app.doc },
    export: { label: '書き出し', keys: ['Ctrl+E'], run: d.openExport, enabled: () => !!app.doc },
    sample: { label: 'サンプルを開く', run: async () => { if (await app.confirmDiscard()) await app.loadSample(); } },
    // 編集
    undo: { label: '元に戻す', keys: ['Ctrl+Z'], run: () => app.history.undo(), enabled: () => app.history.canUndo && !app.stroking },
    redo: { label: 'やり直す', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], run: () => app.history.redo(), enabled: () => app.history.canRedo && !app.stroking },
    smoothAll: { label: '全体をぼかす(ガウス)', desc: '選択中のレイヤー全体にガウスぼかしをかける', run: d.openBlur, enabled: layer },
    normalize: { label: '正規化', desc: '選択中のレイヤーの最大値が100%になるよう全体を拡大', run: () => app.weightOp('正規化', wm => wm.normalize()), enabled: layer },
    invert: { label: '反転', desc: '選択中のレイヤーのウェイトを反転', run: () => app.weightOp('反転', wm => wm.invert()), enabled: layer },
    fromAlpha: { label: 'アルファから生成', run: () => app.fromAlpha(), enabled: layer },
    clearWeights: { label: '全消去', run: () => app.weightOp('全消去', wm => wm.clear()), enabled: layer },
    brushSmaller: { label: 'ブラシを小さく', keys: ['['], run: brushStep(-1), duringPreview: true, helpRow: 'ブラシサイズ(小さく / 大きく)' },
    brushLarger: { label: 'ブラシを大きく', keys: [']'], run: brushStep(1), duringPreview: true, helpRow: 'ブラシサイズ(小さく / 大きく)' },
    // 表示
    toggleOverlay: { label: 'ウェイトの重ね表示', keys: ['W'], run: () => app.setViewOption('overlay', !app.view.overlay), duringPreview: true },
    toggleFade: { label: '画像を薄く', keys: ['Shift+W'], run: () => app.setViewOption('fade', !app.view.fade), duringPreview: true },
    toggleFlat: { label: 'ポップを一時OFF', keys: ['F'], run: () => app.setViewOption('flat', !app.view.flat), duringPreview: true },
    togglePause: { label: '揺れを一時停止', keys: ['P'], run: () => app.setPaused(!app.paused), duringPreview: true },
    toggleMulti: { label: '3面図', keys: ['M'], run: () => app.setViewOption('multi', !app.view.multi), duringPreview: true },
    toggleGrid: { label: 'グリッド', keys: ['Shift+G'], run: () => app.setViewOption('grid', !app.view.grid), duringPreview: true },
    cleanView: {
      label: '編集表示クリア', keys: ['C'], run: () => app.clearEditView(), duringPreview: true, helpLabel: '表示クリア(編集用の表示をまとめて切る)',
      desc: '見栄えを確かめるため、編集用の表示をまとめて切る(ウェイトの重ね表示・画像を薄く・ポップを一時OFF・揺れを一時停止・グリッド)。押すたびに切るだけで、元には戻さない',
    },
    resetView: { label: '視点リセット(正面)', keys: ['Home'], run: () => app.resetView(), duringPreview: true },
    // アニメーション
    toggleRecording: {
      label: '操作の記録', helpLabel: '操作の記録(開始・停止)', keys: ['R'], desc: 'つかむ・揺らす・移動・視点の操作を覚える(最長 60 秒)',
      run: () => app.toggleRecording(), enabled: () => !!app.doc && !app.exporting,
    },
    togglePlay: {
      label: 'ループ再生', helpLabel: 'ループ再生(開始・停止。再生中は画面を触っても止まる)', keys: ['L'], desc: '画面を触ると止まる',
      run: () => app.togglePlay(), enabled: () => !!app.project.take && app.takeState !== 'recording' && !app.exporting,
    },
    clearTake: { label: '記録を消す', desc: '元に戻せる', run: () => app.clearTake(), enabled: () => !!app.project.take && app.takeState !== 'recording' },
    // レイヤー
    addLayer: { label: '新規レイヤー', run: () => app.addLayer(), enabled: () => !!app.doc },
    duplicateLayer: { label: '複製', run: () => app.duplicateLayer(), enabled: layer },
    deleteLayer: { label: '削除', run: () => app.deleteLayer(), enabled: () => (app.doc?.layers.length ?? 0) > 1 },
    layerUp: { label: '上へ', run: () => app.moveLayer(1), enabled: () => app.activeIndex >= 0 && app.activeIndex < (app.doc?.layers.length ?? 0) - 1 },
    layerDown: { label: '下へ', run: () => app.moveLayer(-1), enabled: () => app.activeIndex > 0 },
    // ヘルプ・その他
    help: { label: '操作方法', run: () => ui.helpDialog.showModal(), duringPreview: true },
    about: {
      label: 'PukuPop について', duringPreview: true,
      run: () => { ui.aboutVersion.textContent = `バージョン ${__APP_VERSION__} ・ .pukupop 形式 v1`; ui.aboutDialog.showModal(); },
    },
    togglePerf: { label: 'パフォーマンスのデバッグ表示', keys: ['Ctrl+Shift+Alt+P'], run: d.togglePerf, duringPreview: true, hidden: true },
  } satisfies Record<string, Action>;
}

type CommandName = keyof ReturnType<typeof defineActions>;

/** 左のツールバーの、その場で効く操作のまとまり(よく使うものを、いちばん押しやすい所にも置く) */
const NAV_ACTIONS: readonly { label: string; title: string; items: readonly { cmd: CommandName; icon: IconName; text: string }[] }[] = [
  { label: '表示', title: '表示に効く操作', items: [{ cmd: 'cleanView', icon: 'cleanView', text: '表示クリア' }] },
  {
    label: 'レイヤー', title: '選択中のレイヤーに効く操作',
    items: [{ cmd: 'smoothAll', icon: 'smoothAll', text: '全体ぼかし…' }, { cmd: 'normalize', icon: 'normalize', text: '正規化' }, { cmd: 'invert', icon: 'invert', text: '反転' }],
  },
];

/** キーの押し方を 'Ctrl+Shift+Z' の形にする */
export function keyString(e: KeyboardEvent): string {
  // 日本語入力がオンのときは key が 'Process'、Mac の Option は別の文字になるので、キーの位置(code)から読む
  let k = (e.key === 'Process' || e.altKey) && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.key;
  if (k.length === 1) k = k.toUpperCase();
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', k].filter(Boolean).join('+');
}

const ariaKeys = (keys: string[]) => keys.map(k => k.replace(/\bCtrl\b/g, 'Control')).join(' ');

const TOOL_BTN = 'tool relative btn btn-sm w-[4.5rem] flex-col h-auto py-1 gap-0.5 whitespace-nowrap';
const ACT_BTN = 'nav-act relative btn btn-xs btn-ghost w-[4.5rem] flex-col h-auto py-1 gap-0.5 whitespace-nowrap font-normal';

export function bindActions(app: App, deps: ActionDeps): void {
  const table: Record<string, Action> = defineActions(app, deps);
  for (const t of TOOLS) {
    table[`tool.${t.id}`] = {
      label: t.name ?? t.label, keys: [t.key], desc: t.desc, run: () => app.setTool(t.id),
      helpRow: `ツール(${TOOLS.map(d => d.label).join(' / ')})`,
    };
  }

  const enabled = (name: string): boolean => {
    const a = table[name];
    if (!a) return false;
    if (app.previewingInflate && !a.duringPreview) return false;
    return !a.enabled || a.enabled();
  };
  const run = (name: string): void => {
    if (!enabled(name)) return;
    void Promise.resolve(table[name].run()).catch(e => { console.error(e); toast(String(e instanceof Error ? e.message : e), 'error'); });
  };
  /** ツールチップ: 「名前 (キー補足): 説明」 */
  const tooltip = (a: Action, keyNote = '') => `${a.label}${a.keys ? ` (${a.keys[0]}${keyNote})` : ''}${a.desc ? `: ${a.desc}` : ''}`;

  /* ---------- 左のツールバーを作る(ツール → 区切り → その場で効く操作のまとまり) ---------- */
  const navItems: Node[] = [];
  const divider = () => Object.assign(document.createElement('div'), { className: 'divider my-0' });
  /** アイコン・名前・キーの3段のボタン */
  const navButton = (className: string, ico: IconName, label: string, key = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.innerHTML = `${icon(ico, 'nav-ico')}<span class="nav-label"></span><kbd class="tool-key" aria-hidden="true"></kbd>`;
    b.querySelector('.nav-label')!.textContent = label;
    b.querySelector('.tool-key')!.textContent = key;
    return b;
  };
  for (const group of TOOL_GROUPS) {
    for (const t of group) {
      const b = navButton(TOOL_BTN, t.id, t.label, t.key);
      b.dataset.tool = t.id;
      b.title = tooltip(table[`tool.${t.id}`], t.keyNote);
      b.setAttribute('aria-keyshortcuts', t.key);
      b.addEventListener('click', () => run(`tool.${t.id}`));
      navItems.push(b);
    }
    navItems.push(divider());
  }
  for (const g of NAV_ACTIONS) {
    const box = document.createElement('div');
    box.className = 'nav-group';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', g.title);
    const head = Object.assign(document.createElement('span'), { className: 'nav-group-label', textContent: g.label, title: g.title });
    head.setAttribute('aria-hidden', 'true');
    box.append(head);
    for (const it of g.items) {
      const b = navButton(ACT_BTN, it.icon, it.text);
      b.dataset.cmd = it.cmd; // 結び付け・キーの表記・ツールチップは、下の data-cmd の処理で付ける
      box.append(b);
    }
    navItems.push(box);
  }
  ui.toolNav.replaceChildren(...navItems);

  /* ---------- data-cmd の部品に、キーの表記・ツールチップを付けて結び付ける ---------- */
  const cmdButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-cmd]')];
  for (const b of cmdButtons) {
    const name = b.dataset.cmd!, a = table[name];
    if (!a) throw new Error(`コマンド「${name}」がありません`);
    if (a.keys) {
      b.setAttribute('aria-keyshortcuts', ariaKeys(a.keys));
      const tk = b.querySelector('kbd.tool-key');
      if (tk) tk.textContent = a.keys[0];
      // キーの表記は PC のメニューにだけ付ける(スマホの上のメニューにはキーボードが無い)
      if (b.closest('.menu') && !b.closest('.m-only') && !b.querySelector('kbd')) {
        const kbd = document.createElement('kbd');
        kbd.className = b.querySelector('[data-check]') ? 'kbd kbd-xs' : 'kbd kbd-xs ml-auto';
        kbd.textContent = a.keys[0];
        b.append(kbd);
      }
    }
    // スマホの部品とメニューは文字で分かるので、ツールチップは PC のボタンにだけ付ける
    if (!b.closest('.menu, .m-only')) b.title = tooltip(a);
    const inDropdown = !!b.closest('.dropdown');
    b.addEventListener('click', () => {
      // ドロップダウンの中ならフォーカスを外して閉じる。ほかのボタンはキーボードで続けて押せるようフォーカスを残す
      if (inDropdown) (document.activeElement as HTMLElement | null)?.blur();
      run(name);
    });
  }

  /* ---------- ヘルプのショートカット一覧 ---------- */
  {
    const rows = new Map<string, string[]>();
    for (const a of Object.values(table)) {
      if (!a.keys || a.hidden) continue;
      const row = a.helpRow ?? a.helpLabel ?? a.label;
      rows.set(row, [...(rows.get(row) ?? []), ...a.keys]);
    }
    ui.helpKeys.replaceChildren(...[...rows].flatMap(([label, keys]) => [label, keys.join(' / ')].map(text => Object.assign(document.createElement('span'), { textContent: text }))));
  }

  /* ---------- キー ---------- */
  const byKey = new Map<string, string>();
  for (const [name, a] of Object.entries(table)) for (const k of a.keys ?? []) {
    if (byKey.has(k)) throw new Error(`ショートカット ${k} が「${byKey.get(k)}」と「${name}」で重なっています`);
    byKey.set(k, name);
  }
  /** 画面を覆うダイアログ(確認・書き出しなど)が開いているか。膨らませるのパネルのように画面を覆わないものは含めない */
  const modalOpen = () => !!document.querySelector('dialog[open]:modal');
  window.addEventListener('keydown', e => {
    // 膨らませるのパネルを開いている間も、表示の切り替えなどは効かせる(できない操作は enabled で止める)
    if (isTyping(e) || modalOpen()) return;
    const name = byKey.get(keyString(e));
    if (!name) return;
    e.preventDefault();
    run(name);
  });

  /* ---------- 状態 → 画面 ---------- */
  const undoLabel = document.querySelector('[data-label=undo]')!, redoLabel = document.querySelector('[data-label=redo]')!;
  const checks = [...document.querySelectorAll<HTMLElement>('[data-check]')];
  /** 'status' でも呼ぶ(0.5 秒ごと)ので、変わったときだけ書く */
  const setText = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };
  function refresh(): void {
    for (const b of cmdButtons) { const off = !enabled(b.dataset.cmd!); if (b.disabled !== off) b.disabled = off; }
    setText(undoLabel, app.history.undoLabel ? `(${app.history.undoLabel})` : '');
    setText(redoLabel, app.history.redoLabel ? `(${app.history.redoLabel})` : '');
    const on: Record<string, boolean> = { overlay: app.view.overlay, grid: app.view.grid, fade: app.view.fade, flat: app.view.flat, multi: app.view.multi, pause: app.paused };
    for (const el of checks) setText(el, on[el.dataset.check!] ? '✓' : '');
  }
  app.history.on('change', refresh);
  app.on('active', refresh);
  app.on('view', refresh);
  app.on('inflate', refresh);
  app.on('take', refresh);
  app.on('status', refresh); // 書き出しの始まり・終わりなど、ほかのイベントの無い変化も拾う
  app.store.on('layers', refresh);
  app.store.on('replace', refresh);
  app.store.on('project', ({ keys }) => { if (keys.includes('take')) refresh(); });

  /* ---------- ツールの表示 ---------- */
  const toolButtons = [...ui.toolNav.querySelectorAll<HTMLButtonElement>('.tool')];
  const brushOpts = [...document.querySelectorAll<HTMLElement>('[data-brush-opt]')];
  function refreshTool(): void {
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === app.tool));
    const paint = app.tool === 'brush' || app.tool === 'erase' || app.tool === 'smooth';
    for (const el of brushOpts) el.classList.toggle('opacity-40', !paint);
    ui.toolHint.textContent = toolDef(app.tool).hint;
  }
  app.on('tool', refreshTool);

  refresh(); refreshTool();
}
