/**
 * アプリ本体。モデル・コマンド・描画・物理・保存・書き出しをつなぐ。
 * 画面の部品(ui/)はここを経由して状態を読み書きする。
 */
import { Store, createProject, createDocument, createLayer, cloneLayer, frontCamera, defaultMultiCamera, LIMITS, type CameraState, type Project, type Document, type Layer } from './model/project';
import { History } from './commands/history';
import type { Rect } from './model/weightmap';
import { InsertLayer, RemoveLayer, MoveLayer, WeightEdit, weightOperation, diffTiles } from './commands/commands';
import { Stage, type ViewOptions } from './stage/stage';
import { PhysicsWorld } from './physics/world';
import { MotionRecorder } from './physics/recorder';
import { Stroke, type PaintMode } from './paint/stroke';
import { serializeProject, serializeProjectBlob, deserializeProject, FILE_EXTENSION, type PngCacheEntry } from './storage/popstage';
import { autosave } from './storage/autosave';
import { recent, type RecentKind } from './storage/recent';
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

/**
 * 動作の重さの計測の受け口。デバッグ表示(?debug、debug/perfOverlay.ts)を開いたときだけ付く。
 * 付いていないときは null の確認だけで済むので、ふだんの負荷は増えない。
 */
export interface PerfProbe {
  /** requestAnimationFrame の時刻でフレームの始まりを知らせる */
  frame(now: number): void;
  /** t0 から now までを、その処理の時間として今のフレームに足す。now を返す */
  lap(section: 'physics' | 'upload' | 'render', t0: number, now: number): number;
  /** 自動保存などの単発の処理 */
  event(e: { t: number; d: number; kind: string; detail?: string }): void;
}

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
  /** 表示用の画像の一辺の上限 */
  private get displaySize(): number { return Math.min(4096, this.stage.maxTextureSize); }

  fileHandle: FileSystemFileHandle | null = null;
  fileName: string | null = null;
  dirty = false;
  /** 変更のたびに増える番号。保存中に変更があったかを見分けるのに使う */
  private revision = 0;
  /** まだ GPU へ送っていない、レイヤーごとの変わった矩形 */
  private pendingUploads = new Map<string, Rect>();
  /** 自動保存用に、変わっていないレイヤーのウェイト PNG を使い回す(手動の保存では使わない) */
  private pngCache = new Map<string, PngCacheEntry>();
  /** 直近の自動保存が失敗していればその理由 */
  autosaveError: string | null = null;
  /** 実行中の自動保存(終わるのを待ってから自動保存を消すため) */
  private autosaving: Promise<void> = Promise.resolve();
  exporting = false;
  lastSaved: Date | null = null;
  lastAutosave: Date | null = null;

  private loading = false;
  private autosaveTimer = 0;
  private stroke: { stroke: Stroke; layerId: string; label: string } | null = null;
  private syncToken = 0;
  fps = 0;
  /** 計測(デバッグ表示を開いたときだけ) */
  perf: PerfProbe | null = null;
  /** 描画ループを始めた回数。1 より多ければループが重なっている */
  loops = 0;

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
    s.on('replace', () => this.pngCache.clear());
    s.on('layers', () => {
      const doc = this.doc; if (!doc) return;
      // 並べ替え・追加・削除ではウェイトは変わらないので、PNG は作り直さない(無くなったレイヤーの分だけ捨てる)
      const ids = new Set(doc.layers.map(l => l.id));
      for (const id of this.pngCache.keys()) if (!ids.has(id)) this.pngCache.delete(id);
      const t = performance.now();
      this.stage.setLayers(doc.layers);
      this.perf?.event({ t, d: performance.now() - t, kind: 'layers', detail: 'レイヤー構成の変更(ウェイトの全面転送)' });
      this.pendingUploads.clear(); // 全レイヤーを送り直したので、溜めていた分は要らない
      if (!this.activeLayerId || !s.findLayer(this.activeLayerId)) this.setActiveLayer(doc.layers[0]?.id ?? null);
      else this.syncView();
    });
    s.on('weights', ({ layerId, rect }) => {
      this.pngCache.delete(layerId);
      // GPU への転送は、変わった矩形をまとめて描画の直前に1回だけ行う
      const prev = this.pendingUploads.get(layerId);
      this.pendingUploads.set(layerId, prev ? unionRect(prev, rect) : { ...rect });
    });
    s.on('project', ({ keys }) => {
      if (keys.includes('background')) this.applyBackground();
      this.emit('status', undefined);
    });
    s.on('change', () => {
      this.revision++;
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
    this.pendingUploads.clear();
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
    this.project.camera = frontCamera(this.project.camera.fov);
    this.world.cutView(); // 視点が飛ぶだけなので揺らさない
    this.cameraChanged();
  }

  /**
   * 視点(回転・平行移動・ズーム)を変えたことを知らせる。視点は保存される項目なので「未保存」にして
   * 自動保存を予約するが、アンドゥには積まない。ホイールのように続けて来るものは間引く。
   */
  cameraChanged(): void {
    clearTimeout(this.cameraTimer);
    this.cameraTimer = window.setTimeout(() => { this.cameraTimer = 0; this.store.emit('change', undefined); }, 300);
  }
  private cameraTimer = 0;

  /* ---------- 読み込み ---------- */

  /**
   * プロジェクトを読み込む。先に画像をデコードし、成功してから状態を一度に差し替える。
   * デコードに失敗したら例外を投げ、今の状態には何も触れない。
   * 後から始まった別の読み込みに追い越されたときは何もせず false を返す。
   */
  async loadProject(project: Project, opts: { fileName?: string | null; handle?: FileSystemFileHandle | null; dirty?: boolean; keepAutosave?: boolean; canvas?: HTMLCanvasElement } = {}): Promise<boolean> {
    const doc = project.documents[0];
    if (!doc) throw new Error('プロジェクトに画像が入っていません');
    const token = ++this.syncToken;
    // 呼び出し側でデコード済みなら、それを使う(同じ画像を2回デコードしない)
    const canvas = opts.canvas ?? await decodeForDisplay(doc.image, this.displaySize);
    // デコード中に別の読み込みが始まっていたら、こちらは捨てる
    if (token !== this.syncToken) return false;
    this.loading = true;
    clearTimeout(this.cameraTimer); this.cameraTimer = 0; // 前の作業の視点変更を、新しく開いた作業の変更として数えない
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
      this.autosaveError = null;
      this.applyDocument(canvas);
    } finally { this.loading = false; }
    // 別の作業に切り替えたので、前の作業の自動保存はもう要らない(復元した作業の読み込みは除く)
    if (!opts.dirty && !opts.keepAutosave) { clearTimeout(this.autosaveTimer); void autosave.clear(); }
    this.emit('file', undefined);
    return true;
  }

  async loadSample(opts: { keepAutosave?: boolean } = {}): Promise<void> {
    const doc = await createSampleDocument();
    const p = createProject(doc);
    await this.loadProject(p, { keepAutosave: opts.keepAutosave });
  }

  /** 未保存の変更があれば確認する。続けてよければ true。 */
  async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) return true;
    const r = await ask({ title: '保存されていない変更があります', body: '変更を破棄して続けますか?', yes: '破棄して続ける' });
    return r.ok;
  }

  /** 書き出し・塗り・ぼかしのプレビュー・別のファイルの読み込みの最中は、ファイルを開かない */
  get busy(): boolean { return this.exporting || this.stroking || this.previewingBlur || this.opening; }
  private opening = false;

  /** confirmed: 未保存の変更を捨ててよいか、呼ぶ側で確かめ済み */
  async openFile(file: File, handle?: FileSystemFileHandle, opts: { confirmed?: boolean } = {}): Promise<void> {
    if (this.busy) { toast('いまはファイルを開けません。処理が終わってからもう一度お試しください。', 'warning'); return; }
    const t = performance.now();
    await this.whileOpening(() => this.openFileNow(file, handle, !!opts.confirmed));
    this.perf?.event({ t, d: performance.now() - t, kind: 'open', detail: `${file.name}(${(file.size / 1e6).toFixed(1)}MB、確認の待ち時間も含む)` });
  }

  /** ファイルを開いている間は、ほかのファイルを開かせない(起動時の復元にも使う) */
  async whileOpening<T>(fn: () => Promise<T>): Promise<T> {
    this.opening = true;
    try { return await fn(); } finally { this.opening = false; }
  }

  private async openFileNow(file: File, handle: FileSystemFileHandle | undefined, confirmed: boolean): Promise<void> {
    if (isProjectFile(file)) {
      if (!confirmed && !(await this.confirmDiscard())) return;
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await file.arrayBuffer()); } catch (e) {
        toast(`「${file.name}」を読めませんでした: ${e instanceof Error ? e.message : e}`, 'error', 6000);
        return;
      }
      // 一覧への記録は待たない(記録が遅れたり失敗したりしても、次のファイルを開けるように)
      if (await this.openProjectBytes(bytes, file.name, handle ?? null)) void this.remember('project', file.name, file.size, handle, () => bytes);
    } else if (isImageFile(file)) {
      if (!confirmed && !(await this.confirmDiscard())) return;
      if (await this.openImage(file)) void this.remember('image', file.name, file.size, handle, async () => new Uint8Array(await file.arrayBuffer()));
    } else {
      toast('PNG / JPEG / WebP の画像か、.popstage ファイルを選んでください。', 'warning');
    }
  }

  /**
   * 最近開いたファイルの一覧に足す。縮小画像は今の視点で描く。
   * 一覧に入れられなくても、開く・保存するのは止めない。
   */
  private async remember(kind: RecentKind, name: string, size: number, handle: FileSystemFileHandle | null | undefined, bytes: () => Promise<Uint8Array> | Uint8Array, thumbPng?: Uint8Array): Promise<void> {
    const png = thumbPng ?? await this.thumbnail();
    const thumb = png ? new Blob([png as BlobPart], { type: 'image/png' }) : undefined;
    await recent.add({ name, kind, size, thumb, handle, bytes });
  }

  /** 開けたら true */
  async openImage(file: File): Promise<boolean> {
    setBusy(true);
    try {
      const { asset, canvas } = await fileToAsset(file, this.displaySize);
      const prev = this.project;
      const p = createProject(createDocument(asset, file.name));
      p.background = prev.background;
      p.autoSwing = { ...prev.autoSwing };
      p.camera.fov = prev.camera.fov;
      if (!(await this.loadProject(p, { canvas }))) return false;
      this.setTool('brush');
      toast(`「${file.name}」を開きました。動かしたい所を塗ってください。`, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : '画像を読み込めませんでした。', 'error');
      return false;
    } finally { setBusy(false); }
  }

  /** 開けたら true。開けなければ理由を伝えて false を返し、今の状態は変えない */
  async openProjectBytes(bytes: Uint8Array, name: string | null, handle: FileSystemFileHandle | null, dirty = false): Promise<boolean> {
    setBusy(true);
    try {
      const { project } = await deserializeProject(bytes, { decodeFallback: browserDecodeGray });
      if (!(await this.loadProject(project, { fileName: name, handle, dirty }))) return false;
      if (name) toast(`「${name}」を開きました。`, 'success');
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'プロジェクトを開けませんでした。', 'error', 6000);
      return false;
    } finally { setBusy(false); }
  }

  /* ---------- 保存 ---------- */

  async thumbnail(): Promise<Uint8Array | undefined> {
    if (!this.doc) return undefined;
    this.flushWeights();
    try {
      const w = 320, h = 240, t = performance.now();
      const px = this.stage.renderFrame(w, h, this.project.camera, this.project.background);
      this.perf?.event({ t, d: performance.now() - t, kind: 'thumbnail' });
      return await rgbaToPng(px, w, h);
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
    // 書き込みを待つ間に変更されたら、その変更は保存されていないので「未保存」のまま残す
    const thumb = await this.thumbnail();
    // 間引き中の視点の変更は、これから保存する内容に含まれるので、ここで通知を取り消す
    const cameraPending = this.cameraTimer !== 0;
    if (cameraPending) { clearTimeout(this.cameraTimer); this.cameraTimer = 0; }
    const revision = this.revision;
    const bytes = this.serialize(thumb);
    const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
    try {
      const h = await saveFile(blob, this.suggestedName(), PROJECT_TYPES, saveAs ? null : this.fileHandle);
      if (h === undefined) { if (cameraPending) this.cameraChanged(); return false; }
      this.fileHandle = h;
      if (h) this.fileName = h.name; else this.fileName ??= this.suggestedName();
      this.lastSaved = new Date();
      this.autosaveError = null; // ファイルに保存できたので、自動保存の失敗の案内は消す
      if (this.revision === revision) {
        this.dirty = false;
        // 予約中の自動保存は取り消し、実行中のものがあれば終わってから消す(古い内容が後から書き込まれないように)
        clearTimeout(this.autosaveTimer);
        void this.autosaving.then(() => { if (!this.dirty) return autosave.clear(); });
      } else {
        this.scheduleAutosave();
      }
      this.emit('file', undefined);
      toast(h ? `「${h.name}」に保存しました。` : `「${this.fileName}」をダウンロードしました。`, 'success');
      void this.remember('project', this.fileName ?? this.suggestedName(), bytes.byteLength, h, () => bytes, thumb);
      return true;
    } catch (e) {
      if (cameraPending) this.cameraChanged(); // 保存できなかったので、視点の変更は未保存のまま
      toast(`保存できませんでした: ${e instanceof Error ? e.message : e}`, 'error', 6000);
      return false;
    }
  }

  private scheduleAutosave(): void {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = window.setTimeout(() => {
      // 塗りの最中・ぼかしのプレビュー中は、確定していない状態を保存しないよう後に回す
      const unsettled = !!this.stroke || this.previewingBlur;
      if (!this.dirty || !this.doc || unsettled) { if (unsettled) this.scheduleAutosave(); return; }
      const fail = (e: unknown) => {
        console.warn('autosave failed', e);
        this.autosaveError = e instanceof Error ? e.message : String(e);
        this.emit('status', undefined);
      };
      // 直列化は重いので、操作の合間(アイドル時間)に行う
      idle(() => {
        if (!this.dirty || !this.doc) return;
        if (this.stroke || this.previewingBlur) { this.scheduleAutosave(); return; }
        try {
          const t = performance.now();
          const bytes = serializeProjectBlob(this.project, { pngCache: this.pngCache });
          const t1 = performance.now();
          const run = autosave.save({ savedAt: Date.now(), name: this.suggestedName(), bytes })
            .then(() => { this.lastAutosave = new Date(); this.autosaveError = null; this.emit('status', undefined); }, fail);
          if (this.perf) {
            const p = this.perf;
            p.event({ t, d: t1 - t, kind: 'autosave', detail: `${(bytes.size / 1e6).toFixed(1)}MB を直列化(メインスレッド)` });
            void run.then(() => p.event({ t: t1, d: performance.now() - t1, kind: 'autosave-write', detail: 'IndexedDB への書き込み完了まで(非同期)' }));
          }
          this.autosaving = this.autosaving.then(() => run);
        } catch (e) { fail(e); }
      });
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
    w.viewTarget = c.target; // 平行移動でも揺らす
    this.recorder.record({
      viewCut: w.viewCut,
      grab: w.grab ? { ...w.grab } : null,
      grabGains: [...w.grabGains],
      camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, target: { ...c.target } },
    }, () => w.snapshot());
  };

  private prev = 0;
  private frames = 0;
  private fpsTime = 0;

  start(): void {
    this.loops++;
    const loop = (now: number) => {
      this.perf?.frame(now);
      const raw = this.prev ? (now - this.prev) / 1000 : 0, dt = Math.min(raw, 0.1);
      // 物理は 0.1 秒で打ち切るので、その間の平行移動を 1 刻みの動きとして扱うと強く弾みすぎる。測り直す
      if (raw > 0.1) this.world.cutView();
      this.prev = now;
      this.frame(dt);
      this.frames++; this.fpsTime += dt;
      if (this.fpsTime >= 0.5) { this.fps = Math.round(this.frames / this.fpsTime); this.frames = 0; this.fpsTime = 0; this.emit('status', undefined); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /** 溜まっているウェイトの変更を GPU へ送る(描画・書き出しの直前に呼ぶ) */
  flushWeights(): void {
    for (const [id, rect] of this.pendingUploads) {
      const f = this.store.findLayer(id);
      if (f) this.stage.uploadWeights(f.index, f.layer, rect);
    }
    this.pendingUploads.clear();
  }

  frame(dt: number): void {
    const doc = this.doc;
    if (this.exporting || !doc || !this.stage.hasDocument) return;
    const p = this.perf;
    let t = p ? performance.now() : 0;
    this.world.autoSwing = this.project.autoSwing;
    this.world.advance(dt, doc.layers, this.recordStep);
    this.applySwing(this.world, doc);
    if (p) t = p.lap('physics', t, performance.now());
    this.flushWeights();
    if (p) t = p.lap('upload', t, performance.now());
    this.stage.render(this.project.camera, this.multiCam);
    if (p) p.lap('render', t, performance.now());
  }

  /* ---------- 書き出し ---------- */

  async exportMedia(s: ExportSettings, onProgress: (done: number, total: number) => void, signal: AbortSignal) {
    this.exporting = true;
    this.flushWeights();
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

/** ブラウザが暇なときに実行する(requestIdleCallback が無ければすぐ後に) */
function idle(fn: () => void): void {
  if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 0);
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
