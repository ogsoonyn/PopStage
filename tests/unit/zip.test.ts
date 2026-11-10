import { describe, it, expect } from 'vitest';
import { unzipSync, strToU8, strFromU8 } from 'fflate';
import { zipParts, concatParts, crc32, crcStats } from '../../src/storage/zip';
import { serializeProject, serializeProjectBlob, deserializeProject, type PngCacheEntry } from '../../src/storage/popstage';
import { createDocument, createProject, createLayer } from '../../src/model/project';

/** 1バイトずつの素直な CRC32(比べる相手) */
function naiveCrc(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return (c ^ 0xffffffff) >>> 0;
}

describe('ZIP の書き出し', () => {
  it('CRC32 は既知の値と、素直な実装に一致する(端数の長さも)', () => {
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    const r = new Uint8Array(1027); for (let i = 0; i < r.length; i++) r[i] = (i * 7919) & 0xff;
    for (const n of [1, 2, 3, 4, 5, 1027]) expect(crc32(r.subarray(0, n))).toBe(naiveCrc(r.subarray(0, n)));
  });

  it('fflate で展開でき、無圧縮のデータはコピーせずに並びへ入る', () => {
    const big = new Uint8Array(5000).map((_, i) => i & 0xff);
    const parts = zipParts([
      { name: 'images/a.png', data: big },
      { name: 'project.json', data: strToU8('{"日本語":"名前"}'.repeat(50)), level: 6 },
      { name: '日本語.txt', data: strToU8('x') },
    ]);
    expect(parts).toContain(big);
    const files = unzipSync(concatParts(parts));
    expect(files['images/a.png']).toEqual(big);
    expect(strFromU8(files['project.json'])).toBe('{"日本語":"名前"}'.repeat(50));
    expect(strFromU8(files['日本語.txt'])).toBe('x');
  });

  it('stable のデータは CRC を1回だけ計算する', () => {
    const data = new Uint8Array(100).fill(3);
    const before = crcStats.computed;
    zipParts([{ name: 'a', data, stable: true }]);
    zipParts([{ name: 'a', data, stable: true }]);
    zipParts([{ name: 'a', data, stable: true }]);
    expect(crcStats.computed - before).toBe(1);
    zipParts([{ name: 'a', data }]);
    expect(crcStats.computed - before).toBe(2);
  });
});

describe('自動保存の直列化', () => {
  const project = () => {
    const doc = createDocument({ bytes: new Uint8Array(4096).map((_, i) => i & 0xff), mime: 'image/png', ext: 'png', width: 64, height: 48 }, '画像');
    doc.layers[0].weights.data.fill(10);
    doc.layers.push(createLayer(doc, '2'));
    return createProject(doc);
  };

  it('Blob 版はバイト列版と同じ ZIP の中身になり、読み込める', async () => {
    const p = project(), cache = new Map<string, PngCacheEntry>();
    const blob = serializeProjectBlob(p, { pngCache: cache });
    const fromBlob = new Uint8Array(await blob.arrayBuffer());
    const a = unzipSync(fromBlob), b = unzipSync(serializeProject(p));
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    for (const k of Object.keys(a)) if (k !== 'project.json') expect(a[k]).toEqual(b[k]);
    const { project: q } = await deserializeProject(fromBlob);
    expect(q.documents[0].image.bytes).toEqual(p.documents[0].image.bytes);
    expect(q.documents[0].layers[0].weights.data).toEqual(p.documents[0].layers[0].weights.data);
  });

  it('2回目からは元画像の CRC を計算し直さず、変わっていないウェイトの PNG を使い回す', () => {
    const p = project(), cache = new Map<string, PngCacheEntry>();
    serializeProjectBlob(p, { pngCache: cache });
    const png0 = cache.get(p.documents[0].layers[0].id)!.png;
    const before = crcStats.computed;
    serializeProjectBlob(p, { pngCache: cache });
    // 毎回作り直すのは project.json だけ
    expect(crcStats.computed - before).toBe(1);
    expect(cache.get(p.documents[0].layers[0].id)!.png).toBe(png0);
  });

  it('レイヤーのウェイトの配列が差し替わったら、キャッシュの PNG は使わない', async () => {
    const p = project(), cache = new Map<string, PngCacheEntry>();
    serializeProject(p, { pngCache: cache });
    const l = p.documents[0].layers[0];
    l.weights = l.weights.clone(); l.weights.data.fill(200);
    const { project: q } = await deserializeProject(serializeProject(p, { pngCache: cache }));
    expect(q.documents[0].layers[0].weights.data[0]).toBe(200);
  });
});
