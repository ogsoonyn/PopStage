/**
 * ポップ量(と膨らませる高さ)のスライダーの目盛り。0〜1500px を 0〜1000 の目盛りに割り当てる。
 * よく使う 0〜500px は前半に 1 目盛り 1px で置き、残りの 500〜1500px は後半に 1 目盛り 2px で詰める
 * (どこでも 1 目盛り 1px 以上動くので、矢印キーで動かしても止まらない)。
 */
import { LIMITS } from '../model/project';

export const POP_SLIDER_MAX = 1000;
const KNEE = 500;
const UPPER_STEP = (LIMITS.pop.max - KNEE) / (POP_SLIDER_MAX - KNEE);

export function sliderToPop(s: number): number {
  const v = Math.max(0, Math.min(POP_SLIDER_MAX, s));
  return Math.round(v <= KNEE ? v : KNEE + (v - KNEE) * UPPER_STEP);
}

export function popToSlider(pop: number): number {
  const v = Math.max(LIMITS.pop.min, Math.min(LIMITS.pop.max, pop));
  return Math.round(v <= KNEE ? v : KNEE + (v - KNEE) / UPPER_STEP);
}
