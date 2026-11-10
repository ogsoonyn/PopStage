/**
 * ウェイトマップ用の最小限の PNG 読み書き。DOM に依存しないので単体テストできる。
 * 書き出しは 8ビットグレースケール。読み込みはグレー / グレー+α / RGB / RGBA / パレット(各8・16ビット、
 * インターレース無し)に対応し、1チャンネルへ変換する。外部のペイントソフトで編集したPNGを戻せるようにするため。
 */
import { zlibSync, unzlibSync } from 'fflate';

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** 読み込めるウェイト PNG の一辺の上限。ウェイトは 1024 までに縮めるので、余裕をみてもこれで足りる */
export const MAX_PNG_SIDE = 4096;
/** 展開後の画像データの上限(バイト)。確保する前にこれで弾く */
export const MAX_PNG_RAW = 64 << 20;

/** PNG のヘッダ(IHDR)から寸法を読む。PNG でなければ null */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** 8ビットのグレースケールPNGを作る。行ごとに Sub フィルタを掛ける。 */
export function encodeGrayPng(width: number, height: number, data: Uint8Array): Uint8Array {
  if (data.length !== width * height) throw new Error('size mismatch');
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 0; // bit depth 8, grayscale
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width + 1), r = y * width;
    raw[o] = 1;
    raw[o + 1] = data[r];
    for (let x = 1; x < width; x++) raw[o + 1 + x] = (data[r + x] - data[r + x - 1]) & 0xff;
  }
  const parts = [new Uint8Array(SIG), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export interface GrayImage { width: number; height: number; data: Uint8Array }

/** PNG を1チャンネル(輝度)へ読み込む。対応外の形式は例外を投げる。 */
export function decodePngToGray(bytes: Uint8Array): GrayImage {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (p + 8 <= bytes.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const data = bytes.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8); height = dv.getUint32(p + 12);
      depth = data[8]; ctype = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!width || !height) throw new Error('PNG: IHDR missing');
  if (width > MAX_PNG_SIDE || height > MAX_PNG_SIDE) throw new Error(`PNG: ${width}x${height} is too large`);
  if (interlace) throw new Error('PNG: interlaced images are not supported');
  if (depth !== 8 && depth !== 16) throw new Error(`PNG: bit depth ${depth} is not supported`);
  if (ctype === 3 && (depth !== 8 || !palette)) throw new Error('PNG: unsupported palette image');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error(`PNG: color type ${ctype} is not supported`);

  const total = idat.reduce((s, d) => s + d.length, 0), comp = new Uint8Array(total);
  let o = 0; for (const d of idat) { comp.set(d, o); o += d.length; }
  const bpp = channels * (depth / 8), stride = width * bpp;
  // 展開後の大きさは寸法から決まるので、その大きさの出力先を渡して、それ以上は展開させない
  const expected = (stride + 1) * height;
  if (expected > MAX_PNG_RAW) throw new Error(`PNG: ${width}x${height} is too large`);
  const raw = unzlibSync(comp, { out: new Uint8Array(expected) });
  if (raw.length < expected) throw new Error('PNG: image data is truncated');
  const img = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? img[dst + x - bpp] : 0, b = y > 0 ? img[dst - stride + x] : 0, c = x >= bpp && y > 0 ? img[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      switch (f) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; }
        default: throw new Error(`PNG: bad filter ${f}`);
      }
      img[dst + x] = v & 0xff;
    }
  }
  const out = new Uint8Array(width * height), step = depth / 8;
  for (let i = 0; i < width * height; i++) {
    const s = i * bpp;
    if (ctype === 0 || ctype === 4) out[i] = img[s];
    else if (ctype === 3) { const k = img[s] * 3; out[i] = lum(palette![k], palette![k + 1], palette![k + 2]); }
    else out[i] = lum(img[s], img[s + step], img[s + 2 * step]);
  }
  return { width, height, data: out };
}

const lum = (r: number, g: number, b: number) => Math.round(0.299 * r + 0.587 * g + 0.114 * b);
