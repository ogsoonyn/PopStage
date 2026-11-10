/**
 * ドキュメントモデル(4章)。DOM と Three.js を参照しない。
 * 状態の変更はコマンド(commands/)経由で行い、ここは保持と変更通知だけを担う。
 */
import { Emitter } from '../util/emitter';
import { WeightMap, weightSizeFor, type Rect } from './weightmap';

export interface Vec3 { x: number; y: number; z: number }

export type PresetName = 'puru' | 'bain' | 'buru' | 'fuwa' | 'custom';

/** 揺れのパラメータ。数値はすべて 0〜1 の正規化値。 */
export interface PhysicsParams {
  enabled: boolean;
  preset: PresetName;
  hardness: number; // 硬さ → バネ定数 k
  mass: number;     // 質量 → m
  weight: number;   // 重さ → 重力の係数
  damping: number;  // おさまり → 減衰係数 c
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
  period: { min: 0.3, max: 10, def: 1.6 },
} as const;

export const PRESETS: Record<Exclude<PresetName, 'custom'>, { label: string; hardness: number; mass: number; damping: number }> = {
  puru: { label: 'ぷるぷる', hardness: 0.45, mass: 0.35, damping: 0.12 },
  bain: { label: 'ばいんばいん', hardness: 0.15, mass: 0.8, damping: 0.08 },
  buru: { label: 'ぶるぶる', hardness: 0.9, mass: 0.1, damping: 0.3 },
  fuwa: { label: 'ふわふわ', hardness: 0.12, mass: 0.2, damping: 0.7 },
};

let idSeq = 0;
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function defaultPhysics(): PhysicsParams {
  const p = PRESETS.puru;
  return { enabled: true, preset: 'puru', hardness: p.hardness, mass: p.mass, weight: 0.15, damping: p.damping };
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
