/**
 * Ctrl(Mac は ⌘も)か Shift を押しながら動かすと、ドラッグやホイールの効きを FINE 倍にして細かく動かせる。
 * Shift に別の意味があるところ(3面図の自由角度の Shift+左ドラッグ = 平行移動など)では Ctrl だけが効く。
 */
export const FINE = 0.2;

type Mods = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

export function fineFactor(e: Mods, shiftIsFine = true): number {
  return e.ctrlKey || e.metaKey || (shiftIsFine && e.shiftKey) ? FINE : 1;
}

/**
 * タッチパッドのピンチは、ブラウザが ctrlKey 付きのホイールとして送ってくる。本当に Ctrl を押しているかは
 * キーの押し下げで自分で覚えておき、ホイールではそれで見分ける(ピンチまで遅くならないように)
 */
let ctrlDown = false;
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', e => { if (e.key === 'Control') ctrlDown = true; }, true);
  window.addEventListener('keyup', e => { if (e.key === 'Control') ctrlDown = false; }, true);
  window.addEventListener('blur', () => { ctrlDown = false; });
}

/** ホイール用の倍率。ctrlKey はピンチでも立つので使わず、覚えておいた Ctrl の状態を見る */
export function wheelFineFactor(e: WheelEvent): number {
  return ctrlDown || e.metaKey || e.shiftKey ? FINE : 1;
}

/** ホイールの縦の量。Shift を押すとブラウザが横に回したことにするので、そのときは横の量を使う */
export function wheelDelta(e: WheelEvent): number {
  return e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
}
