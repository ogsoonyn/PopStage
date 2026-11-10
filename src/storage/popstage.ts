/**
 * .popstage 形式。ZIP の中に project.json、元画像、ウェイトマップ(グレースケールPNG)、サムネイルを入れる。
 * DOM に依存しない(画像のデコードが必要な場合だけ呼び出し側から関数を渡す)。
 */
import { zipSync, unzipSync, strToU8, strFromU8, type Zippable } from 'fflate';
import {
  LIMITS, PRESETS, MOTIONS, MOTION_PARAMS, createProject, createLayer, defaultCamera, newId,
  type Project, type Document, type Layer, type PhysicsParams, type PresetName, type MotionPattern,
} from '../model/project';
import { WeightMap, weightSizeFor } from '../model/weightmap';
import { encodeGrayPng, decodePngToGray, readPngSize, MAX_PNG_SIDE, type GrayImage } from './png';

export const FORMAT_VERSION = 1;
export const FILE_EXTENSION = '.popstage';

/** 展開する1ファイルあたりの上限(バイト)。ZIP 爆弾でメモリを使い切らないよう、宣言サイズで弾く */
export const UNZIP_LIMITS = { json: 16 << 20, image: 256 << 20, weights: 64 << 20, thumbnail: 8 << 20, total: 512 << 20 };

/** 読み込むドキュメント数の上限(アプリが使うのは先頭だけだが、形式としては複数持てる) */
const MAX_DOCUMENTS = 8;

/** プロトタイプを辿らずに、自前のキーかどうかを調べる(`constructor` などを通さない) */
const own = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** 背景色は #rrggbb だけを受け付ける(CSS に入るので、url() などを通さない) */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/* ---------- project.json の形 ---------- */

interface LayerJson {
  id: string; name: string; visible: boolean; pop: number; physics: PhysicsParams;
  weights: { path: string; width: number; height: number };
}
interface DocumentJson {
  id: string; name: string;
  image: { path: string; mime: string; width: number; height: number };
  position: Project['documents'][number]['position']; rotation: Project['documents'][number]['rotation'];
  scale: number; meshDensity: number; opacity: number; layers: LayerJson[];
}
export interface ProjectJson {
  formatVersion: number;
  app: 'PopStage';
  savedAt: string;
  project: Pick<Project, 'background' | 'camera' | 'fps' | 'autoSwing'>;
  documents: DocumentJson[];
}

/** 古い版から順に変換する。キーは「この版から次の版へ」の変換。 */
const MIGRATIONS: Record<number, (j: Record<string, unknown>) => Record<string, unknown>> = {
  // 例: 1: j => ({ ...j, formatVersion: 2, ... }),
};

export function migrate(json: Record<string, unknown>): ProjectJson {
  let v = Number(json.formatVersion);
  if (!Number.isInteger(v) || v < 1) throw new Error('project.json の formatVersion が不正です');
  if (v > FORMAT_VERSION) throw new Error(`このファイルは新しい版(${v})で保存されています。アプリを更新してください。`);
  while (v < FORMAT_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) throw new Error(`formatVersion ${v} からの変換がありません`);
    json = m(json); v = Number(json.formatVersion);
  }
  return json as unknown as ProjectJson;
}

/* ---------- 保存 ---------- */

export function serializeProject(project: Project, opts: { thumbnail?: Uint8Array } = {}): Uint8Array {
  const files: Zippable = {};
  const docs: DocumentJson[] = project.documents.map((doc, di) => {
    const imagePath = `images/doc-${di}.${doc.image.ext}`;
    files[imagePath] = [doc.image.bytes, { level: 0 }];
    return {
      id: doc.id, name: doc.name,
      image: { path: imagePath, mime: doc.image.mime, width: doc.image.width, height: doc.image.height },
      position: { ...doc.position }, rotation: { ...doc.rotation }, scale: doc.scale,
      meshDensity: doc.meshDensity, opacity: doc.opacity,
      layers: doc.layers.map((layer, li) => {
        const path = `weights/doc-${di}-layer-${li}.png`;
        files[path] = [encodeGrayPng(layer.weights.width, layer.weights.height, layer.weights.data), { level: 0 }];
        return {
          id: layer.id, name: layer.name, visible: layer.visible, pop: layer.pop, physics: { ...layer.physics, motionParams: { ...layer.physics.motionParams } },
          weights: { path, width: layer.weights.width, height: layer.weights.height },
        };
      }),
    };
  });
  const json: ProjectJson = {
    formatVersion: FORMAT_VERSION, app: 'PopStage', savedAt: new Date().toISOString(),
    project: { background: project.background, camera: structuredClone(project.camera), fps: project.fps, autoSwing: { ...project.autoSwing } },
    documents: docs,
  };
  files['project.json'] = strToU8(JSON.stringify(json, null, 2));
  if (opts.thumbnail) files['thumbnail.png'] = [opts.thumbnail, { level: 0 }];
  return zipSync(files, { level: 6 });
}

