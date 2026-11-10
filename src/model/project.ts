/**
 * ドキュメントモデル。DOM と Three.js を参照しない。
 * 状態の変更はコマンド(commands/)経由で行い、ここは保持と変更通知だけを担う。
 */
import { Emitter } from '../util/emitter';
import { WeightMap, weightSizeFor, type Rect } from './weightmap';

export interface Vec3 { x: number; y: number; z: number }

/**
 * 揺らし方。自動揺らしのとき、塗った部分を支える土台(アンカー)をどう動かすか。
 * 塗った部分はバネで土台に繋がっていて、遅れて付いてくる(physics/motion.ts)。
 */
export type MotionPattern = 'charge' | 'jiggle' | 'jump' | 'bounce' | 'shiver' | 'float' | 'sway' | 'shake' | 'circle' | 'heartbeat' | 'stretch' | 'none';

export const MOTIONS: Record<MotionPattern, { label: string; desc: string }> = {
  jiggle: { label: '上下に小刻み', desc: '上下に軽くつついて揺らす' },
  jump: { label: 'ジャンプ', desc: '沈み込んで跳び、着地で弾む' },
  bounce: { label: '連続ジャンプ', desc: '小さく弾み続ける' },
  shiver: { label: '震え', desc: '細かく速く震える' },
  float: { label: '漂う', desc: 'ゆっくり8の字に漂う' },
  sway: { label: 'ゆっくり左右', desc: '左右にゆったり揺れる' },
  shake: { label: '左右に振る', desc: '左右に素早く振る' },
  circle: { label: '回転', desc: '円を描いて回る' },
  heartbeat: { label: '鼓動', desc: 'ドクン、ドクンと手前にふくらむ' },
  charge: { label: 'ためて膨らむ', desc: 'ポップ量をぐーっと縮めてから、いっきにぼよんと膨らませる' },
  stretch: { label: '伸びて戻る', desc: 'ゆっくり引き伸ばして、ぱっと離す' },
  none: { label: 'なし(つかむ操作だけ)', desc: '自動では揺らさない' },
};

/**
 * 揺らし方ごとの固有の設定。値は unit が '%' のとき割合(1 = 100%)、'Hz' は周波数、'select' は options の値。
 * 「〜の長さ」「〜の時間」は周期に対する割合。
 */
export interface MotionParamDef {
  key: string;
  label: string;
  unit: '%' | 'Hz' | 'select';
  min: number;
  max: number;
  step: number;
  def: number;
  options?: [number, string][];
  hint?: string;
}

const pct = (key: string, label: string, def: number, max = 3, min = 0, hint?: string): MotionParamDef =>
  ({ key, label, unit: '%', min, max, step: 0.01, def, hint });

export const MOTION_PARAMS: Record<MotionPattern, MotionParamDef[]> = {
  charge: [
    pct('depth', 'ためる深さ', 0.7, 1, 0, 'ポップ量をどこまで縮めるか(100% で平らになる)'),
    pct('time', 'ためる時間', 0.6, 0.9, 0.2, '周期のうち、縮めている時間の割合'),
    pct('bulge', '膨らみの強さ', 0.3, 2, 0, '離した瞬間に、さらに押し出す量(ポップ量に対する割合)。0% でもバネの勢いで少し膨らむ'),
  ],
  jump: [
    pct('height', '高さ', 1),
    pct('crouch', '沈み込み', 0.15, 1, 0, '踏み切る前に沈む深さ(高さに対する割合)'),
    pct('air', '滞空時間', 0.42, 0.85, 0.15, '周期のうち、跳んでいる時間の割合'),
  ],
  bounce: [
    pct('height', '高さ', 1),
    pct('ground', '接地の長さ', 0.3, 0.6, 0.05, '周期のうち、着地している時間の割合'),
  ],
  jiggle: [
    pct('amp', '振れ幅', 1),
    pct('second', '2回目の強さ', 0.6, 1.5),
    pct('width', 'つつく長さ', 0.1, 0.3, 0.04, '1回のつつきにかける時間(周期に対する割合)。短いほど鋭い'),
  ],
  shiver: [
    pct('amp', '振れ幅', 1),
    { key: 'freq', label: '細かさ', unit: 'Hz', min: 2, max: 20, step: 0.5, def: 9, hint: '1秒あたりの震えの回数' },
    pct('vertical', '縦の揺れ', 0.6, 2),
    pct('wave', 'むら', 0.4, 1, 0, '震えの強弱の波'),
  ],
  float: [pct('amp', '振れ幅', 1), pct('side', '横の揺れ', 0.4, 2)],
  sway: [pct('amp', '振れ幅', 1)],
  shake: [pct('amp', '振れ幅', 1), pct('hop', '跳ね上がり', 0.3, 2), pct('width', '振る長さ', 0.12, 0.4, 0.04)],
  circle: [
    pct('radius', '半径', 1),
    { key: 'dir', label: '向き', unit: 'select', min: -1, max: 1, step: 2, def: 1, options: [[1, '反時計回り'], [-1, '時計回り']] },
  ],
  heartbeat: [pct('amp', '膨らみ', 1), pct('second', '2拍目の強さ', 0.7, 1.5), pct('gap', '拍の間隔', 0.2, 0.45, 0.08)],
  stretch: [
    pct('amp', '伸ばす量', 1),
    pct('time', '伸ばす時間', 0.65, 0.9, 0.2),
    { key: 'dir', label: '向き', unit: 'select', min: 0, max: 4, step: 1, def: 0, options: [[0, '上'], [1, '下'], [2, '左'], [3, '右'], [4, '手前']] },
  ],
  none: [],
};

