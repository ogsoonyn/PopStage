/**
 * 「膨らませる」の範囲を、枠のハンドルで直す計算(DOM に依存しない)。
 * 座標は元画像のローカル座標(中心が原点、x は右、y は上、単位は元画像のピクセル)。
 * 角度は度で、正で画面上の時計回り(app の InflateSettings.angle と同じ)。
 * 形の向きの軸: u は傾ける前の「右」、v は傾ける前の「上」。
 */

export interface Area { x: number; y: number; w: number; h: number }
export interface Pt { x: number; y: number }

/** 大きさを変えるハンドルの位置。su・sv は u・v の向きの -1 / 0 / 1(角は両方 ±1、辺は片方が 0) */
export interface Handle { su: -1 | 0 | 1; sv: -1 | 0 | 1 }

/** 角4つと辺の中点4つ(右上から時計回り) */
export const HANDLES: readonly Handle[] = [
  { su: 1, sv: 1 }, { su: 1, sv: 0 }, { su: 1, sv: -1 }, { su: 0, sv: -1 },
  { su: -1, sv: -1 }, { su: -1, sv: 0 }, { su: -1, sv: 1 }, { su: 0, sv: 1 },
];

/** 範囲の幅・縦の最小(元画像のピクセル)。範囲を描くときの最小と同じ */
export const MIN_SIZE = 2;

/** 形の軸(u: 右、v: 上)。画像の座標は y が上向きなので、画面上の時計回りは数学の向きの -θ */
export function axes(angleDeg: number): { u: Pt; v: Pt } {
  const t = angleDeg * Math.PI / 180, c = Math.cos(t), n = Math.sin(t);
  return { u: { x: c, y: -n }, v: { x: n, y: c } };
}

/** 形の中の位置(su・sv は -1〜1、角なら ±1)を画像の座標へ */
export function areaPoint(a: Area, angleDeg: number, su: number, sv: number): Pt {
  const { u, v } = axes(angleDeg), hu = su * a.w / 2, hv = sv * a.h / 2;
  return { x: a.x + u.x * hu + v.x * hv, y: a.y + u.y * hu + v.y * hv };
}

/** 画像の点を、形の軸での位置(中心からの u・v の距離)へ */
export function toLocal(a: Area, angleDeg: number, p: Pt): { lu: number; lv: number } {
  const { u, v } = axes(angleDeg), dx = p.x - a.x, dy = p.y - a.y;
  return { lu: dx * u.x + dy * u.y, lv: dx * v.x + dy * v.y };
}

export interface ResizeOptions {
  /** 縦横比を保つ(Shift) */
  keepAspect?: boolean;
  /** 中心を止めて両側へ広げる(Alt) */
  fromCenter?: boolean;
}

/**
 * ハンドルを start から p へ動かしたときの範囲。ふつうは反対側の辺・角を止める。
 * 掴んだ所とハンドルのずれは start との差で打ち消すので、掴んだ瞬間に跳ばない。
 * 反対側を越えて裏返すことはせず、最小の大きさで止める。
 */
export function resizeArea(a: Area, angleDeg: number, h: Handle, start: Pt, p: Pt, o: ResizeOptions = {}): Area {
  const s = toLocal(a, angleDeg, start), q = toLocal(a, angleDeg, p);
  const du = q.lu - s.lu, dv = q.lv - s.lv;
  const k = o.fromCenter ? 2 : 1;
  let w = h.su ? Math.max(MIN_SIZE, a.w + h.su * du * k) : a.w;
  let hh = h.sv ? Math.max(MIN_SIZE, a.h + h.sv * dv * k) : a.h;
  if (o.keepAspect) {
    // 角は大きく変わった方(広げるのも縮めるのも)に合わせ、辺は動かした向きの倍率をもう一方にも掛ける
    const fu = w / a.w, fv = hh / a.h;
    const f = h.su && h.sv ? (Math.abs(Math.log(fu)) >= Math.abs(Math.log(fv)) ? fu : fv) : h.su ? fu : fv;
    const fMin = Math.max(MIN_SIZE / a.w, MIN_SIZE / a.h);
    const g = Math.max(f, fMin);
    w = a.w * g; hh = a.h * g;
  }
  // 中心の動き: 止める側(反対側)の位置が変わらないよう、動かした向きへ大きさの差の半分だけずらす。辺のハンドルで縦横比を保つときは、もう一方の向きは中心のまま広げる
  const cu = o.fromCenter || !h.su ? 0 : h.su * (w - a.w) / 2;
  const cv = o.fromCenter || !h.sv ? 0 : h.sv * (hh - a.h) / 2;
  const { u, v } = axes(angleDeg);
  return { x: a.x + u.x * cu + v.x * cv, y: a.y + u.y * cu + v.y * cv, w, h: hh };
}

/**
 * 大きさを整数のピクセルにそろえる(範囲を描くときと同じ)。止める側の辺・角が動かないよう、丸めた差の半分だけ中心もずらす
 */
export function roundArea(r: Area, angleDeg: number, h: Handle, fromCenter = false): Area {
  const w = Math.max(MIN_SIZE, Math.round(r.w)), hh = Math.max(MIN_SIZE, Math.round(r.h));
  const cu = fromCenter || !h.su ? 0 : h.su * (w - r.w) / 2, cv = fromCenter || !h.sv ? 0 : h.sv * (hh - r.h) / 2;
  const { u, v } = axes(angleDeg);
  return { x: r.x + u.x * cu + v.x * cv, y: r.y + u.y * cu + v.y * cv, w, h: hh };
}

/** 範囲を start から p へ動かした分だけ移す */
export function moveArea(a: Area, start: Pt, p: Pt): Area {
  return { ...a, x: a.x + p.x - start.x, y: a.y + p.y - start.y };
}

/** 角度を -90〜90 に収める(楕円も矩形も 180° 回すと同じ形になる) */
export function wrapAngle(deg: number): number {
  let d = ((deg + 90) % 180 + 180) % 180 - 90;
  if (d === -90 && deg > 0) d = 90;
  return d;
}

/**
 * 中心のまわりで start から p へ回したときの角度(度、-90〜90 の整数)。snap を指定すると、その刻みにそろえる(Shift で 15°)。
 * 画像の座標は y が上向きなので、画面上の時計回り(角度の正)は数学の向きの逆
 */
export function rotateAngle(a: Area, angleDeg: number, start: Pt, p: Pt, snap = 0): number {
  const a0 = Math.atan2(start.y - a.y, start.x - a.x), a1 = Math.atan2(p.y - a.y, p.x - a.x);
  let d = angleDeg - (a1 - a0) * 180 / Math.PI;
  if (snap > 0) d = Math.round(d / snap) * snap;
  return wrapAngle(Math.round(d));
}
