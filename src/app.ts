/**
 * アプリ本体。モデル・コマンド・描画・物理・保存・書き出しをつなぐ。
 * 画面の部品(ui/)はここを経由して状態を読み書きする。
 */
import { Store, createProject, createDocument, createLayer, cloneLayer, frontCamera, defaultOrthoView, LIMITS, PRESETS, applyPreset, type PresetName, type CameraState, type Vec3, type OrthoView, type Project, type Document, type Layer } from './model/project';
import { History } from './commands/history';
import type { Rect } from './model/weightmap';
import { InsertLayer, RemoveLayer, MoveLayer, WeightEdit, SetTake, PatchLayer, PatchProject, Batch, weightOperation, diffTiles } from './commands/commands';
import { Stage, type ViewOptions } from './stage/stage';
import { PhysicsWorld, PHYSICS_DT } from './physics/world';
import { MotionRecorder, applySample, type RecordSample } from './physics/recorder';
import { finalizeTake, takeFromKeys, takeSeconds, TAKE_MAX_SECONDS, TAKE_MIN_SECONDS, KEY_SECONDS, MAX_KEYS, type ViewKey, type KeyFrame } from './physics/take';
import { Stroke, type PaintMode } from './paint/stroke';
import { inflateShape, type InflateProfile, type InflateBlend } from './paint/inflate';
import { serializeProject, serializeProjectBlob, deserializeProject, FILE_EXTENSION, type PngCacheEntry } from './storage/popstage';
import { autosave } from './storage/autosave';
import { recent, type RecentKind } from './storage/recent';
import { prefs } from './storage/prefs';
import { runExport, type ExportSettings } from './export/exporter';
import { Emitter } from './util/emitter';
import { decodeForDisplay, canvasAlpha, browserDecodeGray, fileToAsset, rgbaToPng, isProjectFile, isImageFile } from './ui/imageio';
import { createSampleDocument } from './ui/sample';
import { ask, saveFile, setBusy, toast } from './ui/dom';

export type Tool = 'brush' | 'erase' | 'smooth' | 'inflate' | 'grab' | 'shake' | 'view' | 'pan';
export type PressureMode = 'strength' | 'size' | 'none';
/** 操作の記録の状態。記録中・ループ再生中・どちらでもない */
export type TakeState = 'idle' | 'recording' | 'playing';

export interface BrushOptions { size: number; strength: number; hardness: number; pressure: PressureMode }

/** 「膨らませる」の範囲。中心と幅・縦は元画像のピクセル単位(中心が原点、y は上向き) */
export interface InflateArea { x: number; y: number; w: number; h: number }
export interface InflateSettings {
  shape: 'ellipse' | 'rect';
  /** 頂上の高さ(元画像のピクセル)。null はレイヤーのポップ量と同じ */
  height: number | null;
  softness: number; // 0〜1
  profile: InflateProfile;
  blend: InflateBlend;
}
export interface InflateState {
  /** 範囲を描いたレイヤー */
  readonly layerId: string;
  readonly area: InflateArea;
  readonly settings: InflateSettings & { height: number };
  /** 範囲を描いたレイヤーのポップ量(プレビュー中は変えない) */
  readonly sourcePop: number;
  /** 高さがポップ量を超えるので新しいレイヤーに作るときの、そのレイヤーの名前とポップ量 */
  readonly newLayer: { readonly name: string; readonly pop: number } | null;
  /** 高さがポップ量を超えるが、レイヤーが上限の枚数なので新しいレイヤーを作れない(ポップ量の高さで止まる) */
  readonly limited: boolean;
}

type AppEvents = {
  tool: Tool;
  active: string | null;
  view: void;
  /** 画像・保存の状態・書き出し中かなど、ステータスバーや使えるかの表示に関わる変化(fps は含めない) */
  status: void;
  /** fps を測り直した(0.5 秒ごと) */
  fps: number;
  file: void;
  /** 膨らませるプレビューの開始・変更・終了 */
  inflate: 'begin' | 'change' | 'end';
  /** 全体ぼかしのプレビューの開始・終了 */
  blur: 'begin' | 'end';
  /** 描画ループで1フレーム描いた(画像全体が動いている間に、ブラシの円を当て直すのに使う) */
  frame: void;
  /** 操作の記録の状態(記録中・ループ再生中)が変わった */
  take: TakeState;
};

/** 画像全体のずれ(ピストン)の飛びをならす時定数(秒)。自動揺らしの切り替えや、塗り終わりで止めていた画像を戻すとき */
const BASE_EASE = 0.05;

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