/** 揺らし方の固有設定の値(未設定なら既定値)。保存時のキーは「揺らし方.項目」。 */
export function motionParam(values: Record<string, number> | undefined, motion: MotionPattern, key: string): number {
  const v = values?.[`${motion}.${key}`];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return MOTION_PARAMS[motion].find(d => d.key === key)?.def ?? 0;
}

export type PresetName = 'puru' | 'bain' | 'poyo' | 'buru' | 'fuwa' | 'yura' | 'furi' | 'guru' | 'doki' | 'tame' | 'biyo' | 'custom';

/** 揺れのパラメータ。数値はすべて 0〜1 の正規化値。 */
export interface PhysicsParams {
  enabled: boolean;
  preset: PresetName;
  hardness: number; // 硬さ → バネ定数 k
  mass: number;     // 質量 → m
  weight: number;   // 重さ → 重力の係数
  damping: number;  // おさまり → 減衰係数 c
  motion: MotionPattern; // 揺らし方
  motionParams: Record<string, number>; // 揺らし方ごとの固有設定(キーは「揺らし方.項目」、未設定は既定値)
}

export interface Layer {
  id: string;
  name: string;
  visible: boolean;
  pop: number; // ポップ量(元画像のピクセル単位)
  physics: PhysicsParams;
  weights: WeightMap;
}

export interface ImageAsset {
  bytes: Uint8Array; // 読み込んだバイト列をそのまま持つ
  mime: string;
  ext: string;
  width: number;
  height: number;
}

export interface Document {
  id: string;
  name: string;
  image: ImageAsset;
  position: Vec3;
  rotation: Vec3; // ラジアン
  scale: number;
  meshDensity: number;
  opacity: number;
  layers: Layer[];
}

export interface CameraState {
  fov: number;
  yaw: number;
  pitch: number;
  zoom: number;
  target: Vec3; // 元画像のピクセル単位
}

export interface AutoSwing {
  enabled: boolean;
  period: number;   // 秒
  strength: number; // 0〜1
}

export interface Project {
  background: string | null; // null で透過
  camera: CameraState;
  fps: number;
  autoSwing: AutoSwing;
  documents: Document[];
}

export const LIMITS = {
  maxLayers: 8,
  pop: { min: -500, max: 500, def: 80 },
  density: { min: 16, max: 512, def: 128 },
  fov: { min: 10, max: 90, def: 40 },
  period: { min: 0.3, max: 10, def: 1.2 },
} as const;

export interface Preset {
  label: string;
  desc: string;
  hardness: number;
  mass: number;
  damping: number;
  motion: MotionPattern;
  period: number; // おすすめの自動揺らしの周期(秒)
  params?: Record<string, number>; // 揺らし方の固有設定(項目名だけで書く。省略時は既定値)
}

