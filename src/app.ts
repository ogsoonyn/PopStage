/**
 * アプリ本体。モデル・コマンド・描画・物理・保存・書き出しをつなぐ。
 * 画面の部品(ui/)はここを経由して状態を読み書きする。
 */
import { Store, createProject, createDocument, createLayer, cloneLayer, defaultCamera, defaultMultiCamera, LIMITS, type CameraState, type Project, type Document, type Layer } from './model/project';
import { History } from './commands/history';
import { InsertLayer, RemoveLayer, MoveLayer, WeightEdit, weightOperation, diffTiles } from './commands/commands';
import { Stage, type ViewOptions } from './stage/stage';
import { PhysicsWorld } from './physics/world';
import { MotionRecorder } from './physics/recorder';
import { Stroke, type PaintMode } from './paint/stroke';
import { serializeProject, deserializeProject, FILE_EXTENSION } from './storage/popstage';
import { autosave } from './storage/autosave';
import { runExport, type ExportSettings } from './export/exporter';
import { Emitter } from './util/emitter';
import { decodeForDisplay, canvasAlpha, browserDecodeGray, fileToAsset, rgbaToPng, isProjectFile, isImageFile } from './ui/imageio';
import { createSampleDocument } from './ui/sample';
import { ask, saveFile, setBusy, toast } from './ui/dom';

export type Tool = 'brush' | 'erase' | 'smooth' | 'grab' | 'view';
export type PressureMode = 'strength' | 'size' | 'none';

export interface BrushOptions { size: number; strength: number; hardness: number; pressure: PressureMode }

type AppEvents = {
  tool: Tool;
  active: string | null;
  view: void;
  status: void;
  file: void;
};

const PROJECT_TYPES: FilePickerAcceptType[] = [{ description: 'PopStage プロジェクト', accept: { 'application/zip': [FILE_EXTENSION] } }];
const AUTOSAVE_DELAY = 2000;

export class App extends Emitter<AppEvents> {
  readonly store = new Store();
  readonly history = new History(this.store);
  readonly world = new PhysicsWorld();
  readonly recorder = new MotionRecorder();
  readonly stage: Stage;

  tool: Tool = 'brush';
  activeLayerId: string | null = null;
  view: ViewOptions = { overlay: true, grid: false, fade: false, flat: false, multi: false };
  /** 3面図の「自由角度」の視点(画面だけの設定で保存しない) */
  multiCam: CameraState = defaultMultiCamera();
  paused = false;
  brush: BrushOptions = { size: 64, strength: 0.3, hardness: 0, pressure: 'strength' };
  imageCanvas: HTMLCanvasElement | null = null;

  fileHandle: FileSystemFileHandle | null = null;
  fileName: string | null = null;
  dirty = false;
  exporting = false;
  lastSaved: Date | null = null;
  lastAutosave: Date | null = null;

  private loading = false;
  private autosaveTimer = 0;
  private stroke: { stroke: Stroke; layerId: string; label: string } | null = null;
  private syncToken = 0;
  fps = 0;

  constructor(canvas: HTMLCanvasElement) {
    super();
    this.stage = new Stage(canvas);
    this.wireStore();
  }

  get doc(): Document | undefined { return this.store.doc; }
  get project(): Project { return this.store.project; }
  get activeLayer(): Layer | undefined { return this.activeLayerId ? this.store.findLayer(this.activeLayerId)?.layer : undefined; }
  get activeIndex(): number { return this.activeLayerId ? this.store.findLayer(this.activeLayerId)?.index ?? -1 : -1; }
  get imageLong(): number { const d = this.doc; return d ? Math.max(d.image.width, d.image.height) : 1; }

  /* ---------- Store → Stage ---------- */

