/**
 * .popstage 形式(4章)。ZIP の中に project.json、元画像、ウェイトマップ(グレースケールPNG)、サムネイルを入れる。
 * DOM に依存しない(画像のデコードが必要な場合だけ呼び出し側から関数を渡す)。
 */
import { zipSync, unzipSync, strToU8, strFromU8, type Zippable } from 'fflate';
import {
  LIMITS, PRESETS, createProject, defaultCamera, newId,
  type Project, type Document, type Layer, type PhysicsParams, type PresetName,
} from '../model/project';
import { WeightMap, weightSizeFor } from '../model/weightmap';
import { encodeGrayPng, decodePngToGray, type GrayImage } from './png';

export const FORMAT_VERSION = 1;
export const FILE_EXTENSION = '.popstage';

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
          id: layer.id, name: layer.name, visible: layer.visible, pop: layer.pop, physics: { ...layer.physics },
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

function physicsFrom(v: unknown): PhysicsParams {
  const o = (v ?? {}) as Record<string, unknown>;
  const preset = (['puru', 'bain', 'buru', 'fuwa', 'custom'] as PresetName[]).includes(o.preset as PresetName) ? (o.preset as PresetName) : 'custom';
  const base = PRESETS.puru;
  return {
    enabled: o.enabled !== false, preset,
    hardness: unit(o.hardness, base.hardness), mass: unit(o.mass, base.mass),
    weight: unit(o.weight, 0.15), damping: unit(o.damping, base.damping),
  };
}

export async function deserializeProject(bytes: Uint8Array, opts: LoadOptions = {}): Promise<{ project: Project; thumbnail?: Uint8Array }> {
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error('.popstage ファイルを展開できませんでした(壊れているか、形式が違います)'); }
  const pj = files['project.json'];
  if (!pj) throw new Error('project.json が見つかりません');
  const json = migrate(JSON.parse(strFromU8(pj)));

  const project = createProject();
  const p = json.project ?? {} as ProjectJson['project'];
  const cam = defaultCamera(), c = (p.camera ?? {}) as Partial<typeof cam>;
  project.background = typeof p.background === 'string' ? p.background : null;
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

  for (const dj of json.documents ?? []) {
    const imgBytes = files[dj.image?.path];
    if (!imgBytes) throw new Error(`画像 ${dj.image?.path} が見つかりません`);
    const ext = dj.image.path.split('.').pop() ?? 'png';
    const width = Math.round(num(dj.image.width, 1, 1 << 15, 1)), height = Math.round(num(dj.image.height, 1, 1 << 15, 1));
    const doc: Document = {
      id: str(dj.id, newId('D')), name: str(dj.name, '画像'),
      image: { bytes: imgBytes, mime: str(dj.image.mime, 'image/png'), ext, width, height },
      position: vec(dj.position), rotation: vec(dj.rotation), scale: num(dj.scale, 0.01, 100, 1),
      meshDensity: Math.round(num(dj.meshDensity, LIMITS.density.min, LIMITS.density.max, LIMITS.density.def)),
      opacity: unit(dj.opacity, 1), layers: [],
    };
    const ws = weightSizeFor(width, height);
    for (const lj of (dj.layers ?? []).slice(0, LIMITS.maxLayers)) {
      const wb = files[lj.weights?.path];
      let weights = new WeightMap(ws.w, ws.h);
      if (wb) {
        let g: GrayImage;
        try { g = decodePngToGray(wb); }
        catch (e) { if (!opts.decodeFallback) throw e; g = await opts.decodeFallback(wb); }
        weights = WeightMap.resampled(new WeightMap(g.width, g.height, g.data), ws.w, ws.h);
      }
      const layer: Layer = {
        id: str(lj.id, newId('L')), name: str(lj.name, `レイヤー${doc.layers.length + 1}`),
        visible: lj.visible !== false, pop: num(lj.pop, LIMITS.pop.min, LIMITS.pop.max, LIMITS.pop.def),
        physics: physicsFrom(lj.physics), weights,
      };
      doc.layers.push(layer);
    }
    project.documents.push(doc);
  }
  return { project, thumbnail: files['thumbnail.png'] };
}