/** 揺れのプリセット。材質(硬さ・質量・おさまり)と揺らし方の組み合わせ。 */
export const PRESETS: Record<Exclude<PresetName, 'custom'>, Preset> = {
  puru: { label: 'ぷるぷる', desc: '上下につついて、細かく震える余韻が残る', hardness: 0.6, mass: 0.04, damping: 0.13, motion: 'jiggle', period: 1.2 },
  bain: { label: 'ばいんばいん', desc: 'ジャンプして着地すると、どすんと沈んで上下に弾む', hardness: 0.25, mass: 0.25, damping: 0.1, motion: 'jump', period: 1.8 },
  poyo: { label: 'ぽよんぽよん', desc: '小さく弾み続ける', hardness: 0.4, mass: 0.15, damping: 0.19, motion: 'bounce', period: 0.8 },
  buru: { label: 'ぶるぶる', desc: '細かく速く震える', hardness: 0.9, mass: 0.05, damping: 0.3, motion: 'shiver', period: 2 },
  fuwa: { label: 'ふわふわ', desc: 'ゆっくり漂って、すぐに落ち着く', hardness: 0.1, mass: 0.3, damping: 0.6, motion: 'float', period: 3 },
  yura: { label: 'ゆらゆら', desc: '左右にゆったり揺れる', hardness: 0.15, mass: 0.4, damping: 0.25, motion: 'sway', period: 2.5 },
  furi: { label: 'ふりふり', desc: '左右に素早く振る', hardness: 0.45, mass: 0.35, damping: 0.12, motion: 'shake', period: 1.6 },
  guru: { label: 'ぐるぐる', desc: '円を描いて回る', hardness: 0.2, mass: 0.3, damping: 0.3, motion: 'circle', period: 2 },
  doki: { label: 'どきどき', desc: 'ドクン、ドクンと手前にふくらむ', hardness: 0.55, mass: 0.1, damping: 0.35, motion: 'heartbeat', period: 1 },
  tame: { label: 'ためてぼよん', desc: 'ぐーっと縮んでから、いっきにぼよんと膨らんで弾む', hardness: 0.3, mass: 0.2, damping: 0.1, motion: 'charge', period: 2 },
  biyo: { label: 'びよーん', desc: 'ゆっくり引き伸ばされて、離すと大きく弾む', hardness: 0.35, mass: 0.2, damping: 0.08, motion: 'stretch', period: 2.4 },
};

export const PRESET_ORDER = Object.keys(PRESETS) as Exclude<PresetName, 'custom'>[];

/** プリセットの値を物理パラメータに当てはめる(重さと有効/無効はそのまま)。 */
export function applyPreset(p: PhysicsParams, name: Exclude<PresetName, 'custom'>): PhysicsParams {
  const pr = PRESETS[name];
  const motionParams: Record<string, number> = {};
  for (const [k, v] of Object.entries(pr.params ?? {})) motionParams[`${pr.motion}.${k}`] = v;
  return { ...p, preset: name, hardness: pr.hardness, mass: pr.mass, damping: pr.damping, motion: pr.motion, motionParams };
}

let idSeq = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function defaultPhysics(): PhysicsParams {
  const p = PRESETS.puru;
  return { enabled: true, preset: 'puru', hardness: p.hardness, mass: p.mass, weight: 0.15, damping: p.damping, motion: p.motion, motionParams: {} };
}

export function createLayer(doc: Pick<Document, 'image' | 'layers'>, name?: string): Layer {
  const { w, h } = weightSizeFor(doc.image.width, doc.image.height);
  return {
    id: newId('L'),
    name: name ?? `レイヤー${doc.layers.length + 1}`,
    visible: true,
    pop: LIMITS.pop.def,
    physics: defaultPhysics(),
    weights: new WeightMap(w, h),
  };
}

export function cloneLayer(layer: Layer, name: string): Layer {
  return { ...layer, id: newId('L'), name, physics: { ...layer.physics, motionParams: { ...layer.physics.motionParams } }, weights: layer.weights.clone() };
}

