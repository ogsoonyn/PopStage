/**
 * ドキュメントモデル(4章)。DOM と Three.js を参照しない。
 * 状態の変更はコマンド(commands/)経由で行い、ここは保持と変更通知だけを担う。
 */
import { Emitter } from '../util/emitter';
import { WeightMap, weightSizeFor, type Rect } from './weightmap';

export interface Vec3 { x: number; y: number; z: number }

/**
 * 揺らし方。自動揺らしのとき、塗った部分を支える土台(アンカー)をどう動かすか。
 * 塗った部分はバネで土台に繋がっていて、遅れて付いてくる(physics/motion.ts)。
 */
export type MotionPattern = 'jiggle' | 'jump' | 'bounce' | 'shiver' | 'float' | 'sway' | 'shake' | 'circle' | 'heartbeat' | 'stretch' | 'none';

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
  stretch: { label: '伸びて戻る', desc: 'ゆっくり引き伸ばして、ぱっと離す' },
  none: { label: 'なし(つかむ操作だけ)', desc: '自動では揺らさない' },
};

export type PresetName = 'puru' | 'bain' | 'poyo' | 'buru' | 'fuwa' | 'yura' | 'furi' | 'guru' | 'doki' | 'biyo' | 'custom';

/** 揺れのパラメータ。数値はすべて 0〜1 の正規化値。 */
export interface PhysicsParams {
  enabled: boolean;
  preset: PresetName;
  hardness: number; // 硬さ → バネ定数 k
  mass: number;     // 質量 → m
  weight: number;   // 重さ → 重力の係数
  damping: number;  // おさまり → 減衰係数 c
  motion: MotionPattern; // 揺らし方
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
}

/** 揺れのプリセット(7章)。材質(硬さ・質量・おさまり)と揺らし方の組み合わせ。 */
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
  biyo: { label: 'びよーん', desc: 'ゆっくり引き伸ばされて、離すと大きく弾む', hardness: 0.35, mass: 0.2, damping: 0.08, motion: 'stretch', period: 2.4 },
};

export const PRESET_ORDER = Object.keys(PRESETS) as Exclude<PresetName, 'custom'>[];

/** プリセットの値を物理パラメータに当てはめる(重さと有効/無効はそのまま)。 */
export function applyPreset(p: PhysicsParams, name: Exclude<PresetName, 'custom'>): PhysicsParams {
  const pr = PRESETS[name];
  return { ...p, preset: name, hardness: pr.hardness, mass: pr.mass, damping: pr.damping, motion: pr.motion };
}

let idSeq = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function defaultPhysics(): PhysicsParams {
  const p = PRESETS.puru;
  return { enabled: true, preset: 'puru', hardness: p.hardness, mass: p.mass, weight: 0.15, damping: p.damping, motion: p.motion };
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
  return { ...layer, id: newId('L'), name, physics: { ...layer.physics }, weights: layer.weights.clone() };
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
