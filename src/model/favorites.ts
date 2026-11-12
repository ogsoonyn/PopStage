/**
 * お気に入り(揺れと動きの組み合わせ)を作る・今の状態と比べる。DOM と three.js を参照しない。
 * 残すのは全レイヤーのポップ量・重ね方・揺れ、自動揺らし、視点、操作の記録で、画像とウェイトは入れない。
 */
import { newId, type Favorite, type FavoriteLayer, type PhysicsParams, type Project, type Document, type CameraState } from './project';

/** 名前の長さの上限 */
export const FAVORITE_NAME_MAX = 40;

/** 今の状態からお気に入りを作る。id・名前・日時を渡すと、それを使う(上書きするとき) */
export function captureFavorite(
  project: Project, doc: Document, opts: { name: string; playing: boolean; id?: string; createdAt?: string },
): Favorite {
  const c = project.camera;
  return {
    id: opts.id ?? newId('F'),
    name: opts.name,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    layers: doc.layers.map((l): FavoriteLayer => ({ id: l.id, pop: l.pop, blend: l.blend, physics: copyPhysics(l.physics) })),
    autoSwing: { ...project.autoSwing },
    camera: { fov: c.fov, yaw: c.yaw, pitch: c.pitch, zoom: c.zoom, target: { ...c.target } },
    take: project.take,
    playing: opts.playing && !!project.take,
  };
}

export const copyPhysics = (p: PhysicsParams): PhysicsParams => ({ ...p, motionParams: { ...p.motionParams } });

/** 揺れの設定が同じか(揺らし方の固有設定は、キーの並びによらず比べる) */
export function samePhysics(a: PhysicsParams, b: PhysicsParams): boolean {
  if (a.enabled !== b.enabled || a.preset !== b.preset || a.hardness !== b.hardness || a.mass !== b.mass
    || a.weight !== b.weight || a.damping !== b.damping || a.motion !== b.motion) return false;
  const ka = Object.keys(a.motionParams), kb = Object.keys(b.motionParams);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b.motionParams, k) && a.motionParams[k] === b.motionParams[k]);
}

/** レイヤーの設定がお気に入りと同じか */
export function sameLayer(f: FavoriteLayer, l: Pick<FavoriteLayer, 'pop' | 'blend' | 'physics'>): boolean {
  return f.pop === l.pop && f.blend === l.blend && samePhysics(f.physics, l.physics);
}

/**
 * 今の状態がお気に入りと同じか(一覧で印を付ける)。視点は回すたびに変わるので比べない。
 * お気に入りにあるレイヤーがすべて残っていて、同じ設定のときだけ同じとする(後から足したレイヤーは見ない)。
 */
export function favoriteMatches(f: Favorite, project: Project, doc: Document): boolean {
  const a = f.autoSwing, b = project.autoSwing;
  if (a.enabled !== b.enabled || a.period !== b.period || a.strength !== b.strength || f.take !== project.take) return false;
  return f.layers.every(fl => { const l = doc.layers.find(x => x.id === fl.id); return !!l && sameLayer(fl, l); });
}

/** 新しいお気に入りの名前(「お気に入り 1」から、使われていない番号) */
export function nextFavoriteName(list: readonly Favorite[]): string {
  const used = new Set(list.map(f => f.name));
  let n = list.length + 1;
  while (used.has(`お気に入り ${n}`)) n++;
  return `お気に入り ${n}`;
}

/** 視点(回転・ズーム・注視点)を当てる。画角は別にアンドゥできる形で変える */
export function applyView(c: CameraState, from: CameraState): void {
  c.yaw = from.yaw; c.pitch = from.pitch; c.zoom = from.zoom; c.target = { ...from.target };
}
