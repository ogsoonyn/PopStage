/**
 * 書き込み専用の小さな ZIP 作成(無圧縮か deflate のみ、ZIP64 なし)。DOM に依存しない。
 *
 * fflate の zipSync は呼ぶたびに全ファイルの CRC32 を計算し、1つの配列へコピーする。
 * 自動保存では元画像(数十MB になることがある)が毎回同じなのに、そのたびにメインスレッドが
 * 数十ミリ秒止まっていた。ここでは、変わらないデータ(stable)の CRC を覚えておき、
 * 出力も「ヘッダとデータの並び」のまま返して、呼び出し側でコピーせずに Blob にできるようにする。
 */
import { deflateSync, strToU8, type DeflateOptions } from 'fflate';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** 0 で無圧縮。1〜9 で deflate */
  level?: number;
  /** 中身を書き換えない配列か(true なら CRC を覚えて使い回す) */
  stable?: boolean;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256 * 4);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  // 4バイトずつ進める表(slicing-by-4)
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 4; k++) { c = t[c & 0xff] ^ (c >>> 8); t[k * 256 + n] = c; }
  }
  return t;
})();

/** CRC32(ZIP・PNG と同じ多項式) */
export function crc32(bytes: Uint8Array): number {
  const t = CRC_TABLE, n = bytes.length;
  let c = -1, i = 0;
  for (const end = n & ~3; i < end; i += 4) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c = t[768 + (c & 0xff)] ^ t[512 + ((c >>> 8) & 0xff)] ^ t[256 + ((c >>> 16) & 0xff)] ^ t[c >>> 24];
  }
  for (; i < n; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const stableCrc = new WeakMap<Uint8Array, number>();
/** 変わらないデータを圧縮した結果(自動保存のたびに圧縮し直さない) */
const stableBody = new WeakMap<Uint8Array, { level: number; body: Uint8Array }>();
function bodyOf(e: ZipEntry, level: number): Uint8Array {
  if (level <= 0) return e.data;
  const hit = e.stable ? stableBody.get(e.data) : undefined;
  if (hit && hit.level === level) return hit.body;
  const body = deflateSync(e.data, { level: level as DeflateOptions['level'] });
  if (e.stable) stableBody.set(e.data, { level, body });
  return body;
}
/** 計算した回数(テストで、使い回しが効いているかを確かめる) */
export const crcStats = { computed: 0 };

function crcOf(e: ZipEntry): number {
  if (e.stable) { const c = stableCrc.get(e.data); if (c !== undefined) return c; }
  crcStats.computed++;
  const c = crc32(e.data);
  if (e.stable) stableCrc.set(e.data, c);
  return c;
}

function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * ZIP をヘッダとデータの並びとして作る。つなげれば ZIP ファイルになる。
 * 無圧縮のエントリは、渡した配列をそのまま並びに入れる(コピーしない)。
 */
export function zipParts(entries: readonly ZipEntry[], when = new Date()): Uint8Array[] {
  const { time, date } = dosTime(when);
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = strToU8(e.name), utf8 = name.length !== e.name.length;
    const level = e.level ?? 0;
    const crc = crcOf(e);
    const body = bodyOf(e, level);
    const method = level > 0 ? 8 : 0, flags = utf8 ? 0x800 : 0;
    if (offset + 30 + name.length + body.length > 0xffffffff) throw new Error('ZIP が大きすぎます(4GB 以上)');
    const lh = new Uint8Array(30 + name.length), l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, flags, true); l.setUint16(8, method, true);
    l.setUint16(10, time, true); l.setUint16(12, date, true); l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true); l.setUint32(22, e.data.length, true); l.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length), c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, flags, true);
    c.setUint16(10, method, true); c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true); c.setUint32(24, e.data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);
    parts.push(lh, body); central.push(ch);
    offset += lh.length + body.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const end = new Uint8Array(22), d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true); d.setUint16(8, entries.length, true); d.setUint16(10, entries.length, true);
  d.setUint32(12, cdSize, true); d.setUint32(16, offset, true);
  return [...parts, ...central, end];
}

/** 並びを1つの配列にする */
export function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