/* ---------- 読み込み ---------- */

export interface LoadOptions {
  /** 内蔵デコーダで読めないPNG(インターレース等)のための代替デコーダ */
  decodeFallback?: (bytes: Uint8Array) => Promise<GrayImage>;
}

const num = (v: unknown, min: number, max: number, def: number) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : def;
  return Math.max(min, Math.min(max, n));
};
const unit = (v: unknown, def: number) => num(v, 0, 1, def);
const str = (v: unknown, def: string) => (typeof v === 'string' ? v : def);
const vec = (v: unknown) => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { x: num(o.x, -1e6, 1e6, 0), y: num(o.y, -1e6, 1e6, 0), z: num(o.z, -1e6, 1e6, 0) };
};

/** 揺らし方の固有設定。知らない項目は捨て、範囲外は丸め、選択式は選択肢に無い値を捨てる。 */
function motionParamsFrom(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const [m, k] = key.split('.');
    const def = own(MOTION_PARAMS, m) ? MOTION_PARAMS[m as MotionPattern].find(d => d.key === k) : undefined;
    if (!def || typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    if (def.options) { if (def.options.some(([val]) => val === raw)) out[key] = raw; }
    else out[key] = Math.max(def.min, Math.min(def.max, raw));
  }
  return out;
}

function physicsFrom(v: unknown): PhysicsParams {
  const o = (v ?? {}) as Record<string, unknown>;
  const preset: PresetName = o.preset === 'custom' || own(PRESETS, o.preset) ? (o.preset as PresetName) : 'custom';
  const base = PRESETS.puru;
  // 揺らし方の項目が無い古いファイルは、プリセットから補う。カスタムならこれまでの動き(左右に振る)にする
  const motion: MotionPattern = own(MOTIONS, o.motion) ? (o.motion as MotionPattern)
    : preset !== 'custom' ? PRESETS[preset].motion : 'shake';
  return {
    enabled: o.enabled !== false, preset,
    hardness: unit(o.hardness, base.hardness), mass: unit(o.mass, base.mass),
    weight: unit(o.weight, 0.15), damping: unit(o.damping, base.damping), motion,
    motionParams: motionParamsFrom(o.motionParams),
  };
}

