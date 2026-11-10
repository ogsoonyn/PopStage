import './style.css';
import { App, type Tool } from './app';
import { bindStageInput, isTyping } from './ui/input';
import { bindPanels } from './ui/panels';
import { bindExportDialog } from './ui/exportDialog';
import { bindBlurDialog } from './ui/blurDialog';
import { $, ask, toast } from './ui/dom';
import { autosave } from './storage/autosave';
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
(window as unknown as { popstage: App }).popstage = app;

bindStageInput(app, canvas);
bindPanels(app);
const exportDialog = bindExportDialog(app);
const blurDialog = bindBlurDialog(app);

/* ---------- ファイルを開く ---------- */

const fileImage = $<HTMLInputElement>('fileImage'), fileProject = $<HTMLInputElement>('fileProject');
fileImage.addEventListener('change', () => { const f = fileImage.files?.[0]; fileImage.value = ''; if (f) void app.openFile(f); });
fileProject.addEventListener('change', () => { const f = fileProject.files?.[0]; fileProject.value = ''; if (f) void app.openFile(f); });

async function openProjectDialog(): Promise<void> {
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({
        types: [{ description: 'PopStage プロジェクト / 画像', accept: { 'application/zip': ['.popstage'], 'image/*': ['.png', '.jpg', '.jpeg', '.webp'] } }],
      });
      await app.openFile(await h.getFile(), h);
    } catch (e) { if ((e as DOMException).name !== 'AbortError') toast(String(e), 'error'); }
  } else fileProject.click();
}

/* ---------- コマンド(メニュー・ボタン・ショートカット共通) ---------- */

const commands: Record<string, { run: () => unknown; enabled?: () => boolean }> = {
  openImage: { run: () => fileImage.click() },
  open: { run: openProjectDialog },
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
  toggleShade: { run: () => app.setViewOption('shade', !app.view.shade) },
  toggleFade: { run: () => app.setViewOption('fade', !app.view.fade) },
  toggleFlat: { run: () => app.setViewOption('flat', !app.view.flat) },
  togglePause: { run: () => app.setPaused(!app.paused) },
  resetView: { run: () => app.resetView() },
  addLayer: { run: () => app.addLayer(), enabled: () => !!app.doc },
  duplicateLayer: { run: () => app.duplicateLayer(), enabled: () => !!app.activeLayer },
  deleteLayer: { run: () => app.deleteLayer(), enabled: () => (app.doc?.layers.length ?? 0) > 1 },
  layerUp: { run: () => app.moveLayer(1), enabled: () => app.activeIndex >= 0 && app.activeIndex < (app.doc?.layers.length ?? 0) - 1 },
  layerDown: { run: () => app.moveLayer(-1), enabled: () => app.activeIndex > 0 },
  help: { run: () => $<HTMLDialogElement>('helpDialog').showModal() },
  about: { run: () => { $('aboutVersion').textContent = `バージョン ${__APP_VERSION__} ・ .popstage 形式 v1`; $<HTMLDialogElement>('aboutDialog').showModal(); } },
};

function runCommand(name: string): void {
  const c = commands[name];
  if (!c || (c.enabled && !c.enabled())) return;
  void Promise.resolve(c.run()).catch(e => { console.error(e); toast(String(e instanceof Error ? e.message : e), 'error'); });
}

document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach(b => b.addEventListener('click', () => {
  // ドロップダウンを閉じる
  (document.activeElement as HTMLElement | null)?.blur();
  runCommand(b.dataset.cmd!);
}));

