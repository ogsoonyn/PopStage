/**
 * ホイールのズームをなめらかにする。ホイールは目標の拡大率だけを動かし、実際の拡大率は毎フレーム、
 * 目標との差(対数)に比例した速さで寄せる。差が大きいほど速く、近づくほどゆっくり動き、続けて回すと目標が先へ延びる。
 * 1回のホイールで最終的に動く量は、寄せずにその場で変えていたときと同じ。
 * 寄せている途中でほかの操作(視点のリセット、ピンチ、再生など)が拡大率を変えたら、寄せるのをやめてそちらに任せる。
 * 値が変わったかに加えて、拡大率を持つオブジェクトが差し替わったかも見る(リセットや読み込みが同じ値を書いても気づけるように)。
 */

/** 目標との差が 1/e になるまでの時間(秒) */
export const ZOOM_EASE = 0.07;
/** 目標との差(対数)がこれより小さくなったら、目標に合わせて止める */
const DONE = 1e-3;

export interface SmoothZoomTarget {
  /** 今の拡大率 */
  get(): number;
  /** 拡大率を z にする。factor は今の値からの倍率(ポインタの位置を中心に寄せる図で使う) */
  set(z: number, factor: number): void;
  /** 拡大率を持つオブジェクト。差し替わったら、ほかの操作が視点を飛ばしたとみなす */
  owner(): object;
  min: number;
  max: number;
}

export interface SmoothZoom {
  /** 目標の拡大率を exp(logDelta) 倍にする */
  add(logDelta: number): void;
}

export function smoothZoom(t: SmoothZoomTarget): SmoothZoom {
  let goal: number | null = null;
  /** 最後に自分で書いた値。今の値がこれと違えば、ほかの操作が変えたとみなす */
  let written = NaN;
  let owner: object | null = null;
  let raf = 0, prev = 0;

  const step = (now: number) => {
    raf = 0;
    if (goal === null) return;
    const cur = t.get();
    if (cur !== written || t.owner() !== owner) { goal = null; return; }
    const dt = prev ? Math.min(0.1, (now - prev) / 1000) : 1 / 60;
    prev = now;
    const rest = Math.log(goal / cur);
    const next = Math.abs(rest) < DONE ? goal : cur * Math.exp(rest * (1 - Math.exp(-dt / ZOOM_EASE)));
    t.set(next, next / cur);
    written = t.get();
    // 着いたか、書いた先で上限・下限に止められた(倍率で書く図では丸めの誤差が出るので、少しの違いは許す)
    if (next === goal || Math.abs(Math.log(written / next)) > 1e-9) { goal = null; return; }
    raf = requestAnimationFrame(step);
  };

  return {
    add(logDelta) {
      const cur = t.get();
      // 寄せている途中なら、今の値ではなく目標から先へ延ばす(続けて回した分を取りこぼさない)
      const base = goal !== null && cur === written && t.owner() === owner ? goal : cur;
      goal = Math.max(t.min, Math.min(t.max, base * Math.exp(logDelta)));
      written = cur;
      owner = t.owner();
      if (goal === cur) { goal = null; return; }
      if (!raf) { prev = 0; raf = requestAnimationFrame(step); }
    },
  };
}
