/**
 * ツールの定義。左のツールバーのボタン・ショートカット・ヘルプ・ツールオプションのヒントは、すべてここから作る。
 * アイコンは ui/icons.ts の同じ名前のもの。スマホの下のバーも、アイコンと名前はここから取る(並びと説明は ui/mobile.ts)
 */
import type { Tool } from '../app';

export interface ToolDef {
  id: Tool;
  /** ショートカット(1文字) */
  key: string;
  /** ボタンの名前 */
  label: string;
  /** ツールチップでの名前(ボタンの名前と違うときだけ) */
  name?: string;
  /** ツールチップでキーの後ろに足す補足 */
  keyNote?: string;
  /** ツールチップの説明 */
  desc?: string;
  /** ツールオプションの欄に出す操作のヒント */
  hint: string;
}

/** 左のツールバーの並び。まとまりの間に区切りを入れる */
export const TOOL_GROUPS: readonly (readonly ToolDef[])[] = [
  [
    { id: 'brush', key: 'B', label: 'ブラシ', hint: 'ドラッグで塗る(Alt で消しゴム)/ 右ドラッグで回転 / ホイールでズーム' },
    { id: 'erase', key: 'E', label: '消しゴム', keyNote: '、ブラシ中は Alt', hint: 'ドラッグでウェイトを消す' },
    { id: 'smooth', key: 'S', label: 'ぼかし', hint: 'ドラッグで段差をならす' },
    {
      id: 'inflate', key: 'I', label: '膨らみ', name: '膨らませる', desc: '範囲をドラッグして、指定した高さと断面で一括して膨らませる',
      hint: 'ドラッグした範囲を一括で膨らませる(Shift で正円・正方形)/ 枠の辺・角で大きさ、中で移動、上の丸で回す / 高さや断面は下のパネルで調整',
    },
    { id: 'grab', key: 'G', label: 'つかむ', hint: 'ドラッグで引っ張って離すと揺れる' },
    {
      id: 'shake', key: 'Y', label: '揺らす', desc: 'カメラを画像に付けたまま振る。画像は動かず、揺れだけが見える',
      hint: 'ドラッグで画像を振る(カメラが付いてくるので画像は動かず、揺れだけが見える)/ 中ドラッグで画像を動かす / 右ドラッグで回転',
    },
  ],
  [
    { id: 'view', key: 'V', label: '視点', hint: 'ドラッグで視点を回す / Space+ドラッグで平行移動' },
    {
      id: 'pan', key: 'H', label: '移動', desc: '左ドラッグで画像を画面の上で動かす(中ドラッグ・Space+ドラッグと同じ。動かした勢いで揺れる)',
      hint: 'ドラッグで画像を動かす(動かした勢いで揺れる)/ 右ドラッグで回転 / ホイールでズーム',
    },
  ],
];

export const TOOLS: readonly ToolDef[] = TOOL_GROUPS.flat();

export const toolDef = (t: Tool): ToolDef => TOOLS.find(d => d.id === t)!;

export const isTool = (v: unknown): v is Tool => TOOLS.some(d => d.id === v);
