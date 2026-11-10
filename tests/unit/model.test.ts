import { describe, it, expect } from 'vitest';
import { WeightMap, weightSizeFor, TILE } from '../../src/model/weightmap';
import { Store, createDocument, createProject, createLayer, LIMITS } from '../../src/model/project';
import { History } from '../../src/commands/history';
import { PatchLayer, InsertLayer, RemoveLayer, MoveLayer, WeightEdit, weightOperation, diffTiles } from '../../src/commands/commands';
import { Stroke, falloff } from '../../src/paint/stroke';

const image = (w = 800, h = 600) => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png', ext: 'png', width: w, height: h });
const makeStore = () => new Store(createProject(createDocument(image(), 'test')));

describe('WeightMap', () => {
  it('長辺 1024px までに縮める', () => {
    expect(weightSizeFor(2048, 1024)).toEqual({ w: 1024, h: 512 });
    expect(weightSizeFor(300, 200)).toEqual({ w: 300, h: 200 });
  });

  it('正規化で最大値が 255 になる', () => {
    const wm = new WeightMap(4, 1, new Uint8Array([0, 50, 100, 25]));
    wm.normalize();
    expect([...wm.data]).toEqual([0, 127, 255, 64]);
  });

  it('反転と全消去', () => {
    const wm = new WeightMap(2, 1, new Uint8Array([0, 200]));
    wm.invert(); expect([...wm.data]).toEqual([255, 55]);
    wm.clear(); expect(wm.isEmpty()).toBe(true);
  });

  it('ガウスぼかしで総量がほぼ保たれ、段差がならされる', () => {
    const wm = new WeightMap(64, 64);
    for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) wm.data[y * 64 + x] = 255;
    const sum = wm.data.reduce((s, v) => s + v, 0);
    wm.gaussianBlur(8);
    const after = wm.data.reduce((s, v) => s + v, 0);
    expect(Math.abs(after - sum) / sum).toBeLessThan(0.02);
    expect(wm.max()).toBeLessThan(255);
    expect(wm.data[32 * 64 + 20]).toBeGreaterThan(0);
  });

  it('アルファから生成', () => {
    const wm = new WeightMap(2, 2);
    wm.setFromAlpha(new Uint8Array([0, 255, 128, 0]), 2, 2);
    expect([...wm.data]).toEqual([0, 255, 128, 0]);
  });

  it('UV の向き(v=1 が上)', () => {
    const wm = new WeightMap(1, 2, new Uint8Array([255, 0]));
    expect(wm.sampleUV(0.5, 1)).toBeCloseTo(1);
    expect(wm.sampleUV(0.5, 0)).toBeCloseTo(0);
  });
});

describe('History', () => {
  it('パラメータ変更を元に戻してやり直せる', () => {
    const store = makeStore(), h = new History(store), layer = store.doc!.layers[0];
    h.execute(PatchLayer.from(store, layer.id, { pop: 200 }));
    expect(layer.pop).toBe(200);
    h.undo(); expect(layer.pop).toBe(LIMITS.pop.def);
    h.redo(); expect(layer.pop).toBe(200);
  });

  it('入れ子のオブジェクトも元に戻る', () => {
    const store = makeStore(), h = new History(store), layer = store.doc!.layers[0];
    const before = { ...layer.physics };
    h.execute(PatchLayer.from(store, layer.id, { physics: { ...layer.physics, hardness: 0.99, preset: 'custom' } }));
    expect(layer.physics.hardness).toBe(0.99);
    h.undo(); expect(layer.physics).toEqual(before);
  });

  it('100手を超えた分は捨てる', () => {
    const store = makeStore(), h = new History(store), id = store.doc!.layers[0].id;
    for (let i = 0; i < 130; i++) h.execute(PatchLayer.from(store, id, { pop: i }));
    expect(h.size).toBe(100);
    while (h.undo());
    expect(store.doc!.layers[0].pop).toBe(29);
  });

  it('容量の上限を超えると古いものから捨てる', () => {
    const store = makeStore(), h = new History(store, { maxBytes: 2000 }), id = store.doc!.layers[0].id;
    for (let i = 0; i < 20; i++) h.execute(PatchLayer.from(store, id, { pop: i }));
    expect(h.bytes).toBeLessThanOrEqual(2000);
  });

  it('新しい操作でやり直し履歴が消える', () => {
    const store = makeStore(), h = new History(store), id = store.doc!.layers[0].id;
    h.execute(PatchLayer.from(store, id, { pop: 1 }));
    h.undo();
    h.execute(PatchLayer.from(store, id, { pop: 2 }));
    expect(h.canRedo).toBe(false);
  });

  it('レイヤーの追加・削除・並べ替え', () => {
    const store = makeStore(), h = new History(store), doc = store.doc!;
    const a = doc.layers[0], b = createLayer(doc, 'B');
    h.execute(new InsertLayer('追加', doc.id, b, 1));
    expect(doc.layers.map(l => l.name)).toEqual([a.name, 'B']);
    h.execute(new MoveLayer(b.id, 1, 0));
    expect(doc.layers[0]).toBe(b);
    h.execute(new RemoveLayer(store, a.id));
    expect(doc.layers).toEqual([b]);
    h.undo(); h.undo(); h.undo();
    expect(doc.layers).toEqual([a]);
  });
});

