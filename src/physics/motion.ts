/**
 * 揺らし方(自動揺らしの動きのパターン)。塗った部分を支える土台(アンカー)の位置を時刻の関数で返す。
 * 塗った部分はバネ・ダンパで土台に繋がっていて、土台が急に動いたり止まったりすると遅れて付いてきて弾む。
 *
 * - 単位は「画像の長辺 = 2」の正規化座標。y が上、z が手前。
 * - どのパターンも周期 T で元に戻る(T の整数倍の長さで書き出せばループする)。
 * - 振れ幅は strength(0〜1)に比例する。「ためて膨らむ」だけはポップ量にも比例する(pop は正規化座標)。
 */
import type { MotionPattern, Vec3 } from '../model/project';

const TAU = Math.PI * 2;

/** 中心 c・幅 w の山(0〜1、両端で 0)。phase / c / w は周期に対する割合。 */
function bump(phase: number, c: number, w: number): number {
  const d = phase - c;
  return Math.abs(d) < w / 2 ? 0.5 * (1 + Math.cos((TAU * d) / w)) : 0;
}

/** 放物線の跳躍。start から air の間だけ、高さ h の山を描く。 */
function hop(phase: number, start: number, air: number, h: number): number {
  const v = (phase - start) / air;
  return v > 0 && v < 1 ? 4 * h * v * (1 - v) : 0;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

export function motionAnchor(pattern: MotionPattern, t: number, period: number, strength: number, out: Vec3 = { x: 0, y: 0, z: 0 }, pop = 0): Vec3 {
  out.x = out.y = out.z = 0;
  if (strength <= 0 || pattern === 'none') return out;
  const T = Math.max(0.05, period), u = (((t % T) + T) % T) / T, s = strength, th = TAU * u;
  switch (pattern) {
    case 'jiggle': // 下へ、少しおいて上へ、と軽くつつく
      out.y = 0.12 * s * (-bump(u, 0.2, 0.1) + 0.6 * bump(u, 0.65, 0.1));
      break;
    case 'jump': { // 沈み込み → 跳ぶ → 着地で急に止まる → 静止
      const h = 0.3 * s;
      out.y = -0.15 * h * Math.sin(Math.PI * Math.min(1, u / 0.12)) * (u < 0.12 ? 1 : 0) + hop(u, 0.12, 0.42, h);
      break;
    }
    case 'bounce': // 接地を短くして、小さく跳び続ける
      out.y = hop(u, 0.15, 0.7, 0.12 * s);
      break;
    case 'shiver': { // 周期の整数倍の周波数(約9Hz)を重ねて、不規則に見える細かい震え
      const n = Math.max(3, Math.round(9 * T)), env = 0.6 + 0.4 * Math.sin(th);
      out.x = 0.08 * s * env * Math.sin(n * th);
      out.y = 0.05 * s * env * Math.sin((n + 3) * th + 1.3);
      break;
    }
    case 'float': // 8の字にゆっくり漂う
      out.y = 0.08 * s * Math.sin(th);
      out.x = 0.03 * s * Math.sin(2 * th);
      break;
    case 'sway':
      out.x = 0.12 * s * Math.sin(th);
      break;
    case 'shake': // 右へ、左へと短く振る(これまでの自動揺らしに相当)
      out.x = 0.1 * s * (bump(u, 0.25, 0.12) - bump(u, 0.75, 0.12));
      out.y = 0.03 * s * (bump(u, 0.25, 0.12) + bump(u, 0.75, 0.12));
      break;
    case 'circle': // 原点から始まる円(中心は少し下)
      out.x = 0.08 * s * Math.sin(th);
      out.y = 0.08 * s * (Math.cos(th) - 1);
      break;
    case 'heartbeat': // ドクン、ドクン、と手前にふくらむ
      out.z = 0.22 * s * (bump(u, 0.06, 0.1) + 0.7 * bump(u, 0.26, 0.1));
      break;
    case 'charge': { // ポップ量をゆっくり平らに近づけてから、ぱっと元へ戻す(勢いで元より大きく膨らむ)
      const depth = Math.min(0.95, 1.4 * s);
      out.z = u < 0.6 ? -depth * pop * smooth(u / 0.6) : 0;
      break;
    }
    case 'stretch': // ゆっくり持ち上げて、ぱっと離す
      out.y = u < 0.65 ? 0.2 * s * smooth(u / 0.65) : 0;
      break;
  }
  return out;
}
