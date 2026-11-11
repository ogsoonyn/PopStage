import './style.css';
import { App, type Tool } from './app';
import { bindStageInput, isTyping } from './ui/input';
import { bindPanels } from './ui/panels';
import { bindExportDialog } from './ui/exportDialog';
import { bindBlurDialog } from './ui/blurDialog';
import { bindInflateDialog } from './ui/inflateDialog';
import { bindMultiView } from './ui/multiView';
import { bindRecentDialog } from './ui/recentDialog';
import { bindMobileLayout } from './ui/mobile';
import { $, ask, toast, retryWithClick } from './ui/dom';
import { autosave } from './storage/autosave';
import { prefs, persistControls } from './storage/prefs';
import { isImageFile, isProjectFile } from './ui/imageio';

const canvas = $<HTMLCanvasElement>('view');
let app: App;
try {
  app = new App(canvas);
} catch (e) {
  document.getElementById('stage')!.innerHTML = '<p class="p-6 text-error">WebGL2 を初期化できませんでした。Chrome / Edge / Firefox の最新版でお試しください。</p>';
  throw e;
}
const params = new URLSearchParams(location.search);
const e2e = params.has('e2e');
/** E2E で自動保存の復元を試すときだけ、?e2e&restore で復元の確認を出す */
const checkRestore = !e2e || params.has('restore');
(window as unknown as { popstage: App }).popstage = app;

/** パフォーマンスのデバッグ表示(?debug か Ctrl+Shift+Alt+P)。使うときだけ読み込む */
const togglePerf = () => void import('./debug/perfOverlay').then(m => m.togglePerfOverlay(app)).catch(e => console.error(e));
if (params.has('debug')) togglePerf();

bindStageInput(app, canvas);
const multiView = bindMultiView(app, canvas);
bindPanels(app);

/* ---------- 設定をブラウザに覚える(ファイルには書かない) ---------- */
const byId = <T extends HTMLElement>(...ids: string[]) => ids.map(id => $<T>(id));
persistControls('brush', byId<HTMLInputElement | HTMLSelectElement>('brushSize', 'brushStrength', 'brushHardness', 'brushPressure'));
// 「ポップを一時OFF」「揺れを一時停止」は一時的な切り替えなので覚えない
{
  // キー・メニュー・チェックボックスのどれで切り替えても覚えるよう、アプリの表示の状態から覚える
  const saved = prefs.get<Record<string, unknown>>('view') ?? {};
  for (const k of ['overlay', 'grid', 'fade', 'multi'] as const) if (typeof saved[k] === 'boolean') app.view[k] = saved[k] as boolean;
  app.syncView();
  app.on('view', () => { const v = app.view; prefs.set('view', { overlay: v.overlay, grid: v.grid, fade: v.fade, multi: v.multi }); });
}
{
  const TOOLS: Tool[] = ['brush', 'erase', 'smooth', 'inflate', 'grab', 'shake', 'view'];
  const t = prefs.get<string>('tool');
  if (t && (TOOLS as string[]).includes(t)) app.setTool(t as Tool);
  app.on('tool', t => prefs.set('tool', t));
}
// 背景・自動揺らし・画角は、変えたら「新しい画像を開いたときの既定」として覚える
app.store.on('project', ({ keys }) => {
  if (!keys.some(k => k === 'background' || k === 'autoSwing' || k === 'camera')) return;
  const p = app.project;
  prefs.set('newImage', { background: p.background, autoSwing: { ...p.autoSwing }, fov: p.camera.fov });
});
const exportDialog = bindExportDialog(app);
const blurDialog = bindBlurDialog(app);
const recentDialog = bindRecentDialog(app);
bindInflateDialog(app);
// スマホの配置。右パネルなどの部品を移すので、ほかの部品を結び付けたあとに呼ぶ
bindMobileLayout(app);

/* ---------- ファイルを開く ---------- */

const fileImage = $<HTMLInputElement>('fileImage'), fileProject = $<HTMLInputElement>('fileProject');
fileImage.addEventListener('change', () => { const f = fileImage.files?.[0]; fileImage.value = ''; if (f) void app.openFile(f); });
fileProject.addEventListener('change', () => { const f = fileProject.files?.[0]; fileProject.value = ''; if (f) void app.openFile(f); });

const IMAGE_ACCEPT = { 'image/*': ['.png', '.jpg', '.jpeg', '.webp'] };