const PROJECT_TYPES: FilePickerAcceptType[] = [{ description: 'PukuPop プロジェクト', accept: { 'application/zip': [FILE_EXTENSION] } }];
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
  /** 3面図の「自由角度」の視点。project.multiCamera に置き、ファイルにも保存する */
  get multiCam(): CameraState { return this.project.multiCamera; }
  set multiCam(c: CameraState) { this.project.multiCamera = c; }
  /** 3面図の正面・右から・下からの拡大率と平行移動(3つで共有。画面だけの設定で保存しない) */
  multiOrtho: OrthoView = defaultOrthoView();
  paused = false;
  /**
   * 「揺らす」ツールで画像を振った量(ワールド座標)。カメラは画像に付いて動くので画面上の位置は
   * 変わらないが、物理には平行移動と同じ動きとして伝える。画面だけの値で保存しない
   */
  shake: Vec3 = { x: 0, y: 0, z: 0 };
  brush: BrushOptions = { size: 64, strength: 0.3, hardness: 0, pressure: 'strength' };
  /** 前回の「膨らませる」の設定(次に範囲を描いたときの初期値) */
  inflateSettings: InflateSettings = { shape: 'ellipse', height: null, softness: 1, profile: 'dome', blend: 'max' };
  imageCanvas: HTMLCanvasElement | null = null;
  /** 表示用の画像の一辺の上限 */
  private get displaySize(): number { return Math.min(4096, this.stage.maxTextureSize); }

  fileHandle: FileSystemFileHandle | null = null;
  fileName: string | null = null;
  dirty = false;
  /** 変更のたびに増える番号。保存中に変更があったかを見分けるのに使う */
  private revision = 0;
  /**
   * 画面に出している画像全体のずれ(ピストン、元画像のピクセル)。ライブ表示だけの値で、物理と書き出しには関わらない。
   * 塗り・膨らませる範囲のドラッグ中は止めて(held)、当たり判定がずれないようにする。設定の切り替えで飛ぶ分は fix でならす
   */
  private base = { shown: { x: 0, y: 0, z: 0 }, live: { x: 0, y: 0, z: 0 }, fix: { x: 0, y: 0, z: 0 }, key: '', held: null as Vec3 | null };
  /** レイヤーごとのウェイトの重心(元画像のピクセル、ためて膨らむ2 の広がりの中心)。ウェイトが変わったら捨てる */
  private centers = new Map<string, { x: number; y: number }>();
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

  /** 操作の記録の状態 */
  takeState: TakeState = 'idle';
  /** 記録中の操作(止めたときに finalizeTake で整える) */
  private takeRaw: RecordSample[] = [];
  /** ループ再生で次に入れる記録の位置 */
  private playIndex = 0;
  /**
   * キーフレームの下書き(画面だけ)。作った記録はそのキーフレームも持つので、
   * 記録が差し替わったら(開く・アンドゥなど)その記録のキーフレームに合わせる
   */
  keyDraft: KeyFrame[] = [];

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
      if (keys.includes('pop') || keys.includes('visible') || keys.includes('blend')) this.stage.setLayerParams(f.index, f.layer);
    });
    s.on('replace', () => { this.pngCache.clear(); this.centers.clear(); this.syncKeyDraft(true); });
    s.on('layers', () => {
      const doc = this.doc; if (!doc) return;
      // 並べ替え・追加・削除ではウェイトは変わらないので、PNG は作り直さない(無くなったレイヤーの分だけ捨てる)
      const ids = new Set(doc.layers.map(l => l.id));
      for (const id of this.pngCache.keys()) if (!ids.has(id)) this.pngCache.delete(id);
      for (const id of this.centers.keys()) if (!ids.has(id)) this.centers.delete(id);
      const t = performance.now();
      this.stage.setLayers(doc.layers);
      this.perf?.event({ t, d: performance.now() - t, kind: 'layers', detail: 'レイヤー構成の変更(ウェイトの全面転送)' });
      this.pendingUploads.clear(); // 全レイヤーを送り直したので、溜めていた分は要らない
      if (!this.activeLayerId || !s.findLayer(this.activeLayerId)) this.setActiveLayer(doc.layers[0]?.id ?? null);
      else this.syncView();
    });
    s.on('weights', ({ layerId, rect }) => {
      this.pngCache.delete(layerId);
      // 広がりの中心は、塗っている間は動かさない(塗った範囲全体がずれて見えないように)。塗り終わりで求め直す
      if (this.stroke?.layerId !== layerId) this.centers.delete(layerId);
      // GPU への転送は、変わった矩形をまとめて描画の直前に1回だけ行う
      const prev = this.pendingUploads.get(layerId);
      this.pendingUploads.set(layerId, prev ? unionRect(prev, rect) : { ...rect });
    });
    s.on('project', ({ keys }) => {
      if (keys.includes('background')) this.applyBackground();
      // アンドゥなどで記録が消えたら再生をやめる。差し替わったら初めから再生する
      if (keys.includes('take') && this.takeState === 'playing') {
        if (this.project.take) this.playTake(); else this.stopTake();
      }
      if (keys.includes('take')) this.syncKeyDraft();
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

  /** 見栄えの確認用に、編集のための表示(重ね表示・画像を薄く・ポップ一時OFF・揺れ一時停止・グリッド)をまとめて切る */
  clearEditView(): void {
    Object.assign(this.view, { overlay: false, fade: false, flat: false, grid: false });
    this.syncView();
    if (this.paused) this.setPaused(false);
  }

  setPaused(on: boolean): void {
    // 一時停止中は物理が進まず、記録も再生も止まってしまうので、先に終える
    if (on) { this.stopTake(); this.stopRecording(); }
    this.paused = on;
    this.world.paused = on;
    if (on) this.world.reset();
    this.emit('view', undefined);
  }

  resetView(): void {
    this.stopTake();
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
      // 記録中・再生中の操作は前の作業のものなので捨てる
      this.takeRaw = []; this.playIndex = 0;
      if (this.takeState !== 'idle') { this.takeState = 'idle'; this.world.grab = null; this.world.grabGains.clear(); this.emit('take', 'idle'); }
      this.store.replace(project);
      this.history.clear();
      this.world.reset();
      this.recorder.clear();
      // 3面図の視点は前の画像の大きさで動かしてあるので、新しい画像では初めの表示に戻す
      this.multiOrtho = defaultOrthoView();
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
  get busy(): boolean { return this.exporting || this.stroking || this.previewingBlur || this.previewingInflate || this.opening; }
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
      toast('PNG / JPEG / WebP の画像か、.pukupop ファイルを選んでください。', 'warning');
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

  /**
   * 新しい画像に使う背景・自動揺らし・画角。最後に変えた値をブラウザに覚えてあれば、それを使う
   * (main.ts で覚える)。無ければ今の作業の値を引き継ぐ。
   */
  private newImageDefaults(): Pick<Project, 'background' | 'autoSwing'> & { fov: number } {
    const prev = this.project, d = prefs.get<Record<string, unknown>>('newImage') ?? {};
    const num = (v: unknown, lim: { min: number; max: number }, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lim.min, Math.min(lim.max, v)) : def);
    const a = (d.autoSwing && typeof d.autoSwing === 'object' ? d.autoSwing : {}) as Record<string, unknown>;
    const bg = d.background === null || (typeof d.background === 'string' && /^#[0-9a-f]{6}$/i.test(d.background)) ? d.background as string | null : prev.background;
    return {
      background: 'background' in d ? bg : prev.background,
      autoSwing: {
        enabled: typeof a.enabled === 'boolean' ? a.enabled : prev.autoSwing.enabled,
        period: num(a.period, LIMITS.period, prev.autoSwing.period),
        strength: num(a.strength, { min: 0, max: 1 }, prev.autoSwing.strength),
      },
      fov: num(d.fov, LIMITS.fov, prev.camera.fov),
    };
  }

  /** 開けたら true */
  async openImage(file: File): Promise<boolean> {
    setBusy(true);
    try {
      const { asset, canvas } = await fileToAsset(file, this.displaySize);
      const p = createProject(createDocument(asset, file.name)), d = this.newImageDefaults();
      p.background = d.background;
      p.autoSwing = d.autoSwing;
      p.camera.fov = d.fov;
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
      const unsettled = !!this.stroke || this.previewingBlur || this.previewingInflate;
      if (!this.dirty || !this.doc || unsettled) { if (unsettled) this.scheduleAutosave(); return; }
      const fail = (e: unknown) => {
        console.warn('autosave failed', e);
        this.autosaveError = e instanceof Error ? e.message : String(e);
        this.emit('status', undefined);
      };
      // 直列化は重いので、操作の合間(アイドル時間)に行う
      idle(() => {
        if (!this.dirty || !this.doc) return;
        if (this.stroke || this.previewingBlur || this.previewingInflate) { this.scheduleAutosave(); return; }
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
    if (this.previewingInflate) { toast('「膨らませる」を適用するかキャンセルしてから塗ってください。', 'warning'); return false; }
    if (this.previewingBlur) { toast('「全体をぼかす」を適用するかキャンセルしてから塗ってください。', 'warning'); return false; }
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
    this.centers.delete(st.layerId);
    const tiles = st.stroke.finish();
    if (tiles.length) {
      this.history.push(new WeightEdit(st.label, st.layerId, tiles));
      this.store.emit('change', undefined);
    }
  }

  /** ストロークを取り消す(スマホで2本目の指が置かれたとき)。塗った分を元に戻し、アンドゥには積まない */
  cancelStroke(): void {
    const st = this.stroke; if (!st) return;
    this.stroke = null;
    this.centers.delete(st.layerId);
    const tiles = st.stroke.finish(), wm = this.store.findLayer(st.layerId)?.layer.weights;
    if (!wm || !tiles.length) return;
    // 塗る前に戻すだけなので、「未保存」にも自動保存の予約にもしない(weightsChanged の persistent = false)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of tiles) {
      const r = wm.tileRect(t.tx, t.ty);
      wm.writeRect(r, t.before);
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    this.store.weightsChanged(st.layerId, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, false);
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
    this.emit('blur', 'begin');
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
    try { this.finishBlur(p, apply, radius); } finally { this.emit('blur', 'end'); }
  }

  private finishBlur(p: NonNullable<App['blurPreview']>, apply: boolean, radius: number): void {
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

  /* 膨らませる: 範囲(楕円・矩形)を、指定した高さと断面で一括して膨らませる。
     プレビューしながら数値を決め、適用で1手として記録する。
     高さが範囲を描いたレイヤーのポップ量を超えるときは、そのレイヤーには触れず、ポップ量 = 高さの新しいレイヤーに作る
     (今の塗りを縮めてポップ量を上げると、揺れも小さくなり、8 ビットのウェイトの階調も粗くなるため)。
     新しいレイヤーはプレビューの間だけ仮に挿入し、アンドゥにも「未保存」にも数えない */

  private inflateSession: {
    layerId: string; original: Uint8Array; area: InflateArea; settings: InflateSettings & { height: number };
    sourcePop: number;
    /** プレビュー中に仮に挿入している新しいレイヤー(同じレイヤーに作るときは null) */
    newLayer: Layer | null;
    /** 新しいレイヤーに作るときの名前(仮に挿入していなくても決めておく) */
    newName: string;
    limited: boolean;
  } | null = null;

  get previewingInflate(): boolean { return !!this.inflateSession; }
  /** 全体ぼかし・膨らませるのプレビュー中か。プレビュー中のウェイトを元に戻したりしないよう、使える操作を絞る */
  get previewing(): boolean { return this.previewingBlur || this.previewingInflate; }
  get inflateState(): InflateState | null {
    const s = this.inflateSession; if (!s) return null;
    return { layerId: s.layerId, area: s.area, settings: s.settings, sourcePop: s.sourcePop, limited: s.limited, newLayer: s.newLayer && { name: s.newLayer.name, pop: s.newLayer.pop } };
  }

  /** 範囲を描き始める(ドラッグの最初の動きで呼ぶ) */
  beginInflateArea(area: InflateArea): boolean {
    const layer = this.activeLayer, doc = this.doc;
    if (this.previewingBlur) { toast('「全体をぼかす」を適用するかキャンセルしてから膨らませてください。', 'warning'); return false; }
    if (!layer || !doc || this.busy) return false;
    if (!layer.visible) { toast('非表示のレイヤーには塗れません。', 'warning'); return false; }
    const st = this.inflateSettings;
    this.inflateSession = {
      layerId: layer.id, original: layer.weights.data.slice(), area: { ...area },
      // 高さの初期値は前回の値、初めてならポップ量と同じ(ポップ量が 0 なら既定のポップ量)
      // 前回の高さは引き継ぐが、このレイヤーのポップ量は超えない(いきなり新しいレイヤーに作らない)
      settings: { ...st, height: layer.pop > 0 ? Math.min(st.height ?? layer.pop, layer.pop) : (st.height ?? LIMITS.pop.def) },
      sourcePop: layer.pop, newLayer: null, newName: nextInflateLayerName(doc), limited: false,
    };
    this.renderInflate();
    this.emit('inflate', 'begin');
    return true;
  }

  updateInflate(patch: { area?: Partial<InflateArea>; settings?: Partial<InflateSettings> }): void {
    const s = this.inflateSession; if (!s) return;
    if (patch.area) s.area = { ...s.area, ...patch.area };
    if (patch.settings) s.settings = { ...s.settings, ...patch.settings, height: patch.settings.height ?? s.settings.height };
    this.renderInflate();
    this.emit('inflate', 'change');
  }

  /**
   * プレビュー用の新しいレイヤーを、範囲を描いたレイヤーのすぐ上に仮に入れる / 外す。
   * 構成が変わったことだけを知らせ(GPU への全面転送とレイヤー一覧の更新)、変更としては数えない
   */
  private setPreviewLayer(on: boolean): void {
    const s = this.inflateSession, doc = this.doc; if (!s || !doc) return;
    if (on && !s.newLayer) {
      const f = this.store.findLayer(s.layerId); if (!f) return;
      const layer = createLayer(doc, s.newName);
      // 揺れ方は元のレイヤーにそろえる(同じ物の一部として揺れるように)
      layer.physics = { ...f.layer.physics, motionParams: { ...f.layer.physics.motionParams } };
      doc.layers.splice(f.index + 1, 0, layer);
      s.newLayer = layer;
      this.store.emit('layers', { docId: doc.id });
    } else if (!on && s.newLayer) {
      const i = doc.layers.indexOf(s.newLayer);
      if (i >= 0) doc.layers.splice(i, 1);
      s.newLayer = null;
      this.store.emit('layers', { docId: doc.id });
    }
  }

  private renderInflate(): void {
    const s = this.inflateSession, doc = this.doc; if (!s || !doc) return;
    const source = this.store.findLayer(s.layerId)?.layer; if (!source) return;
    const st = s.settings;
    // 仮のレイヤーは数えずに、もう1枚足せるか
    const layerCount = doc.layers.length - (s.newLayer ? 1 : 0);
    const over = st.height > s.sourcePop, useNew = over && layerCount < LIMITS.maxLayers;
    s.limited = over && !useNew;
    // 範囲を描いたレイヤーは、新しいレイヤーに作るときは元のまま、そうでなければ元の上に重ねる
    source.weights.data.set(s.original);
    this.store.weightsChanged(s.layerId, source.weights.fullRect, false);
    this.setPreviewLayer(useNew);
    const target = s.newLayer ?? source, wm = target.weights;
    if (s.newLayer) {
      wm.data.fill(0);
      const pop = Math.min(LIMITS.pop.max, Math.ceil(st.height));
      if (s.newLayer.pop !== pop) { s.newLayer.pop = pop; this.store.emit('layer', { layerId: s.newLayer.id, keys: ['pop'] }); }
    }
    const base = s.newLayer ? wm.data.slice() : s.original;
    const a = s.area, kx = wm.width / doc.image.width, ky = wm.height / doc.image.height;
    const level = target.pop > 0 ? Math.min(1, st.height / target.pop) : 0;
    inflateShape(wm, base, {
      kind: st.shape, cx: (a.x / doc.image.width + 0.5) * wm.width, cy: (0.5 - a.y / doc.image.height) * wm.height, rx: a.w / 2 * kx, ry: a.h / 2 * ky,
    }, { level, softness: st.softness, profile: st.profile, blend: st.blend });
    this.store.weightsChanged(target.id, wm.fullRect, false);
  }

  endInflate(apply: boolean): void {
    const s = this.inflateSession, doc = this.doc; if (!s) return;
    const source = this.store.findLayer(s.layerId)?.layer, newLayer = s.newLayer;
    if (!apply || !doc || !source) {
      this.setPreviewLayer(false);
      if (source) { source.weights.data.set(s.original); this.store.weightsChanged(s.layerId, source.weights.fullRect, false); }
      this.inflateSession = null;
      this.emit('inflate', 'end');
      return;
    }
    this.inflateSession = null;
    const st = s.settings;
    this.inflateSettings = { ...st }; // 次に描くときも同じ設定で始める
    const shape = `${st.shape === 'ellipse' ? '楕円' : '矩形'} ${Math.round(s.area.w)}×${Math.round(s.area.h)}px`;
    if (newLayer && !newLayer.weights.data.some(v => v > 0)) {
      // 範囲がすべて画像の外などで何も膨らまなかったときは、空のレイヤーを残さない
      this.inflateSession = s;
      this.endInflate(false);
      toast('変化はありませんでした。');
      return;
    }
    if (newLayer) {
      // 仮に入れたレイヤーをそのまま正式に追加する。戻すとレイヤーごと消え、元のレイヤーは触れていないので元どおり
      const index = doc.layers.indexOf(newLayer);
      this.history.push(new InsertLayer(`膨らませる(${shape}・高さ ${st.height}px・新しいレイヤー「${newLayer.name}」)`, doc.id, newLayer, index));
      this.store.emit('change', undefined);
      this.setActiveLayer(newLayer.id);
    } else {
      const tiles = diffTiles(s.original, source.weights);
      const height = s.limited ? s.sourcePop : st.height; // 上限の枚数で新しいレイヤーを作れないときは、ポップ量で止まる
      if (!tiles.length) toast('変化はありませんでした。');
      else {
        this.history.push(new WeightEdit(`膨らませる(${shape}・高さ ${height}px)`, s.layerId, tiles));
        this.store.emit('change', undefined);
      }
    }
    this.emit('inflate', 'end');
  }

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

  /* ---------- 揺れの切り替えとプリセット(右パネル・上のツールバー・スマホのどこから変えても、ここを通す) ---------- */

  /** 選択中のレイヤーを揺らすか */
  setLayerSwing(on: boolean): void {
    const l = this.activeLayer;
    if (!l || l.physics.enabled === on) return;
    this.history.execute(PatchLayer.from(this.store, l.id, { physics: { ...l.physics, enabled: on } }, '揺れの切替'));
  }

  /** 周期的に自動で揺らすか */
  setAutoSwing(on: boolean): void {
    if (this.project.autoSwing.enabled === on) return;
    this.history.execute(PatchProject.from(this.store, { autoSwing: { ...this.project.autoSwing, enabled: on } }, '自動揺らしの切替'));
  }

  /**
   * 選択中のレイヤーに揺れのプリセットを当てる。材質と揺らし方を変える。
   * 自動揺らしの周期はプロジェクト全体の設定なので、揺れているレイヤーがこのレイヤーだけのときだけ、おすすめの値にする
   * (ほかのレイヤーの揺れ方まで変えないように)。変えるときはまとめて1手
   */
  setPreset(name: PresetName): void {
    const l = this.activeLayer;
    if (!l || l.physics.preset === name) return;
    if (name === 'custom') {
      this.history.execute(PatchLayer.from(this.store, l.id, { physics: { ...l.physics, preset: 'custom' } }, 'プリセット'));
      return;
    }
    const pr = PRESETS[name], label = `プリセット「${pr.label}」`;
    // ほかに揺れているレイヤー(表示中・揺れがオン・塗ってある)があるか。膨らませるのプレビューで仮に入れたレイヤーは数えない
    const temp = this.inflateSession?.newLayer?.id;
    const others = this.doc?.layers.some(o => o.id !== l.id && o.id !== temp && o.visible && o.physics.enabled && o.weights.data.some(v => v > 0)) ?? false;
    const changePeriod = !others && this.project.autoSwing.period !== pr.period;
    this.history.execute(new Batch(label, [
      PatchLayer.from(this.store, l.id, { physics: applyPreset(l.physics, name) }, label),
      ...(changePeriod ? [PatchProject.from(this.store, { autoSwing: { ...this.project.autoSwing, period: pr.period } }, label)] : []),
    ]));
    if (others && this.project.autoSwing.period !== pr.period) {
      toast(`ほかにも揺れているレイヤーがあるので、自動揺らしの周期は変えていません(このプリセットのおすすめは ${pr.period.toFixed(1)} 秒。「アニメーション」タブで変えられます)。`, 'info', 6000);
    } else if (!this.project.autoSwing.enabled) toast('「自動で揺らす」がオフなので、自動では動きません。「つかむ」「揺らす」で揺らすか、自動揺らしをオンにしてください。', 'info', 5000);
    else if (!l.physics.enabled) toast('このレイヤーは「揺れ」がオフです。', 'info');
  }

  /* ---------- 物理と描画のループ ---------- */

  applySwing = (world: PhysicsWorld, doc: Document): void => {
    const k = Math.max(doc.image.width, doc.image.height) / 2;
    doc.layers.forEach((l, i) => {
      const s = world.displacement(l.id), on = l.visible && l.physics.enabled;
      this.stage.setSwing(i, { x: s.x * k, y: s.y * k, z: s.z * k }, on);
      // 塗った範囲の広がり(ためて膨らむ2)。重心はウェイトが変わったときだけ求め直す
      const r = world.spread(l.id);
      this.stage.setSpread(i, r ? this.layerCenter(doc, l) : { x: 0, y: 0 }, r, on);
    });
    // 画像全体の動き(揺らし方「ピストン」)。一時停止中・自動揺らしが切れているときは 0
    const g = world.baseOffset(doc.layers);
    this.stage.setBaseOffset({ x: g.x * k, y: g.y * k, z: g.z * k });
  };

  /** レイヤーのウェイトの重心(画像のローカル座標、元画像のピクセル) */
  private layerCenter(doc: Document, l: Layer): { x: number; y: number } {
    let c = this.centers.get(l.id);
    if (!c) {
      const { u, v } = l.weights.centroidUV();
      this.centers.set(l.id, (c = { x: (u - 0.5) * doc.image.width, y: (v - 0.5) * doc.image.height }));
    }
    return c;
  }

  private recordStep = (): void => {
    const w = this.world, c = this.project.camera, take = this.project.take;
    if (this.takeState === 'playing' && take?.samples.length) {
      // ループ再生: 記録どおりにつかみ・注視点を物理へ入れ、視点を動かす(画角は今のまま)
      const i = this.playIndex % take.samples.length, smp = take.samples[i];
      applySample(w, smp);
      c.yaw = smp.camera.yaw; c.pitch = smp.camera.pitch; c.zoom = smp.camera.zoom; c.target = { ...smp.camera.target };
      this.playIndex = i + 1;
      this.recorder.record({ ...smp, camera: { ...c, target: { ...c.target } } }, () => w.snapshot());
      return;
    }
    // 平行移動でも、「揺らす」で振っても揺らす
    const s = this.shake;
    w.viewTarget = { x: c.target.x + s.x, y: c.target.y + s.y, z: c.target.z + s.z };
    this.recorder.record({
      viewCut: w.viewCut,
      viewTarget: { ...w.viewTarget },
      grab: w.grab ? { ...w.grab } : null,
      grabGains: [...w.grabGains],
      camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, target: { ...c.target } },
    }, () => w.snapshot());
    if (this.takeState === 'recording') {
      // 1フレームで何刻みも進むことがあるので、最長に達したあとの刻みは積まない
      if (this.takeRaw.length < Math.round(TAKE_MAX_SECONDS / PHYSICS_DT)) this.takeRaw.push({
        grab: w.grab ? { ...w.grab } : null, grabGains: [...w.grabGains], viewTarget: { ...w.viewTarget }, viewCut: w.viewCut || undefined,
        camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, target: { ...c.target } },
      });
      // 最長まで記録したら止める(物理を進めている途中なので、止めるのは刻みのあと)
      if (this.takeRaw.length >= Math.round(TAKE_MAX_SECONDS / PHYSICS_DT)) queueMicrotask(() => this.stopRecording(true));
    }
  };

  /* ---------- 操作の記録とループ再生 ---------- */

  /** 記録中なら記録した長さ、それ以外は保存してある記録の長さ(秒) */
  get takeLength(): number { return this.takeState === 'recording' ? this.takeRaw.length * PHYSICS_DT : takeSeconds(this.project.take); }
  /** ループ再生中の位置(秒) */
  get takePosition(): number {
    const n = this.project.take?.samples.length ?? 0;
    return this.takeState === 'playing' && n ? (this.playIndex % n) * PHYSICS_DT : 0;
  }

  private setTakeState(s: TakeState): void { this.takeState = s; this.emit('take', s); }

  /** 記録を始める。つかむ・揺らす・移動・視点の操作を、止めるまで(最長 60 秒)覚える */
  startRecording(): void {
    if (!this.doc || this.takeState === 'recording') return;
    if (this.takeState === 'playing') this.stopTake();
    if (this.paused) this.setPaused(false); // 一時停止中は物理が進まず、記録もされない
    this.takeRaw = [];
    this.setTakeState('recording');
  }

  /** 記録を止めて、ループ再生できる形にして残す(アンドゥできる)。full は最長まで記録して止まったとき */
  stopRecording(full = false): void {
    if (this.takeState !== 'recording') return;
    const take = finalizeTake(this.takeRaw);
    this.takeRaw = [];
    this.setTakeState('idle');
    if (!take) { toast(`記録が短すぎます。「記録」を押したあと、${TAKE_MIN_SECONDS} 秒以上動かしてください。`, 'warning'); return; }
    this.history.execute(new SetTake('操作の記録', this.project.take, take));
    const sec = takeSeconds(take).toFixed(1);
    toast(full ? `最長の ${sec} 秒まで記録したので止めました。` : `${sec} 秒の操作を記録しました。「ループ再生」でくり返し再生できます。`, 'success');
  }

  toggleRecording(): void { if (this.takeState === 'recording') this.stopRecording(); else this.startRecording(); }

  /** 記録した操作を初めからループ再生する。画面を触ると止まる */
  playTake(): void {
    const take = this.project.take;
    if (!take?.samples.length || !this.doc) return;
    if (this.takeState === 'recording') this.stopRecording();
    if (this.paused) this.setPaused(false);
    this.playIndex = 0;
    this.world.cutView(); // 今の視点から記録の初めへ飛ぶ分では揺らさない
    this.world.grab = null; this.world.grabGains.clear();
    this.shake = { x: 0, y: 0, z: 0 };
    if (this.takeState !== 'playing') this.setTakeState('playing');
  }

  /** ループ再生をやめる(記録中なら何もしない)。視点は止めた所のまま */
  stopTake(): void {
    if (this.takeState !== 'playing') return;
    this.world.grab = null; this.world.grabGains.clear();
    this.world.cutView(); // 物理に伝える注視点が記録の値から今の視点へ戻る分では揺らさない
    this.setTakeState('idle');
    this.cameraChanged();
  }

  togglePlay(): void { if (this.takeState === 'playing') this.stopTake(); else this.playTake(); }

  /* ---------- キーフレームから動きを作る ---------- */

  /** 記録がキーフレームから作ったものなら、そのキーフレームを下書きに入れる。reset なら、そうでなくても下書きを空にする */
  private syncKeyDraft(reset = false): void {
    const k = this.project.take?.keys;
    if (k) this.keyDraft = structuredClone([...k]);
    else if (reset) this.keyDraft = [];
    else return;
    this.emit('take', this.takeState);
  }

  private viewKey(): ViewKey {
    const c = this.project.camera;
    return { yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, target: { ...c.target } };
  }

  /** 今の視点を末尾のキーフレームとして足す。時間とつなぎ方は1つ前のフレームに合わせる */
  addKey(): void {
    if (this.keyDraft.length >= MAX_KEYS) return;
    this.stopTake();
    const prev = this.keyDraft.at(-1);
    this.keyDraft.push({ view: this.viewKey(), seconds: prev?.seconds ?? KEY_SECONDS.def, mode: prev?.mode ?? 'smooth' });
    this.emit('take', this.takeState);
  }

  /** i 番目のキーフレームを今の視点で登録し直す */
  setKey(i: number): void {
    const k = this.keyDraft[i];
    if (!k) return;
    this.stopTake();
    k.view = this.viewKey();
    this.emit('take', this.takeState);
  }

  removeKey(i: number): void {
    if (!this.keyDraft[i]) return;
    this.keyDraft.splice(i, 1);
    this.emit('take', this.takeState);
  }

  /** 視点を i 番目のキーフレームへ動かす(確かめる用。その動きでは揺らさない) */
  gotoKey(i: number): void {
    const k = this.keyDraft[i]?.view;
    if (!k) return;
    this.stopTake();
    const c = this.project.camera;
    c.yaw = k.yaw; c.pitch = k.pitch; c.zoom = k.zoom; c.target = { ...k.target };
    this.world.cutView();
    this.cameraChanged();
    this.emit('status', undefined);
  }

  setKeyOption(i: number, patch: Partial<Pick<KeyFrame, 'seconds' | 'mode'>>): void {
    const k = this.keyDraft[i];
    if (!k) return;
    if (patch.seconds !== undefined) k.seconds = Math.max(KEY_SECONDS.min, Math.min(KEY_SECONDS.max, Math.round(patch.seconds * 10) / 10));
    if (patch.mode) k.mode = patch.mode;
    this.emit('take', this.takeState);
  }

  /** キーフレームを順に通ってくり返す記録を作り(今の記録と入れ替え、アンドゥできる)、ループ再生する */
  makeKeyTake(): void {
    if (!this.doc || this.takeState === 'recording') return;
    const take = takeFromKeys(this.keyDraft, this.project.camera.fov);
    if (!take) return;
    this.history.execute(new SetTake('キーフレームから動きを作る', this.project.take, take));
    this.playTake();
  }

  /** 記録を消す(アンドゥできる) */
  clearTake(): void {
    if (!this.project.take) return;
    this.stopTake();
    this.history.execute(new SetTake('操作の記録を消す', this.project.take, null));
  }

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
      if (this.fpsTime >= 0.5) { this.fps = Math.round(this.frames / this.fpsTime); this.frames = 0; this.fpsTime = 0; this.emit('fps', this.fps); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /**
   * 画像全体のずれ(ピストン)を画面上で止める / 戻す。塗りや膨らませる範囲のドラッグの間、当たり判定(pick)が
   * 画像の動きでずれないようにする。物理はそのまま進む。戻すときは、止めていた所から BASE_EASE でならして動きに戻す
   */
  holdImage(on: boolean): void {
    const b = this.base;
    if (on) { b.held ??= { ...b.shown }; return; }
    if (!b.held) return;
    b.fix = { x: b.held.x - b.live.x, y: b.held.y - b.live.y, z: b.held.z - b.live.z };
    b.held = null;
  }

  /** 画像全体が画面上で元の位置からずれているか(ブラシの円を毎フレーム当て直すかの判断に使う) */
  get imageShifted(): boolean { const s = this.base.shown; return !this.view.flat && (s.x !== 0 || s.y !== 0 || s.z !== 0); }

  /** ライブ表示の画像全体のずれを決めて Stage へ入れる(applySwing の後に呼ぶ) */
  private showBase(dt: number, doc: Document): void {
    const w = this.world, b = this.base, k = this.imageLong / 2, g = w.baseOffset(doc.layers);
    const live = { x: g.x * k, y: g.y * k, z: g.z * k };
    // 自動揺らし・一時停止・周期・強さ・動かすレイヤーとその設定が変わると、画像が飛ぶ。その差を fix に入れてならす
    const d = w.baseDriver(doc.layers), a = w.autoSwing;
    const key = d ? `${d.id}|${a.period}|${a.strength}|${JSON.stringify(d.physics.motionParams)}` : '';
    if (key !== b.key) { b.fix.x += b.live.x - live.x; b.fix.y += b.live.y - live.y; b.fix.z += b.live.z - live.z; b.key = key; }
    const e = Math.exp(-dt / BASE_EASE);
    b.fix.x *= e; b.fix.y *= e; b.fix.z *= e;
    if (Math.abs(b.fix.x) + Math.abs(b.fix.y) + Math.abs(b.fix.z) < 0.05) b.fix = { x: 0, y: 0, z: 0 };
    b.live = live;
    b.shown = b.held ? { ...b.held } : { x: live.x + b.fix.x, y: live.y + b.fix.y, z: live.z + b.fix.z };
    this.stage.setBaseOffset(b.shown);
    this.stage.setBaseReach(w.baseReach(doc.layers) * k);
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
    this.showBase(dt, doc);
    if (p) t = p.lap('physics', t, performance.now());
    this.flushWeights();
    if (p) t = p.lap('upload', t, performance.now());
    this.stage.render(this.project.camera, this.multiCam, this.multiOrtho);
    if (p) p.lap('render', t, performance.now());
    this.emit('frame', undefined);
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

/** 膨らませるで作るレイヤーの名前(膨らみ1, 膨らみ2, …のうち、まだ無いもの) */
function nextInflateLayerName(doc: Document): string {
  let n = 1;
  while (doc.layers.some(l => l.name === `膨らみ${n}`)) n++;
  return `膨らみ${n}`;
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
