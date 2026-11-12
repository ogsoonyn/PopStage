/**
 * お気に入りの一覧(右のパネルの「アニメーション」。スマホではシートの「アニメ」タブへ移す)。
 * 「☆ 残す」はコマンド(data-cmd。ui/actions.ts)で、ここは一覧の表示と行の操作だけを受け持つ。
 * 名前は行の入力欄でその場で書き換え、適用・上書き・削除はどれも App を通す(アンドゥできる)。
 */
import type { App } from '../app';
import { ui } from './ids';
import { icon } from './icons';
import { LIMITS, MOTIONS, PRESETS, type Favorite } from '../model/project';
import { favoriteMatches, FAVORITE_NAME_MAX } from '../model/favorites';
import { takeSeconds } from '../physics/take';

/** 行の2段目に出す中身の要約(揺らし方・周期・記録) */
export function favoriteSummary(f: Favorite): string {
  const names = [...new Set(f.layers.filter(l => l.physics.enabled).map(l =>
    l.physics.preset === 'custom' ? `${MOTIONS[l.physics.motion].label}(調整)` : PRESETS[l.physics.preset].label))];
  const parts = [names.length ? names.join('、') : '揺れなし'];
  parts.push(f.autoSwing.enabled ? `周期 ${f.autoSwing.period.toFixed(1)}秒` : '自動揺らしなし');
  if (f.take) parts.push(`${f.take.keys ? 'キーフレーム' : '記録'} ${takeSeconds(f.take).toFixed(1)}秒`);
  return parts.join(' / ');
}

const dateText = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) || d.getTime() === 0 ? '' : d.toLocaleString();
};

export function bindFavoriteControls(app: App): void {
  const { favList: list, favCount: count, favEmpty: empty } = ui;
  const idOf = (el: EventTarget | null) => (el as HTMLElement | null)?.closest<HTMLElement>('[data-fav]')?.dataset.fav ?? '';

  list.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]'), id = idOf(b);
    if (!b || !id) return;
    if (b.dataset.act === 'apply') app.applyFavorite(id);
    else if (b.dataset.act === 'set') app.overwriteFavorite(id);
    else if (b.dataset.act === 'del') app.removeFavorite(id);
  });
  // 名前: 入力欄を離れたとき(Enter でも離れる)に変える。空なら元の名前に戻す。Esc で書きかけを捨てる
  list.addEventListener('change', e => {
    const el = e.target as HTMLInputElement, id = idOf(el);
    if (el.dataset.act !== 'name' || !id) return;
    app.renameFavorite(id, el.value);
    refresh(true);
  });
  list.addEventListener('keydown', e => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.act !== 'name') return;
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); el.value = app.project.favorites.find(f => f.id === idOf(el))?.name ?? el.value; el.blur(); }
  });

  function row(): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'fav-row';
    li.innerHTML = `<span class="fav-mark" aria-hidden="true">●</span>`
      + `<div class="flex flex-col min-w-0"><input data-act="name" class="input input-ghost input-xs px-1 w-full" maxlength="${FAVORITE_NAME_MAX}" aria-label="名前"><span class="fav-sub text-xs opacity-60 truncate px-1"></span></div>`
      + `<button class="btn btn-xs" data-act="apply" title="この組み合わせに戻す(視点のほかは元に戻せる)">適用</button>`
      + `<button class="btn btn-xs btn-ghost btn-square fav-set" data-act="set" title="今の状態で上書きする(元に戻せる)" aria-label="今の状態で上書き">${icon('favSet')}</button>`
      + `<button class="btn btn-xs btn-ghost btn-square" data-act="del" title="消す(元に戻せる)" aria-label="消す">×</button>`;
    return li;
  }

  /** names: 入力中でも名前を書き戻す(名前を確定したとき) */
  function refresh(names = false): void {
    const favs = app.project.favorites, doc = app.doc, can = app.canEditFavorites;
    while (list.children.length < favs.length) list.append(row());
    while (list.children.length > favs.length) list.lastElementChild!.remove();
    favs.forEach((f, i) => {
      const li = list.children[i] as HTMLLIElement;
      li.dataset.fav = f.id;
      const same = !!doc && favoriteMatches(f, app.project, doc);
      li.setAttribute('aria-current', String(same));
      const name = li.querySelector<HTMLInputElement>('[data-act=name]')!;
      // 入力中の名前は書き換えない
      if ((names || document.activeElement !== name) && name.value !== f.name) name.value = f.name;
      const sub = li.querySelector<HTMLElement>('.fav-sub')!, text = favoriteSummary(f);
      if (sub.textContent !== text) sub.textContent = text;
      const date = dateText(f.createdAt);
      li.title = `${same ? '今の状態と同じ。' : ''}${date ? `残した日時: ${date}` : ''}`;
      for (const b of li.querySelectorAll<HTMLButtonElement>('button')) b.disabled = !can;
      name.disabled = !can;
    });
    empty.hidden = favs.length > 0;
    count.textContent = `${favs.length}/${LIMITS.favorites}`;
  }

  app.history.on('change', () => refresh());
  app.store.on('replace', () => refresh(true));
  app.store.on('project', () => refresh());
  app.store.on('layer', () => refresh());
  app.store.on('layers', () => refresh());
  app.on('take', () => refresh());
  app.on('status', () => refresh()); // 書き出しの始まり・終わりなど
  app.on('inflate', () => refresh());
  app.on('blur', () => refresh());
  refresh(true);
}