  private wireStore(): void {
    const s = this.store;
    s.on('document', ({ keys }) => {
      const doc = this.doc; if (!doc) return;
      if (keys.includes('meshDensity')) this.stage.rebuildMesh(doc.meshDensity);
      if (keys.some(k => k === 'position' || k === 'rotation' || k === 'scale' || k === 'opacity' || k === 'meshDensity')) this.stage.setTransform(doc);
      this.emit('status', undefined);
    });
    s.on('layer', ({ layerId, keys }) => {
      const f = s.findLayer(layerId); if (!f) return;
      if (keys.includes('pop') || keys.includes('visible')) this.stage.setLayerParams(f.index, f.layer);
    });
    s.on('layers', () => {
      const doc = this.doc; if (!doc) return;
      this.stage.setLayers(doc.layers);
      if (!this.activeLayerId || !s.findLayer(this.activeLayerId)) this.setActiveLayer(doc.layers[0]?.id ?? null);
      else this.syncView();
    });
    s.on('weights', ({ layerId, rect }) => {
      const f = s.findLayer(layerId); if (!f) return;
      this.stage.uploadWeights(f.index, f.layer, rect);
    });
    s.on('project', ({ keys }) => {
      if (keys.includes('background')) this.applyBackground();
      this.emit('status', undefined);
    });
    s.on('change', () => {
      if (this.loading) return;
      this.lastAutosave = null;
      if (!this.dirty) { this.dirty = true; this.emit('file', undefined); }
      this.scheduleAutosave();
    });
  }

  /** ドキュメント全体を Stage へ反映する(読み込み時など)。canvas はデコード済みの表示用画像。 */
  private applyDocument(canvas: HTMLCanvasElement): void {
    const doc = this.doc;
    if (!doc) return;
    this.imageCanvas = canvas;
    this.stage.setImage(canvas, doc.image.width, doc.image.height);
    this.stage.rebuildMesh(doc.meshDensity);
    this.stage.setTransform(doc);
    this.stage.setLayers(doc.layers);
    this.world.unitPx = Math.max(doc.image.width, doc.image.height) / 2;
    this.applyBackground();
    this.syncView();
    this.emit('status', undefined);
  }

  private applyBackground(): void {
    const bg = this.project.background;
    this.stage.setBackground(bg);
    const el = this.stage.canvas.parentElement!;
    el.classList.toggle('solid', !!bg);
    if (bg) el.style.setProperty('--stage-bg', bg);
  }

  syncView(): void {
    this.stage.setView(this.view, this.activeIndex);
    this.emit('view', undefined);
  }

  /* ---------- 状態の切り替え ---------- */

  setTool(t: Tool): void { this.tool = t; this.emit('tool', t); }

  setActiveLayer(id: string | null): void {
    this.activeLayerId = id;
    this.syncView();
    this.emit('active', id);
  }

  setViewOption(key: keyof ViewOptions, on: boolean): void {
    this.view[key] = on;
    // 画像を薄くするのは塗りを見るためなので、重ね表示も合わせて入れる
    if (key === 'fade' && on) this.view.overlay = true;
    this.syncView();
  }

  setPaused(on: boolean): void {
    this.paused = on;
    this.world.paused = on;
    if (on) this.world.reset();
    this.emit('view', undefined);
  }

  resetView(): void {
    const fov = this.project.camera.fov;
    this.project.camera = { ...defaultCamera(), fov };
  }

  /* ---------- 読み込み ---------- */

  /**
   * プロジェクトを読み込む。先に画像をデコードし、成功してから状態を一度に差し替える。
   * デコードに失敗したら例外を投げ、今の状態には何も触れない。
   */
  async loadProject(project: Project, opts: { fileName?: string | null; handle?: FileSystemFileHandle | null; dirty?: boolean } = {}): Promise<void> {
    const doc = project.documents[0];
    if (!doc) throw new Error('プロジェクトに画像が入っていません');
    const token = ++this.syncToken;
    const canvas = await decodeForDisplay(doc.image, Math.min(4096, this.stage.maxTextureSize));
    // デコード中に別の読み込みが始まっていたら、こちらは捨てる
    if (token !== this.syncToken) return;
    this.loading = true;
    try {
      this.store.replace(project);
      this.history.clear();
      this.world.reset();
      this.recorder.clear();
      this.activeLayerId = null;
      this.setActiveLayer(project.documents[0]?.layers[0]?.id ?? null);
      this.fileName = opts.fileName ?? null;
      this.fileHandle = opts.handle ?? null;
      this.dirty = !!opts.dirty;
      this.applyDocument(canvas);
    } finally { this.loading = false; }
    this.emit('file', undefined);
  }

