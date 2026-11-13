/**
 * ツール全体の設定(メニューバーの右端の歯車から開く)。このブラウザに覚え(prefs)、ファイルには書かない。
 * 今あるのは、左のツールバーに出すボタンの選択と、塗るときにウェイトの重ね表示を自動でONにするか(#vAutoOverlay。結び付けは表示の切り替えと一緒に ui/panels.ts)。
 * 新しい設定は、この画面に足す。
 */
import { prefs } from '../storage/prefs';
import { TOOLBAR_ITEMS } from './actions';
import { ui } from './ids';

const KEY = 'toolbarHidden';

/** 覚えている「隠すボタン」のうち、今もあるものだけ */
function loadHidden(): Set<string> {
  const v = prefs.get<unknown>(KEY);
  const known = new Set(TOOLBAR_ITEMS.flatMap(g => g.items.map(it => it.id)));
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && known.has(x)) : []);
}

/**
 * 左のツールバーに映す。隠したボタンのほか、中が全部隠れたまとまりの枠と、
 * 前か後ろに出すものが無くなった区切りも隠す(区切りが続いたり端に残ったりしないように)
 */
function applyToolbar(hidden: ReadonlySet<string>): void {
  const nav = ui.toolNav;
  for (const b of nav.querySelectorAll<HTMLElement>('[data-nav]')) b.classList.toggle('nav-off', hidden.has(b.dataset.nav!));
  for (const g of nav.querySelectorAll<HTMLElement>('.nav-group')) g.classList.toggle('nav-off', !g.querySelector('[data-nav]:not(.nav-off)'));
  // 全部隠したときは、空の列を残さない
  nav.classList.toggle('nav-off', !nav.querySelector('[data-nav]:not(.nav-off)'));
  let seen = false, pending: HTMLElement | null = null;
  for (const el of [...nav.children] as HTMLElement[]) {
    if (el.classList.contains('divider')) {
      el.classList.add('nav-off');
      // 出すものが前にあり、前の区切りをまだ出していないときだけ、出す候補にする
      if (seen && !pending) pending = el;
    } else if (!el.classList.contains('nav-off')) {
      pending?.classList.remove('nav-off');
      pending = null;
      seen = true;
    }
  }
}

export function bindSettingsDialog(): { open: () => void } {
  let hidden = loadHidden();
  applyToolbar(hidden);

  const boxes: HTMLInputElement[] = [];
  ui.setToolbarList.replaceChildren(...TOOLBAR_ITEMS.map(g => {
    const fs = document.createElement('fieldset');
    fs.className = 'set-group';
    fs.append(Object.assign(document.createElement('legend'), { textContent: g.group }));
    for (const it of g.items) {
      const label = document.createElement('label');
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'checkbox checkbox-xs' });
      cb.dataset.nav = it.id;
      cb.addEventListener('change', () => {
        hidden = new Set(hidden);
        if (cb.checked) hidden.delete(it.id); else hidden.add(it.id);
        save();
      });
      boxes.push(cb);
      label.append(cb, document.createTextNode(it.label));
      fs.append(label);
    }
    return fs;
  }));

  const sync = () => { for (const cb of boxes) cb.checked = !hidden.has(cb.dataset.nav!); };
  const save = () => { prefs.set(KEY, [...hidden]); applyToolbar(hidden); };
  ui.setToolbarReset.addEventListener('click', () => { hidden = new Set(); save(); sync(); });

  return { open: () => { sync(); ui.settingsDialog.showModal(); } };
}
