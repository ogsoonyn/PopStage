/**
 * 右パネルの開閉(PC の幅だけ)。3Dビューの右上のボタン(#panelToggle)、Shift+P、表示メニューから切り替える。
 * 状態は App.panelClosed、画面は html の .panel-closed(style.css)。開閉はこのブラウザに覚える。
 */
import type { App } from '../app';
import { prefs } from '../storage/prefs';
import { ui } from './ids';

const PREF = 'panelClosed';
/** パネルの絵(右に縦の帯)と、開く・閉じる向きの矢印 */
const panelIcon = (closed: boolean) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/><path d="${closed ? 'm10 9-3 3 3 3' : 'm7 9 3 3-3 3'}"/></svg>`;

export function bindSidePanel(app: App): void {
  if (prefs.get<boolean>(PREF) === true) app.setPanelClosed(true);
  const root = document.documentElement;
  const apply = () => {
    const closed = app.panelClosed;
    if (root.classList.contains('panel-closed') === closed) return;
    // 閉じるパネルの中にフォーカスがあれば、開閉のボタンへ移す(body に落ちると、次の Tab で UI が隠れるため)
    if (closed && ui.sidePanel.contains(document.activeElement)) ui.panelToggle.focus();
    root.classList.toggle('panel-closed', closed);
    ui.panelToggle.innerHTML = panelIcon(closed);
    const label = closed ? '右パネルを開く (Shift+P)' : '右パネルを閉じる (Shift+P)';
    ui.panelToggle.title = label;
    ui.panelToggle.setAttribute('aria-label', label);
    ui.panelToggle.setAttribute('aria-expanded', String(!closed));
    prefs.set(PREF, closed);
  };
  ui.panelToggle.addEventListener('click', () => app.setPanelClosed(!app.panelClosed));
  app.on('view', apply);
  // 最初の1回は、閉じていなくても文言を入れる
  root.classList.toggle('panel-closed', !app.panelClosed);
  apply();
}