  async loadSample(): Promise<void> {
    const doc = await createSampleDocument();
    const p = createProject(doc);
    await this.loadProject(p);
  }

  /** 未保存の変更があれば確認する。続けてよければ true。 */
  async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true;
    const r = await ask({ title: '保存されていない変更があります', body: '変更を破棄して続けますか?', yes: '破棄して続ける' });
    return r.ok;
  }

  async openFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
    if (isProjectFile(file)) {
      if (!(await this.confirmDiscard())) return;
      await this.openProjectBytes(new Uint8Array(await file.arrayBuffer()), file.name, handle ?? null);
    } else if (isImageFile(file)) {
      if (!(await this.confirmDiscard())) return;
      await this.openImage(file);
    } else {
      toast('PNG / JPEG / WebP の画像か、.popstage ファイルを選んでください。', 'warning');
    }
  }

  async openImage(file: File): Promise<void> {
    setBusy(true);
    try {
      const asset = await fileToAsset(file);
      const prev = this.project;
      const p = createProject(createDocument(asset, file.name));
      p.background = prev.background;
      p.autoSwing = { ...prev.autoSwing };
      p.camera.fov = prev.camera.fov;
      await this.loadProject(p);
      this.setTool('brush');
      toast(`「${file.name}」を開きました。動かしたい所を塗ってください。`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : '画像を読み込めませんでした。', 'error');
    } finally { setBusy(false); }
  }

  async openProjectBytes(bytes: Uint8Array, name: string | null, handle: FileSystemFileHandle | null, dirty = false): Promise<void> {
    setBusy(true);
    try {
      const { project } = await deserializeProject(bytes, { decodeFallback: browserDecodeGray });
      await this.loadProject(project, { fileName: name, handle, dirty });
      if (name) toast(`「${name}」を開きました。`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'プロジェクトを開けませんでした。', 'error', 6000);
    } finally { setBusy(false); }
  }

  /* ---------- 保存 ---------- */

  async thumbnail(): Promise<Uint8Array | undefined> {
    if (!this.doc) return undefined;
    try {
      const w = 320, h = 240;
      return await rgbaToPng(this.stage.renderFrame(w, h, this.project.camera, this.project.background), w, h);
    } catch { return undefined; }
  }

  serialize(thumbnail?: Uint8Array): Uint8Array { return serializeProject(this.project, { thumbnail }); }

  suggestedName(): string {
    if (this.fileName) return this.fileName;
    const base = (this.doc?.name ?? 'untitled').replace(/\.[^.]+$/, '');
    return `${base}${FILE_EXTENSION}`;
  }

  async save(saveAs = false): Promise<boolean> {
    if (!this.doc) return false;
    const bytes = this.serialize(await this.thumbnail());
    const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
    try {
      const h = await saveFile(blob, this.suggestedName(), PROJECT_TYPES, saveAs ? null : this.fileHandle);
      if (h === undefined) return false;
      this.fileHandle = h;
      if (h) this.fileName = h.name; else this.fileName ??= this.suggestedName();
      this.dirty = false;
      this.lastSaved = new Date();
      void autosave.clear();
      this.emit('file', undefined);
      toast(h ? `「${h.name}」に保存しました。` : `「${this.fileName}」をダウンロードしました。`, 'success');
      return true;
    } catch (e) {
      toast(`保存できませんでした: ${e instanceof Error ? e.message : e}`, 'error', 6000);
      return false;
    }
  }

  private scheduleAutosave(): void {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      if (!this.dirty || !this.doc || this.stroke) { if (this.stroke) this.scheduleAutosave(); return; }
      try {
        void autosave.save({ savedAt: Date.now(), name: this.suggestedName(), bytes: this.serialize() }).then(() => { this.lastAutosave = new Date(); this.emit('status', undefined); });
      } catch (e) { console.warn('autosave failed', e); }
    }, AUTOSAVE_DELAY);
  }

  /* ---------- 塗り ---------- */

  /** ストロークを始める。x, y は元画像のローカル座標(ピクセル、中心が原点)。 */
  beginStroke(mode: PaintMode, x: number, y: number, pressure: number): boolean {
    const doc = this.doc, layer = this.activeLayer;
    if (!doc || !layer) return false;
    if (!layer.visible) { toast('非表示のレイヤーには塗れません。', 'warning'); return false; }
    const wm = layer.weights, k = wm.width / doc.image.width;
    this.stroke = {
      stroke: new Stroke(wm, mode, { size: this.brush.size * k, strength: this.brush.strength, hardness: this.brush.hardness }),
      layerId: layer.id,
      label: { brush: 'ブラシ', erase: '消しゴム', smooth: 'ぼかし' }[mode],
    };
    this.strokeTo(x, y, pressure);
    return true;
  }

  strokeTo(x: number, y: number, pressure: number): void {
    const st = this.stroke, doc = this.doc; if (!st || !doc) return;
    const wm = st.stroke.map, px = (x / doc.image.width + 0.5) * wm.width, py = (0.5 - y / doc.image.height) * wm.height;
    const p = this.brush.pressure;
    const rect = st.stroke.addPoint(px, py, p === 'size' ? pressure : 1, p === 'strength' ? pressure : 1);
    if (rect) this.store.weightsChanged(st.layerId, rect, false);
  }

  endStroke(): void {
    const st = this.stroke; if (!st) return;
    this.stroke = null;
    const tiles = st.stroke.finish();
    if (tiles.length) {
      this.history.push(new WeightEdit(st.label, st.layerId, tiles));
      this.store.emit('change', undefined);
    }
  }

  get stroking(): boolean { return !!this.stroke; }

  /* ---------- ウェイトの一括処理 ---------- */

  weightOp(label: string, op: (wm: Layer['weights']) => void): void {
    const layer = this.activeLayer; if (!layer) return;
    const cmd = weightOperation(this.store, layer.id, label, op);
    if (cmd) this.history.push(cmd);
    else toast('変化はありませんでした。');
  }

  /* 全体をぼかす(ガウス): プレビューしながら半径を決め、適用で1手として記録する */

  private blurPreview: { layerId: string; original: Uint8Array } | null = null;

  beginBlurPreview(): boolean {
    const layer = this.activeLayer; if (!layer || this.blurPreview) return false;
    this.blurPreview = { layerId: layer.id, original: layer.weights.data.slice() };
    return true;
  }

  /** radius は元画像のピクセル単位。0 で元に戻した状態を表示する。 */
  previewBlur(radius: number): void {
    const p = this.blurPreview, doc = this.doc; if (!p || !doc) return;
    const layer = this.store.findLayer(p.layerId)?.layer; if (!layer) return;
    const wm = layer.weights;
    wm.data.set(p.original);
    if (radius > 0) wm.gaussianBlur(radius * (wm.width / doc.image.width));
    this.store.weightsChanged(p.layerId, wm.fullRect, false);
  }

  endBlurPreview(apply: boolean, radius: number): void {
    const p = this.blurPreview; if (!p) return;
    this.blurPreview = null;
    const layer = this.store.findLayer(p.layerId)?.layer; if (!layer) return;
    const wm = layer.weights;
    if (!apply) {
      wm.data.set(p.original);
      this.store.weightsChanged(p.layerId, wm.fullRect, false);
      return;
    }
    const tiles = diffTiles(p.original, wm);
    if (!tiles.length) { toast('変化はありませんでした。'); return; }
    this.history.push(new WeightEdit(`全体をぼかす(半径 ${radius}px)`, p.layerId, tiles));
    this.store.emit('change', undefined);
  }

  get previewingBlur(): boolean { return !!this.blurPreview; }

  fromAlpha(): void {
    const c = this.imageCanvas, layer = this.activeLayer; if (!c || !layer) return;
    const alpha = canvasAlpha(c, layer.weights.width, layer.weights.height);
    if (alpha.every(a => a === 255)) { toast('この画像には透明な部分がありません(画像全体が塗られます)。', 'warning', 5000); }
    this.weightOp('アルファから生成', wm => wm.setFromAlpha(alpha, wm.width, wm.height));
  }

  /* ---------- レイヤー構成 ---------- */

  addLayer(): void {
    const doc = this.doc; if (!doc) return;
    if (doc.layers.length >= LIMITS.maxLayers) { toast(`レイヤーは最大 ${LIMITS.maxLayers} 枚です。`, 'warning'); return; }
    const layer = createLayer(doc, nextLayerName(doc));
    const index = this.activeIndex >= 0 ? this.activeIndex + 1 : doc.layers.length;
    this.history.execute(new InsertLayer('レイヤーを追加', doc.id, layer, index));
    this.setActiveLayer(layer.id);
  }

  duplicateLayer(): void {
    const doc = this.doc, src = this.activeLayer; if (!doc || !src) return;
    if (doc.layers.length >= LIMITS.maxLayers) { toast(`レイヤーは最大 ${LIMITS.maxLayers} 枚です。`, 'warning'); return; }
    const layer = cloneLayer(src, `${src.name} のコピー`);
    this.history.execute(new InsertLayer('レイヤーを複製', doc.id, layer, this.activeIndex + 1));
    this.setActiveLayer(layer.id);
  }

  deleteLayer(): void {
    const doc = this.doc, layer = this.activeLayer; if (!doc || !layer) return;
    if (doc.layers.length <= 1) { toast('最後のレイヤーは削除できません。', 'warning'); return; }
    const i = this.activeIndex;
    this.history.execute(new RemoveLayer(this.store, layer.id));
    this.setActiveLayer(doc.layers[Math.min(i, doc.layers.length - 1)].id);
  }

  /** 一覧の上を手前(配列の後ろ)として並べ替える。dir: +1 で上へ */
  moveLayer(dir: 1 | -1): void {
    const doc = this.doc, layer = this.activeLayer; if (!doc || !layer) return;
    const from = this.activeIndex, to = from + dir;
    if (to < 0 || to >= doc.layers.length) return;
    this.history.execute(new MoveLayer(layer.id, from, to));
  }

  /* ---------- 物理と描画のループ ---------- */

  applySwing = (world: PhysicsWorld, doc: Document): void => {
    const k = Math.max(doc.image.width, doc.image.height) / 2;
    doc.layers.forEach((l, i) => {
      const s = world.displacement(l.id);
      this.stage.setSwing(i, { x: s.x * k, y: s.y * k, z: s.z * k }, l.visible && l.physics.enabled);
    });
  };

  private recordStep = (): void => {
    const w = this.world, c = this.project.camera;
    this.recorder.record({
      grab: w.grab ? { ...w.grab } : null,
      grabGains: [...w.grabGains],
      camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, target: { ...c.target } },
    }, () => w.snapshot());
  };

  private prev = 0;
  private frames = 0;
  private fpsTime = 0;

  start(): void {
    const loop = (now: number) => {
      const dt = this.prev ? Math.min((now - this.prev) / 1000, 0.1) : 0;
      this.prev = now;
      this.frame(dt);
      this.frames++; this.fpsTime += dt;
      if (this.fpsTime >= 0.5) { this.fps = Math.round(this.frames / this.fpsTime); this.frames = 0; this.fpsTime = 0; this.emit('status', undefined); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  frame(dt: number): void {
    const doc = this.doc;
    if (this.exporting || !doc || !this.stage.hasDocument) return;
    this.world.autoSwing = this.project.autoSwing;
    this.world.advance(dt, doc.layers, this.recordStep);
    this.applySwing(this.world, doc);
    this.stage.render(this.project.camera, this.multiCam);
  }

  /* ---------- 書き出し ---------- */

  async exportMedia(s: ExportSettings, onProgress: (done: number, total: number) => void, signal: AbortSignal) {
    this.exporting = true;
    this.emit('status', undefined);
    try {
      return await runExport({ stage: this.stage, store: this.store, recorder: this.recorder, applySwing: this.applySwing }, s, onProgress, signal);
    } finally {
      this.exporting = false;
      this.emit('status', undefined);
    }
  }
}

function nextLayerName(doc: Document): string {
  let n = doc.layers.length + 1;
  while (doc.layers.some(l => l.name === `レイヤー${n}`)) n++;
  return `レイヤー${n}`;
}
