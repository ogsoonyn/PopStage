import { describe, it, expect } from 'vitest';
import { WeightMap } from '../../src/model/weightmap';
import { profileAt, inflateShape, type InflateParams } from '../../src/paint/inflate';
import { diffTiles, WeightEdit, InsertLayer } from '../../src/commands/commands';
import { Store, createDocument, createProject, createLayer, LIMITS } from '../../src/model/project';
import { History } from '../../src/commands/history';
import { popToSlider, sliderToPop, POP_SLIDER_MAX } from '../../src/ui/popSlider';

const params = (p: Partial<InflateParams> = {}): InflateParams => ({ level: 1, softness: 1, profile: 'dome', blend: 'max', ...p });
const at = (wm: WeightMap, x: number, y: number) => wm.data[y * wm.width + x];
const makeStore = () => new Store(createProject(createDocument({ bytes: new Uint8Array([1]), mime: 'image/png', ext: 'png', width: 200, height: 150 }, 't')));

describe('断面の形', () => {
  it('縁で 0、奥で 1。ドームは直線より、直線はクッションより、途中が高い', () => {
    for (const p of ['dome', 'cushion', 'cone'] as const) {
      expect(profileAt(0, p)).toBe(0);
      expect(profileAt(1, p)).toBe(1);
      expect(profileAt(2, p)).toBe(1);
    }
    expect(profileAt(0.25, 'dome')).toBeGreaterThan(profileAt(0.25, 'cone'));
    expect(profileAt(0.25, 'cone')).toBeGreaterThan(profileAt(0.25, 'cushion'));
  });
});

describe('図形で膨らませる', () => {
  it('楕円: 中心が指定の高さになり、外には触れない。ドームの断面は回転楕円体', () => {
    const wm = new WeightMap(100, 80), base = wm.data.slice();
    const r = inflateShape(wm, base, { kind: 'ellipse', cx: 50, cy: 40, rx: 30, ry: 20 }, params({ level: 0.5 }));
    expect(r).toEqual({ x: 20, y: 20, w: 60, h: 40 });
    expect(at(wm, 50, 40)).toBeGreaterThanOrEqual(126);
    expect(at(wm, 50, 40)).toBeLessThanOrEqual(128);
    expect(at(wm, 5, 5)).toBe(0);
    expect(at(wm, 50, 19)).toBe(0); // 外接矩形の外
    // 中心から半径の半分の所は sqrt(1 - 0.5²) ≒ 0.866 倍の高さ
    const half = at(wm, 50 + 15, 40) / 255 / 0.5;
    expect(half).toBeGreaterThan(0.83);
    expect(half).toBeLessThan(0.9);
  });

  it('傾けた形: 傾いた向きに伸び、外接矩形も傾きに合わせて広がる', () => {
    // 横長の矩形を時計回りに 90° 傾けると縦長になる
    const a = new WeightMap(64, 64);
    const r = inflateShape(a, a.data.slice(), { kind: 'rect', cx: 32, cy: 32, rx: 20, ry: 6, angle: Math.PI / 2 }, params({ softness: 0 }));
    expect(r).toEqual({ x: 26, y: 12, w: 12, h: 40 });
    expect(at(a, 32, 15)).toBe(255); expect(at(a, 15, 32)).toBe(0);
    // 楕円を時計回りに 45° 傾けると、右下・左上の向きに伸びる(行は下へ増える)
    const b = new WeightMap(64, 64);
    inflateShape(b, b.data.slice(), { kind: 'ellipse', cx: 32, cy: 32, rx: 24, ry: 6, angle: Math.PI / 4 }, params());
    expect(at(b, 32 + 14, 32 + 14)).toBeGreaterThan(0); expect(at(b, 32 - 14, 32 - 14)).toBeGreaterThan(0);
    expect(at(b, 32 + 14, 32 - 14)).toBe(0); expect(at(b, 32 - 14, 32 + 14)).toBe(0);
  });

  it('なだらかさ 0 は平らな台になる', () => {
    const wm = new WeightMap(64, 64), base = wm.data.slice();
    inflateShape(wm, base, { kind: 'rect', cx: 32, cy: 32, rx: 20, ry: 10 }, params({ softness: 0 }));
    expect(at(wm, 32, 32)).toBe(255);
    expect(at(wm, 14, 25)).toBe(255); // 縁から 2px 内側でももう頂上の高さ
    expect(at(wm, 11, 32)).toBe(0);
  });

  it('画像の端からはみ出した範囲は、はみ出た分を切って描く', () => {
    const wm = new WeightMap(32, 32), base = wm.data.slice();
    const r = inflateShape(wm, base, { kind: 'ellipse', cx: 0, cy: 16, rx: 10, ry: 10 }, params());
    expect(r).toEqual({ x: 0, y: 6, w: 10, h: 20 });
    expect(at(wm, 0, 16)).toBeGreaterThan(250);
    expect(inflateShape(wm, base, { kind: 'rect', cx: -50, cy: 16, rx: 10, ry: 10 }, params())).toBeNull();
  });

  it('重ね方: 重ねるは高い方を残し、足すは加え、置き換えるは範囲内を上書きする', () => {
    const shape = { kind: 'rect' as const, cx: 8, cy: 8, rx: 8, ry: 8 };
    const make = () => { const wm = new WeightMap(16, 16); wm.data.fill(200); return wm; };
    const a = make(); inflateShape(a, a.data.slice(), shape, params({ level: 0.4, softness: 0 }));
    expect(at(a, 8, 8)).toBe(200);
    const b = make(); inflateShape(b, b.data.slice(), shape, params({ level: 0.4, softness: 0, blend: 'add' }));
    expect(at(b, 8, 8)).toBe(255);
    const c = make(); inflateShape(c, c.data.slice(), shape, params({ level: 0.4, softness: 0, blend: 'replace' }));
    expect(at(c, 8, 8)).toBe(102);
  });

  it('1手として元に戻せる', () => {
    const store = makeStore(), history = new History(store);
    const layer = store.doc!.layers[0], wm = layer.weights, before = wm.data.slice();
    inflateShape(wm, before, { kind: 'ellipse', cx: 100, cy: 75, rx: 60, ry: 40 }, params());
    const tiles = diffTiles(before, wm);
    expect(tiles.length).toBeGreaterThan(0);
    const after = wm.data.slice();
    history.push(new WeightEdit('膨らませる', layer.id, tiles));
    history.undo();
    expect(wm.data).toEqual(before);
    history.redo();
    expect(wm.data).toEqual(after);
  });
});