/** Chrome 系はファイルの場所(ハンドル)ごと受け取る。最近開いたファイルから開き直すのに使う */
async function pickAndOpen(types: FilePickerAcceptType[], fallback: HTMLInputElement): Promise<void> {
  if (window.showOpenFilePicker) {
    try {
      const r = await retryWithClick(() => window.showOpenFilePicker!({ types }), 'ファイルを選ぶ…');
      if (!r) return;
      const [h] = r;
      await app.openFile(await h.getFile(), h);
    } catch (e) { if ((e as DOMException).name !== 'AbortError') toast(String(e), 'error'); }
  } else fallback.click();
}
const openProjectDialog = () => pickAndOpen([{ description: 'PopStage プロジェクト / 画像', accept: { 'application/zip': ['.popstage'], ...IMAGE_ACCEPT } }], fileProject);
const openImageDialog = () => pickAndOpen([{ description: '画像', accept: IMAGE_ACCEPT }], fileImage);

/* ---------- コマンド(メニュー・ボタン・ショートカット共通) ---------- */

const commands: Record<string, { run: () => unknown; enabled?: () => boolean }> = {
  openImage: { run: openImageDialog },
  open: { run: openProjectDialog },
  recent: { run: () => recentDialog.open() },
  save: { run: () => app.save(false), enabled: () => !!app.doc },
  saveAs: { run: () => app.save(true), enabled: () => !!app.doc },
  export: { run: () => exportDialog.open(), enabled: () => !!app.doc },
  sample: { run: async () => { if (await app.confirmDiscard()) await app.loadSample(); } },
  undo: { run: () => app.history.undo(), enabled: () => app.history.canUndo && !app.stroking },
  redo: { run: () => app.history.redo(), enabled: () => app.history.canRedo && !app.stroking },
  smoothAll: { run: () => blurDialog.open(), enabled: () => !!app.activeLayer },
  normalize: { run: () => app.weightOp('正規化', wm => wm.normalize()), enabled: () => !!app.activeLayer },
  invert: { run: () => app.weightOp('反転', wm => wm.invert()), enabled: () => !!app.activeLayer },
  fromAlpha: { run: () => app.fromAlpha(), enabled: () => !!app.activeLayer },
  clearWeights: { run: () => app.weightOp('全消去', wm => wm.clear()), enabled: () => !!app.activeLayer },
  toggleOverlay: { run: () => app.setViewOption('overlay', !app.view.overlay) },
  toggleGrid: { run: () => app.setViewOption('grid', !app.view.grid) },
  toggleFade: { run: () => app.setViewOption('fade', !app.view.fade) },
  toggleFlat: { run: () => app.setViewOption('flat', !app.view.flat) },
  togglePause: { run: () => app.setPaused(!app.paused) },
  cleanView: { run: () => app.clearEditView() },
  toggleMulti: { run: () => app.setViewOption('multi', !app.view.multi) },
  resetView: { run: () => app.resetView() },
  addLayer: { run: () => app.addLayer(), enabled: () => !!app.doc },
  duplicateLayer: { run: () => app.duplicateLayer(), enabled: () => !!app.activeLayer },
  deleteLayer: { run: () => app.deleteLayer(), enabled: () => (app.doc?.layers.length ?? 0) > 1 },
  layerUp: { run: () => app.moveLayer(1), enabled: () => app.activeIndex >= 0 && app.activeIndex < (app.doc?.layers.length ?? 0) - 1 },
  layerDown: { run: () => app.moveLayer(-1), enabled: () => app.activeIndex > 0 },
  help: { run: () => $<HTMLDialogElement>('helpDialog').showModal() },
  about: { run: () => { $('aboutVersion').textContent = `バージョン ${__APP_VERSION__} ・ .popstage 形式 v1`; $<HTMLDialogElement>('aboutDialog').showModal(); } },
};

/** 膨らませるのプレビュー中は、表示の切り替え以外はできない(プレビュー中のウェイトを元に戻すなどしないように) */
const SAFE_WHILE_INFLATING = new Set(['toggleOverlay', 'toggleGrid', 'toggleFade', 'toggleFlat', 'togglePause', 'toggleMulti', 'cleanView', 'resetView', 'help', 'about']);
const commandEnabled = (name: string): boolean => {
  const c = commands[name];
  if (!c) return false;
  if (app.previewingInflate && !SAFE_WHILE_INFLATING.has(name)) return false;
  return !c.enabled || c.enabled();
};

function runCommand(name: string): void {
  const c = commands[name];
  if (!c || !commandEnabled(name)) return;
  void Promise.resolve(c.run()).catch(e => { console.error(e); toast(String(e instanceof Error ? e.message : e), 'error'); });
}

document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach(b => b.addEventListener('click', () => {
  // ドロップダウンを閉じる
  (document.activeElement as HTMLElement | null)?.blur();
  runCommand(b.dataset.cmd!);
}));

