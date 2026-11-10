/**
 * Ctrl(Mac は ⌘も)か Shift を押しながら動かすと、ドラッグやホイールの効きを FINE 倍にして細かく動かせる。
 * Shift に別の意味があるところ(3面図の自由角度の Shift+左ドラッグ = 平行移動など)では Ctrl だけが効く。
 */
export const FINE = 0.2;

type Mods = { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

export function fineFactor(e: Mods, shiftIsFine = true): number {
  return e.ctrlKey || e.metaKey || (shiftIsFine && e.shiftKey) ? FINE : 1;
}

/** ホイールの縦の量。Shift を押すとブラウザが横に回したことにするので、そのときは横の量を使う */
export function wheelDelta(e: WheelEvent): number {
  return e.deltaY !== 0 ? e.deltaY : e.shiftKey ? e.deltaX : 0;
}
