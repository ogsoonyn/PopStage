import { describe, it, expect } from 'vitest';
import { WeightMap } from '../../src/model/weightmap';
import { profileAt, inflateShape, popForHeight, rescaleForPop, type InflateParams } from '../../src/paint/inflate';
import { diffTiles, WeightEdit, PatchLayer, Batch } from '../../src/commands/commands';
import { Store, createDocument, createProject, LIMITS } from '../../src/model/project';
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

describe('高さがポップ量を超えるとき', () => {
  it('要るポップ量: 足りていればそのまま、超えたら高さまで上げる', () => {
    expect(popForHeight(80, 140)).toBe(140);
    expect(popForHeight(140, 140)).toBe(140);
    expect(popForHeight(300, 140)).toBe(300);
    expect(popForHeight(50, 0)).toBe(50);
  });

  it('ポップ量を上げても、今の塗りの高さ(ウェイト × ポップ量)は変わらない', () => {
    const src = new Uint8Array([0, 51, 128, 255]);
    const out = rescaleForPop(src, 100, 200);
    expect([...out]).toEqual([0, 26, 64, 128]);
    for (let i = 0; i < src.length; i++) expect(Math.abs(out[i] / 255 * 200 - src[i] / 255 * 100)).toBeLessThanOrEqual(0.5);
    expect(out).not.toBe(src);
    // 同じポップ量や、元が 0(高さの手がかりが無い)ときはそのまま写す
    expect([...rescaleForPop(src, 100, 100)]).toEqual([...src]);
    expect([...rescaleForPop(src, 0, 200)]).toEqual([...src]);
  });

  it('ポップ量の変更とウェイトの変更を1手にまとめ、戻すと両方が元に戻る', () => {
    const store = makeStore(), history = new History(store);
    const layer = store.doc!.layers[0], wm = layer.weights;
    layer.pop = 100;
    wm.data.fill(200);
    const original = wm.data.slice();
    // 高さ 300px の膨らみを置く: ポップ量を 300 に上げ、今の塗りを 1/3 に縮めてから重ねる
    const base = rescaleForPop(original, 100, 300);
    wm.data.set(base);
    inflateShape(wm, base, { kind: 'ellipse', cx: 100, cy: 75, rx: 30, ry: 30 }, params({ level: 1 }));
    layer.pop = 300;
    const after = wm.data.slice();
    expect(at(wm, 10, 10)).toBe(67); // 200 × 100/300
    expect(at(wm, 100, 75)).toBe(255);
    history.push(new Batch('膨らませる', [new PatchLayer('膨らませる', layer.id, { pop: 100 }, { pop: 300 }), new WeightEdit('膨らませる', layer.id, diffTiles(original, wm))]));
    history.undo();
    expect(layer.pop).toBe(100);
    expect(wm.data).toEqual(original);
    history.redo();
    expect(layer.pop).toBe(300);
    expect(wm.data).toEqual(after);
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
