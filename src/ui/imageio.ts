/** 画像のデコードとサムネイル。DOM(Canvas)を使うので Model からは分けておく。 */
import type { ImageAsset } from '../model/project';
import type { GrayImage } from '../storage/png';

export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export function isImageFile(f: File): boolean { return f.type in IMAGE_TYPES || /\.(png|jpe?g|webp)$/i.test(f.name); }
export function isProjectFile(f: File): boolean { return /\.popstage$/i.test(f.name); }

export async function fileToAsset(file: File): Promise<ImageAsset> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type in IMAGE_TYPES ? file.type : sniffMime(bytes);
  if (!mime) throw new Error('PNG / JPEG / WebP の画像を選んでください。');
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(new Blob([bytes], { type: mime })); }
  catch { throw new Error('画像を読み込めませんでした(壊れているか、対応していない形式です)。'); }
  const asset: ImageAsset = { bytes, mime, ext: IMAGE_TYPES[mime], width: bmp.width, height: bmp.height };
  bmp.close();
  return asset;
}

function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** 表示用に、最大 maxSize に縮めたキャンバスへ描く。画像が壊れていれば日本語のメッセージで例外を投げる。 */
export async function decodeForDisplay(asset: ImageAsset, maxSize: number): Promise<HTMLCanvasElement> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([asset.bytes as BlobPart], { type: asset.mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    throw new Error('画像を読み込めませんでした(壊れているか、対応していない形式です)。');
  }
  const s = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c;
}

/** キャンバスのアルファを w×h で取り出す(「アルファから生成」用)。 */
export function canvasAlpha(c: HTMLCanvasElement, w: number, h: number): Uint8Array {
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  const g = t.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}

/** 内蔵デコーダで読めないPNG(インターレース等)をブラウザで読む。 */
export async function browserDecodeGray(bytes: Uint8Array): Promise<GrayImage> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: 'image/png' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0); bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height).data, out = new Uint8Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  return { width: c.width, height: c.height, data: out };
}

export function rgbaToPng(rgba: Uint8ClampedArray, w: number, h: number): Promise<Uint8Array> {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, h); img.data.set(rgba); g.putImageData(img, 0, 0);
  return new Promise((res, rej) => c.toBlob(async b => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('PNG化に失敗しました'))), 'image/png'));
}

/** レイヤー一覧用の小さなウェイト画像 */
export function drawWeightThumb(canvas: HTMLCanvasElement, data: Uint8Array, w: number, h: number): void {
  const s = Math.min(canvas.width / w, canvas.height / h);
  const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(tw, th);
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor((y + 0.5) / s));
    for (let x = 0; x < tw; x++) {
      const v = data[sy * w + Math.min(w - 1, Math.floor((x + 0.5) / s))], i = (y * tw + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 51 + v * 0.8; img.data[i + 2] = 128 + v * 0.5; img.data[i + 3] = 40 + v * 0.84;
    }
  }
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.putImageData(img, Math.floor((canvas.width - tw) / 2), Math.floor((canvas.height - th) / 2));
}