describe('高さがポップ量を超えるとき(新しいレイヤーに作る)', () => {
  it('ポップ量 = 高さのレイヤーに頂上 100% で作り、1手で戻すとレイヤーごと消えて元のレイヤーは元のまま', () => {
    const store = makeStore(), history = new History(store), doc = store.doc!;
    const source = doc.layers[0];
    source.pop = 140;
    for (let i = 0; i < source.weights.data.length; i++) source.weights.data[i] = (i * 7) & 0xff;
    const sourceBefore = source.weights.data.slice();
    // 高さ 420px: 元のレイヤーには触れず、ポップ量 420px の新しいレイヤーに頂上 100% で置く
    const layer = createLayer(doc, '膨らみ1');
    layer.pop = 420;
    const wm = layer.weights;
    inflateShape(wm, wm.data.slice(), { kind: 'ellipse', cx: 100, cy: 75, rx: 30, ry: 30 }, params({ level: 420 / layer.pop }));
    expect(wm.max()).toBe(255); // 8 ビットの階調をすべて使える
    history.execute(new InsertLayer('膨らませる', doc.id, layer, 1));
    expect(doc.layers.map(l => l.name)).toEqual([source.name, '膨らみ1']);
    history.undo();
    expect(doc.layers).toEqual([source]);
    expect(source.pop).toBe(140);
    expect(source.weights.data).toEqual(sourceBefore);
    history.redo();
    expect(doc.layers[1]).toBe(layer);
    expect(doc.layers[1].weights.max()).toBe(255);
    expect(LIMITS.maxLayers).toBe(8);
  });
});

describe('ポップ量のスライダーの目盛り', () => {
  it('前半は 1 目盛り 1px、後半は 2px。端は 0 と最大', () => {
    expect(sliderToPop(0)).toBe(0);
    expect(sliderToPop(140)).toBe(140);
    expect(sliderToPop(500)).toBe(500);
    expect(sliderToPop(501)).toBe(502);
    expect(sliderToPop(POP_SLIDER_MAX)).toBe(LIMITS.pop.max);
    expect(popToSlider(LIMITS.pop.max)).toBe(POP_SLIDER_MAX);
  });

  it('目盛りを 1 つ動かすと必ずポップ量が変わり、往復しても元の目盛りに戻る', () => {
    for (let s = 0; s < POP_SLIDER_MAX; s++) {
      expect(sliderToPop(s + 1)).toBeGreaterThan(sliderToPop(s));
      expect(popToSlider(sliderToPop(s))).toBe(s);
    }
  });
});