export function createDocument(image: ImageAsset, name: string): Document {
  const doc: Document = {
    id: newId('D'), name, image,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: 1,
    meshDensity: LIMITS.density.def, opacity: 1, layers: [],
  };
  doc.layers.push(createLayer(doc));
  return doc;
}

export function defaultCamera(): CameraState {
  return { fov: LIMITS.fov.def, yaw: -0.35, pitch: 0.25, zoom: 1, target: { x: 0, y: 0, z: 0 } };
}

/** 3面図の「自由角度」の初期視点。膨らみが分かるよう斜め上から見る */
export function defaultMultiCamera(): CameraState {
  return { fov: LIMITS.fov.def, yaw: 0.7, pitch: 0.45, zoom: 1.5, target: { x: 0, y: 0, z: 0 } };
}

export function createProject(doc?: Document): Project {
  return {
    background: null,
    camera: defaultCamera(),
    fps: 60,
    autoSwing: { enabled: true, period: LIMITS.period.def, strength: 0.5 },
    documents: doc ? [doc] : [],
  };
}

/* ---------- 変更通知付きの入れ物 ---------- */

export type StoreEvents = {
  replace: Project;                                   // プロジェクトごと差し替え
  project: { keys: (keyof Project)[] };
  document: { docId: string; keys: (keyof Document)[] };
  layer: { layerId: string; keys: (keyof Layer)[] };
  layers: { docId: string };                          // 追加・削除・並べ替え
  weights: { layerId: string; rect: Rect };
  change: void;                                       // いずれかが変わった(自動保存用)
};

export class Store extends Emitter<StoreEvents> {
  project: Project;

  constructor(project: Project = createProject()) {
    super();
    this.project = project;
  }

  get doc(): Document | undefined { return this.project.documents[0]; }

  replace(project: Project): void {
    this.project = project;
    this.emit('replace', project);
    this.emit('change', undefined);
  }

  findLayer(layerId: string): { doc: Document; layer: Layer; index: number } | undefined {
    for (const doc of this.project.documents) {
      const index = doc.layers.findIndex(l => l.id === layerId);
      if (index >= 0) return { doc, layer: doc.layers[index], index };
    }
    return undefined;
  }

  findDoc(docId: string): Document | undefined { return this.project.documents.find(d => d.id === docId); }

  /* 以下はコマンドから呼ぶ低レベル操作 */

  patchProject(patch: Partial<Project>): void {
    Object.assign(this.project, patch);
    this.emit('project', { keys: Object.keys(patch) as (keyof Project)[] });
    this.emit('change', undefined);
  }

  patchDocument(docId: string, patch: Partial<Document>): void {
    const doc = this.findDoc(docId); if (!doc) return;
    Object.assign(doc, patch);
    this.emit('document', { docId, keys: Object.keys(patch) as (keyof Document)[] });
    this.emit('change', undefined);
  }

  patchLayer(layerId: string, patch: Partial<Layer>): void {
    const f = this.findLayer(layerId); if (!f) return;
    Object.assign(f.layer, patch);
    this.emit('layer', { layerId, keys: Object.keys(patch) as (keyof Layer)[] });
    this.emit('change', undefined);
  }

  insertLayer(docId: string, layer: Layer, index: number): void {
    const doc = this.findDoc(docId); if (!doc) return;
    doc.layers.splice(index, 0, layer);
    this.emit('layers', { docId });
    this.emit('change', undefined);
  }

  removeLayer(layerId: string): void {
    const f = this.findLayer(layerId); if (!f) return;
    f.doc.layers.splice(f.index, 1);
    this.emit('layers', { docId: f.doc.id });
    this.emit('change', undefined);
  }

  moveLayer(layerId: string, toIndex: number): void {
    const f = this.findLayer(layerId); if (!f) return;
    f.doc.layers.splice(f.index, 1);
    f.doc.layers.splice(toIndex, 0, f.layer);
    this.emit('layers', { docId: f.doc.id });
    this.emit('change', undefined);
  }

  /** ウェイトの直接書き換え後に呼ぶ(塗りの途中など、アンドゥ記録とは別)。 */
  weightsChanged(layerId: string, rect: Rect, persistent = true): void {
    this.emit('weights', { layerId, rect });
    if (persistent) this.emit('change', undefined);
  }
}
