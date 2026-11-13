/**
 * UIを隠して、3Dビューを画面いっぱいに出す(コマンド toggleUi、Tab)。
 *
 * - 隠すのは、メニューバー・ツールの設定の行・左のツールバー・右パネル・ステータスバー・3面図と、
 *   スマホの上のバー・シート・下のバー(style.css の html.ui-hidden)。状態は App.uiHidden で、覚えない(開き直すと戻る)。
 * - 戻すのは、もう一度 Tab・Esc・右上の「UIを戻す」。PC では、マウスを動かすと「UIを戻す」とシークバーを少しの間だけ出す。
 *   スマホにはキーもマウスも無いので、どちらも出したままにする(戻すボタンは薄く)。
 * - 膨らませる・ぼかすのパネルは、使っている途中なら出したまま(画面全体に浮かべているので隠す対象に入らない)。
 * - 設定の「ブラウザも全画面にする」(setHideFull)がオンなら、隠すときにブラウザの全画面にもする。
 *   全画面はブラウザの Esc でもやめられ、そのときは UI も戻す。
 */
import type { App } from '../app';
import { prefs } from '../storage/prefs';
import { ui } from './ids';
import { isTyping } from './input';

/** マウスを止めてから、戻すボタンとシークバーを消すまで(ミリ秒) */
const PEEK_MS = 2000;
const PREF = 'hideUiFullscreen';

export function bindHideUi(app: App): void {
  const root = document.documentElement;
  const mobile = () => root.classList.contains('mobile');

  /* ---------- 設定: ブラウザも全画面にする ---------- */
  const canFull = !!document.fullscreenEnabled && typeof root.requestFullscreen === 'function';
  // 全画面にできないブラウザ(iPhone の Safari など)では、設定の欄を出さない
  ui.setHideFullRow.hidden = !canFull;
  ui.setHideFull.checked = prefs.get<boolean>(PREF) ?? false;
  ui.setHideFull.addEventListener('change', () => prefs.set(PREF, ui.setHideFull.checked));
  /** このアプリが隠すときに全画面にしたか(自分で入れた全画面だけを、戻すときにやめる) */
  let ownFull = false;

  /* ---------- 状態 → 画面 ---------- */
  let shown = false;
  function apply(): void {
    const on = app.uiHidden;
    if (on === shown) return;
    shown = on;
    root.classList.toggle('ui-hidden', on);
    // 隠した部品にフォーカスが残らないように外す(Tab を続けて押したときも隠す・戻すに使えるように)
    (document.activeElement as HTMLElement | null)?.blur();
    if (on) {
      peek();
      // キーやボタンを押した流れの中で呼ぶ(ブラウザは、操作に続くときだけ全画面を許す)
      if (canFull && ui.setHideFull.checked && !document.fullscreenElement) {
        ownFull = true;
        root.requestFullscreen().catch(() => { ownFull = false; });
      }
    } else {
      endPeek();
      if (ownFull && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      ownFull = false;
    }
  }
  app.on('view', apply);
  document.addEventListener('fullscreenchange', () => {
    // ブラウザの Esc などで全画面をやめたときは、UI も戻す
    if (!document.fullscreenElement && ownFull) { ownFull = false; app.setUiHidden(false); }
  });

  /* ---------- 戻す ---------- */
  ui.uiRestore.addEventListener('click', () => app.setUiHidden(false));
  window.addEventListener('keydown', e => {
    if (!app.uiHidden || e.key !== 'Escape' || e.defaultPrevented || isTyping(e)) return;
    // 膨らませる・ぼかすの途中なら、Esc はそのキャンセルに使う。ダイアログが開いているなら、ダイアログを閉じるのに使う
    if (app.previewing || document.querySelector('dialog[open]:modal')) return;
    e.preventDefault();
    app.setUiHidden(false);
  });
  // スマホでは膨らませるのパネルが下のシートの中にあるので、始まったら UI を戻す
  app.on('inflate', p => { if (p === 'begin' && app.uiHidden && mobile()) app.setUiHidden(false); });
  app.on('blur', p => { if (p === 'begin' && app.uiHidden && mobile()) app.setUiHidden(false); });

  /* ---------- マウスを動かすと、戻すボタンとシークバーを少しの間だけ出す ---------- */
  let timer = 0;
  /** ポインタが戻すボタンかシークバーの上にあるか(上にある間は消さない) */
  let over = false;
  function peek(): void {
    root.classList.add('ui-peek');
    clearTimeout(timer);
    if (!over) timer = window.setTimeout(() => root.classList.remove('ui-peek'), PEEK_MS);
  }
  function endPeek(): void {
    clearTimeout(timer);
    root.classList.remove('ui-peek');
  }
  window.addEventListener('pointermove', e => {
    // 塗る・つかむなどでドラッグしている間は出さない(絵を見ながら動かしているので)
    if (!app.uiHidden || e.buttons !== 0 || e.pointerType === 'touch') return;
    const t = e.target as Element | null;
    over = !!t?.closest?.('#uiRestore, #playBar');
    peek();
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { over = false; if (app.uiHidden) peek(); });

  apply();
}