function refreshCommands(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach(b => {
    b.disabled = !commandEnabled(b.dataset.cmd!);
  });
  document.querySelector('[data-label=undo]')!.textContent = app.history.undoLabel ? `(${app.history.undoLabel})` : '';
  document.querySelector('[data-label=redo]')!.textContent = app.history.redoLabel ? `(${app.history.redoLabel})` : '';
  const checks: Record<string, boolean> = { overlay: app.view.overlay, grid: app.view.grid, fade: app.view.fade, flat: app.view.flat, multi: app.view.multi, pause: app.paused };
  document.querySelectorAll<HTMLElement>('[data-check]').forEach(el => { el.textContent = checks[el.dataset.check!] ? '✓' : ''; });
}
app.history.on('change', refreshCommands);
app.on('active', refreshCommands);
app.on('view', refreshCommands);
app.store.on('layers', refreshCommands);
app.store.on('replace', refreshCommands);
app.on('inflate', refreshCommands);

/* ---------- ツール ---------- */

const TOOL_HINTS: Record<Tool, string> = {
  brush: 'ドラッグで塗る(Alt で消しゴム)/ 右ドラッグで回転 / ホイールでズーム',
  erase: 'ドラッグでウェイトを消す',
  smooth: 'ドラッグで段差をならす',
  inflate: 'ドラッグした範囲を一括で膨らませる(Shift で正円・正方形)/ 高さや断面は下のパネルで調整',
  grab: 'ドラッグで引っ張って離すと揺れる',
  shake: 'ドラッグで画像を振る(カメラが付いてくるので画像は動かず、揺れだけが見える)/ 中ドラッグで画像を動かす / 右ドラッグで回転',
  view: 'ドラッグで視点を回す / Space+ドラッグで平行移動',
};
function refreshTool(): void {
  document.querySelectorAll<HTMLButtonElement>('.tool').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === app.tool)));
  const paint = app.tool === 'brush' || app.tool === 'erase' || app.tool === 'smooth';
  document.querySelectorAll<HTMLElement>('[data-brush-opt]').forEach(el => el.classList.toggle('opacity-40', !paint));
  $('toolHint').textContent = TOOL_HINTS[app.tool];
}
// 膨らませるのプレビュー中はツールを切り替えない(キーと同じ)
document.querySelectorAll<HTMLButtonElement>('.tool').forEach(b => b.addEventListener('click', () => { if (!app.previewingInflate) app.setTool(b.dataset.tool as Tool); }));
app.on('tool', refreshTool);

/* ---------- ショートカット ---------- */

const anyDialogOpen = () => !!document.querySelector('dialog[open]');

/** 画面を覆うダイアログ(確認・書き出しなど)が開いているか。膨らませるのパネルのように画面を覆わないものは含めない */
const modalOpen = () => !!document.querySelector('dialog[open]:modal');

window.addEventListener('keydown', e => {
  // 膨らませるのパネルを開いている間も、表示の切り替えなどは効かせる(できない操作は commandEnabled で止める)
  if (isTyping(e) || modalOpen()) return;
  // 日本語入力がオンのときは key が 'Process' になるので、キーの位置(code)から読む
  const key = e.key === 'Process' && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.key;
  const k = key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
  const hit = (name: string) => { e.preventDefault(); runCommand(name); };
  if (ctrl && e.shiftKey && e.altKey && e.code === 'KeyP') { e.preventDefault(); togglePerf(); return; }
  if (ctrl) {
    if (k === 'z') return hit(e.shiftKey ? 'redo' : 'undo');
    if (k === 'y') return hit('redo');
    if (k === 's') return hit(e.shiftKey ? 'saveAs' : 'save');
    if (k === 'o') return hit(e.shiftKey ? 'openImage' : 'open');
    if (k === 'e') return hit('export');
    return;
  }
  if (e.altKey) return;
  if (e.shiftKey && k === 'g') return hit('toggleGrid');
  if (e.shiftKey && k === 'w') return hit('toggleFade');
  if (e.key === 'Home') return hit('resetView');
  const tools: Record<string, Tool> = { b: 'brush', e: 'erase', s: 'smooth', i: 'inflate', g: 'grab', y: 'shake', v: 'view' };
  if (!e.shiftKey && tools[k]) { e.preventDefault(); if (!app.previewingInflate) app.setTool(tools[k]); return; }
  if (k === 'w') return hit('toggleOverlay');
  if (k === 'f') return hit('toggleFlat');
  if (k === 'p') return hit('togglePause');
  if (k === 'm') return hit('toggleMulti');
  if (k === 'c') return hit('cleanView');
  if (e.key === '[' || e.key === ']') {
    const el = $<HTMLInputElement>('brushSize'), step = Math.max(2, Math.round(app.brush.size * 0.15));
    el.value = String(app.brush.size + (e.key === ']' ? step : -step));
    el.dispatchEvent(new Event('input'));
    e.preventDefault();
  }
});