describe('ウェイトの編集とタイル差分', () => {
  it('塗りのストロークを元に戻すと完全に元どおり', () => {
    const store = makeStore(), h = new History(store), layer = store.doc!.layers[0];
    const original = layer.weights.data.slice();
    const st = new Stroke(layer.weights, 'brush', { size: 60, strength: 0.5, hardness: 0 });
    st.addPoint(100, 100); st.addPoint(300, 220); st.addPoint(500, 150);
    const tiles = st.finish();
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(layer.weights.tilesX * layer.weights.tilesY);
    h.push(new WeightEdit('塗り', layer.id, tiles));
    const painted = layer.weights.data.slice();
    expect(painted).not.toEqual(original);
    h.undo(); expect(layer.weights.data).toEqual(original);
    h.redo(); expect(layer.weights.data).toEqual(painted);
  });

  it('スタンプは 25% 間隔で補間され、線が途切れない', () => {
    const wm = new WeightMap(400, 100);
    const st = new Stroke(wm, 'brush', { size: 20, strength: 1, hardness: 0.5 });
    st.addPoint(10, 50); st.addPoint(390, 50);
    for (let x = 12; x < 385; x += 3) expect(wm.data[50 * 400 + x]).toBeGreaterThan(100);
  });

  it('強さ 1% でも丸めで消えずに積み上がる', () => {
    const wm = new WeightMap(200, 50);
    const st = new Stroke(wm, 'brush', { size: 40, strength: 0.01, hardness: 0 });
    for (let x = 20; x <= 180; x += 2) st.addPoint(x, 25);
    expect(wm.data[25 * 200 + 100]).toBeGreaterThan(0);
  });

  it('消しゴムとぼかし', () => {
    const wm = new WeightMap(100, 100);
    wm.data.fill(255);
    const er = new Stroke(wm, 'erase', { size: 30, strength: 1, hardness: 1 });
    for (let i = 0; i < 5; i++) er.addPoint(50 + i * 0.01, 50);
    for (let k = 0; k < 4; k++) { const e2 = new Stroke(wm, 'erase', { size: 30, strength: 1, hardness: 1 }); e2.addPoint(50, 50); }
    expect(wm.data[50 * 100 + 50]).toBe(0);
    // 段差(左 0 / 右 255)をぼかすと、境目の両側が近づく
    const st = new WeightMap(100, 100);
    for (let y = 0; y < 100; y++) for (let x = 50; x < 100; x++) st.data[y * 100 + x] = 255;
    const sm = new Stroke(st, 'smooth', { size: 60, strength: 1, hardness: 0 });
    sm.addPoint(50, 50);
    expect(st.data[50 * 100 + 49]).toBeGreaterThan(0);
    expect(st.data[50 * 100 + 50]).toBeLessThan(255);
    expect(st.data[5 * 100 + 49]).toBe(0); // ブラシの外は変わらない
  });

  it('一括処理は変わったタイルだけ記録する', () => {
    const store = makeStore(), h = new History(store), layer = store.doc!.layers[0];
    layer.weights.data[0] = 10;
    const cmd = weightOperation(store, layer.id, '正規化', wm => wm.normalize())!;
    expect(cmd.tiles.length).toBe(1);
    expect(layer.weights.data[0]).toBe(255);
    h.push(cmd); h.undo();
    expect(layer.weights.data[0]).toBe(10);
  });

  it('diffTiles は変化が無ければ空', () => {
    const wm = new WeightMap(TILE * 2 + 5, TILE + 1);
    expect(diffTiles(wm.data.slice(), wm)).toEqual([]);
  });

  it('falloff: 硬さ 100% なら縁まで 1', () => {
    expect(falloff(0.99, 1)).toBe(1);
    expect(falloff(0, 0)).toBe(1);
    expect(falloff(1, 0)).toBe(0);
    expect(falloff(0.5, 0)).toBeCloseTo(0.5);
  });
});