export async function deserializeProject(bytes: Uint8Array, opts: LoadOptions = {}): Promise<{ project: Project; thumbnail?: Uint8Array }> {
  // まず project.json だけを展開し、そこに書かれたファイルだけを上限付きで展開する
  const pj = unzipEntries(bytes, new Map([['project.json', UNZIP_LIMITS.json]]))['project.json'];
  if (!pj) throw new Error('project.json が見つかりません');
  let parsed: unknown;
  try { parsed = JSON.parse(strFromU8(pj)); } catch { throw new Error('project.json を読めませんでした(壊れています)'); }
  if (!parsed || typeof parsed !== 'object') throw new Error('project.json の形式が不正です');
  const json = migrate(parsed as Record<string, unknown>);
  // 実際に読む分(ドキュメントとレイヤーの上限まで)のファイルだけを展開する
  const isObj = <T>(v: unknown): v is T => !!v && typeof v === 'object';
  const docsJson = (Array.isArray(json.documents) ? json.documents : []).filter(isObj<DocumentJson>).slice(0, MAX_DOCUMENTS);
  const layersOf = (dj: DocumentJson) => (Array.isArray(dj.layers) ? dj.layers : []).filter(isObj<LayerJson>).slice(0, LIMITS.maxLayers);
  const wanted = new Map<string, number>();
  for (const dj of docsJson) {
    if (typeof dj?.image?.path === 'string') wanted.set(dj.image.path, UNZIP_LIMITS.image);
    for (const lj of layersOf(dj)) {
      if (typeof lj?.weights?.path === 'string') wanted.set(lj.weights.path, UNZIP_LIMITS.weights);
    }
  }
  // サムネイルは読み込みに要らないので、大きすぎるときは黙って捨てる
  const files = unzipEntries(bytes, wanted, new Map([['thumbnail.png', UNZIP_LIMITS.thumbnail]]));

  const project = createProject();
  const p = json.project ?? {} as ProjectJson['project'];
  const cam = defaultCamera(), c = (p.camera ?? {}) as Partial<typeof cam>;
  project.background = typeof p.background === 'string' && HEX_COLOR.test(p.background) ? p.background : null;
  project.camera = {
    fov: num(c.fov, LIMITS.fov.min, LIMITS.fov.max, cam.fov), yaw: num(c.yaw, -1e3, 1e3, cam.yaw),
    pitch: num(c.pitch, -1.5, 1.5, cam.pitch), zoom: num(c.zoom, 0.05, 20, cam.zoom), target: vec(c.target),
  };
  project.fps = 60;
  project.autoSwing = {
    enabled: p.autoSwing?.enabled !== false,
    period: num(p.autoSwing?.period, LIMITS.period.min, LIMITS.period.max, LIMITS.period.def),
    strength: unit(p.autoSwing?.strength, 0.5),
  };

  // ID はレイヤーやドキュメントを探す鍵なので、空・重複していたら振り直す
  const seenIds = new Set<string>();
  const uniqueId = (v: unknown, prefix: string) => {
    let id = typeof v === 'string' && v ? v : newId(prefix);
    while (seenIds.has(id)) id = newId(prefix);
    seenIds.add(id);
    return id;
  };
  for (const dj of docsJson) {
    const imgBytes = own(files, dj.image?.path) ? files[dj.image.path] : undefined;
    if (!imgBytes) throw new Error(`画像 ${dj.image?.path} が見つかりません`);
    const ext = dj.image.path.split('.').pop() ?? 'png';
    const width = Math.round(num(dj.image.width, 1, 1 << 15, 1)), height = Math.round(num(dj.image.height, 1, 1 << 15, 1));
    const doc: Document = {
      id: uniqueId(dj.id, 'D'), name: str(dj.name, '画像'),
      image: { bytes: imgBytes, mime: str(dj.image.mime, 'image/png'), ext, width, height },
      position: vec(dj.position), rotation: vec(dj.rotation), scale: num(dj.scale, 0.01, 100, 1),
      meshDensity: Math.round(num(dj.meshDensity, LIMITS.density.min, LIMITS.density.max, LIMITS.density.def)),
      opacity: unit(dj.opacity, 1), layers: [],
    };
    const ws = weightSizeFor(width, height);
    for (const lj of layersOf(dj)) {
      const wb = own(files, lj.weights?.path) ? files[lj.weights.path] : undefined;
      let weights = new WeightMap(ws.w, ws.h);
      if (wb) {
        let g: GrayImage;
        try { g = decodePngToGray(wb); }
        catch (e) {
          // 内蔵デコーダで読めない PNG だけブラウザに任せる。寸法が大きすぎるものは任せない
          const size = readPngSize(wb);
          if (!opts.decodeFallback || !size || size.width > MAX_PNG_SIDE || size.height > MAX_PNG_SIDE) throw e;
          g = await opts.decodeFallback(wb);
        }
        weights = WeightMap.resampled(new WeightMap(g.width, g.height, g.data), ws.w, ws.h);
      }
      const layer: Layer = {
        id: uniqueId(lj.id, 'L'), name: str(lj.name, `レイヤー${doc.layers.length + 1}`),
        visible: lj.visible !== false, pop: num(lj.pop, LIMITS.pop.min, LIMITS.pop.max, LIMITS.pop.def),
        physics: physicsFrom(lj.physics), weights,
      };
      doc.layers.push(layer);
    }
    // レイヤーが1枚も無いと塗れないので、空のレイヤーを1枚用意する
    if (!doc.layers.length) { const l = createLayer(doc); seenIds.add(l.id); doc.layers.push(l); }
    project.documents.push(doc);
  }
  return { project, thumbnail: files['thumbnail.png'] };
}

/**
 * wanted に挙げたファイルだけを展開する。宣言サイズが1ファイルの上限、または合計の上限を超えたら読み込みをやめる。
 * optional に挙げたファイルは、上限を超えていれば展開せずに捨てる。
 * 先に宣言サイズだけを調べてから展開するので、上限を超えるファイルのためにメモリを確保することはない。
 */
function unzipEntries(bytes: Uint8Array, wanted: Map<string, number>, optional = new Map<string, number>()): Record<string, Uint8Array> {
  const broken = () => new Error('.popstage ファイルを展開できませんでした(壊れているか、形式が違います)');
  // 1回目: 展開せず、展開する予定のエントリの宣言サイズを調べる(同じ名前が重なっていてもすべて数える)
  const tooLarge: string[] = [], skip = new Set<string>();
  let total = 0;
  try {
    unzipSync(bytes, {
      filter: f => {
        const must = wanted.get(f.name), opt = optional.get(f.name);
        // 無圧縮のエントリは宣言サイズに関係なく圧縮後のサイズ分をコピーするので、大きい方で数える
        const size = Math.max(f.size, f.originalSize);
        if (must !== undefined) {
          if (size > must) tooLarge.push(f.name);
          total += size;
        } else if (opt !== undefined) {
          if (size > opt) skip.add(f.name); else total += size;
        }
        return false;
      },
    });
  } catch { throw broken(); }
  if (total > UNZIP_LIMITS.total) throw new Error('.popstage の中身が大きすぎます(展開後の合計が上限を超えています)');
  if (tooLarge.length) throw new Error(`.popstage の中のファイルが大きすぎます(${tooLarge.join(', ')})`);
  // 2回目: 調べた分だけを展開する
  try {
    return unzipSync(bytes, { filter: f => (wanted.has(f.name) || optional.has(f.name)) && !skip.has(f.name) });
  } catch { throw broken(); }
}