/* ---------- ドラッグ&ドロップ ---------- */

const wrap = $('stageWrap'), dropHint = $('dropHint');
let dragDepth = 0;
const showDrop = (on: boolean) => { dropHint.classList.toggle('hidden', !on); dropHint.classList.toggle('flex', on); };
window.addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; showDrop(true); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) showDrop(false); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; showDrop(false);
  const files = [...(e.dataTransfer?.files ?? [])], f = files.find(f => isImageFile(f) || isProjectFile(f));
  // ダイアログ(確認・書き出しなど)の表示中は、裏で別のファイルを開かない
  if (f && anyDialogOpen()) { toast('ダイアログを閉じてから、もう一度ドロップしてください。', 'warning'); return; }
  // Chrome 系はドロップでもファイルの場所を受け取れる(イベントの中で呼ぶ必要がある)
  const items = [...(e.dataTransfer?.items ?? [])].filter(i => i.kind === 'file');
  const handle = f ? items[files.indexOf(f)]?.getAsFileSystemHandle?.() : undefined;
  if (f) void (async () => {
    let h: FileSystemFileHandle | undefined;
    try { const x = await handle; if (x?.kind === 'file') h = x as FileSystemFileHandle; } catch { /* 場所が取れなければコピーで覚える */ }
    await app.openFile(f, h);
  })();
  else if (e.dataTransfer?.files.length) toast('PNG / JPEG / WebP の画像か、.popstage ファイルをドロップしてください。', 'warning');
});
void wrap;

/* ---------- ステータスバーとタイトル ---------- */

function refreshStatus(): void {
  const d = app.doc;
  $('sFps').textContent = `${app.fps} fps`;
  $('sVerts').textContent = `${app.stage.vertexCount.toLocaleString()} 頂点`;
  $('sZoom').textContent = `ズーム ${Math.round(100 / app.project.camera.zoom)}%`;
  $('sImage').textContent = d ? `${d.image.width}×${d.image.height}px・ウェイト ${d.layers[0]?.weights.width ?? 0}×${d.layers[0]?.weights.height ?? 0}` : '-';
  if (!app.exporting) $('sRec').textContent = [app.view.flat && 'ポップOFF', app.paused && '揺れ一時停止中'].filter(Boolean).join('・');
  $('sSave').textContent = app.autosaveError ? `自動保存に失敗しました(${app.autosaveError})。こまめに保存してください。` : app.dirty ? (app.lastAutosave ? `未保存の変更あり(${app.lastAutosave.toLocaleTimeString()} に自動保存)` : '未保存の変更あり') : app.lastSaved ? `保存済み ${app.lastSaved.toLocaleTimeString()}` : '';
}
function refreshTitle(): void {
  const name = app.fileName ?? app.doc?.name ?? '';
  $('docTitle').textContent = `${app.dirty ? '● ' : ''}${name}`;
  document.title = `${app.dirty ? '* ' : ''}${name ? name + ' - ' : ''}PopStage`;
  refreshStatus();
}
app.on('status', refreshStatus);
app.on('view', refreshStatus);
app.on('file', refreshTitle);

window.addEventListener('beforeunload', e => { if (app.dirty) e.preventDefault(); });
new ResizeObserver(() => { app.stage.resize(); multiView.layout(); }).observe(canvas);

/* ---------- 起動 ---------- */

async function boot(): Promise<void> {
  app.stage.resize();
  refreshTool(); refreshCommands();
  app.start();
  const saved = checkRestore ? await autosave.load() : undefined;
  if (saved) {
    const r = await ask({
      title: '前回の作業を復元しますか?',
      body: `「${saved.name}」(${new Date(saved.savedAt).toLocaleString()} に自動保存)が残っています。`,
      yes: '復元する', no: '破棄して新しく始める',
    });
    if (r.ok) {
      // 復元している間にドロップされたファイルを開かない(開くと、復元の失敗と取り違えてサンプルで上書きしてしまう)
      if (await app.whileOpening(() => app.openProjectBytes(saved.bytes, null, null, true))) { app.fileName = saved.name; refreshTitle(); return; }
      // 復元できなかったときはサンプルで始める。壊れた自動保存を残すかは本人に決めてもらう
      const keep = await ask({
        title: '前回の作業を復元できませんでした',
        body: '自動保存のデータを削除しますか? 残しておくと、次回の起動時にもう一度復元を試します。',
        yes: '削除する', no: '残しておく',
      });
      if (keep.ok) await autosave.clear();
    } else {
      await autosave.clear();
    }
  }
  await app.loadSample({ keepAutosave: true });
  if (e2e) app.setPaused(true);
}
void boot();