function refreshCommands(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach(b => {
    const c = commands[b.dataset.cmd!];
    b.disabled = !!c?.enabled && !c.enabled();
  });
  document.querySelector('[data-label=undo]')!.textContent = app.history.undoLabel ? `(${app.history.undoLabel})` : '';
  document.querySelector('[data-label=redo]')!.textContent = app.history.redoLabel ? `(${app.history.redoLabel})` : '';
  const checks: Record<string, boolean> = { overlay: app.view.overlay, grid: app.view.grid, shade: app.view.shade, fade: app.view.fade, flat: app.view.flat, pause: app.paused };
  document.querySelectorAll<HTMLElement>('[data-check]').forEach(el => { el.textContent = checks[el.dataset.check!] ? '✓' : ''; });
}
app.history.on('change', refreshCommands);
app.on('active', refreshCommands);
app.on('view', refreshCommands);
app.store.on('layers', refreshCommands);
app.store.on('replace', refreshCommands);

/* ---------- ツール ---------- */

const TOOL_HINTS: Record<Tool, string> = {
  brush: 'ドラッグで塗る(Alt で消しゴム)/ 右ドラッグで回転 / ホイールでズーム',
  erase: 'ドラッグでウェイトを消す',
  smooth: 'ドラッグで段差をならす',
  grab: 'ドラッグで引っ張って離すと揺れる',
  view: 'ドラッグで視点を回す / Space+ドラッグで平行移動',
};
function refreshTool(): void {
  document.querySelectorAll<HTMLButtonElement>('.tool').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === app.tool)));
  const paint = app.tool === 'brush' || app.tool === 'erase' || app.tool === 'smooth';
  document.querySelectorAll<HTMLElement>('[data-brush-opt]').forEach(el => el.classList.toggle('opacity-40', !paint));
  $('toolHint').textContent = TOOL_HINTS[app.tool];
}
document.querySelectorAll<HTMLButtonElement>('.tool').forEach(b => b.addEventListener('click', () => app.setTool(b.dataset.tool as Tool)));
app.on('tool', refreshTool);

/* ---------- ショートカット(8章) ---------- */

const anyDialogOpen = () => !!document.querySelector('dialog[open]');

window.addEventListener('keydown', e => {
  if (isTyping(e) || anyDialogOpen()) return;
  const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
  const hit = (name: string) => { e.preventDefault(); runCommand(name); };
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
  const tools: Record<string, Tool> = { b: 'brush', e: 'erase', s: 'smooth', g: 'grab', v: 'view' };
  if (!e.shiftKey && tools[k]) { e.preventDefault(); app.setTool(tools[k]); return; }
  if (k === 'w') return hit('toggleOverlay');
  if (k === 'f') return hit('toggleFlat');
  if (k === 'p') return hit('togglePause');
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
  const f = [...(e.dataTransfer?.files ?? [])].find(f => isImageFile(f) || isProjectFile(f));
  if (f) void app.openFile(f);
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
  if (!app.exporting) $('sRec').textContent = [app.view.flat && 'ポップOFF', app.paused && '揺れ停止中'].filter(Boolean).join('・');
  $('sSave').textContent = app.dirty ? (app.lastAutosave ? `未保存の変更あり(${app.lastAutosave.toLocaleTimeString()} に自動保存)` : '未保存の変更あり') : app.lastSaved ? `保存済み ${app.lastSaved.toLocaleTimeString()}` : '';
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
new ResizeObserver(() => app.stage.resize()).observe(canvas);

/* ---------- 起動 ---------- */

async function boot(): Promise<void> {
  app.stage.resize();
  refreshTool(); refreshCommands();
  app.start();
  const saved = e2e ? undefined : await autosave.load();
  if (saved) {
    const r = await ask({
      title: '前回の作業を復元しますか?',
      body: `「${saved.name}」(${new Date(saved.savedAt).toLocaleString()} に自動保存)が残っています。`,
      yes: '復元する', no: '破棄して新しく始める',
    });
    if (r.ok) { await app.openProjectBytes(saved.bytes, null, null, true); app.fileName = saved.name; refreshTitle(); return; }
    await autosave.clear();
  }
  await app.loadSample();
  if (e2e) app.setPaused(true);
}
void boot();
