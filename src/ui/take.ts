/**
 * 操作の記録・ループ再生とキーフレームの部品(右のパネルの「アニメーション」。スマホではシートの「揺れ」タブへ移す)と、
 * 3Dビューの左上の印。説明は文章で並べず、状態は短いラベル、詳しいことはツールチップに置く。
 * 記録・再生・消すのボタンはコマンド(data-cmd。押したときの処理・使えるか・ツールチップは ui/actions.ts)で、ここは表示だけを変える。
 */
import type { App } from '../app';
import { ui } from './ids';
import { KEY_SECONDS, MAX_KEYS, TAKE_MIN_SECONDS, takeSeconds, type KeyMode } from '../physics/take';

const sec = (v: number) => `${v.toFixed(1)}秒`;

export function bindTakeControls(app: App): void {
  const { takeRec: rec, takePlay: play, takeInfo: info, takeBadge: badge } = ui;
  const label = (b: HTMLElement) => b.querySelector<HTMLElement>('[data-label]')!;

  badge.addEventListener('click', () => { if (app.takeState === 'recording') app.stopRecording(); else app.stopTake(); });

  /* ---------- キーフレーム ---------- */
  const { keyList: list, keyAdd: add, keyMake: make } = ui;
  add.addEventListener('click', () => app.addKey());
  make.addEventListener('click', () => app.makeKeyTake());
  // 行の中のボタン・入力はまとめて受ける(行は作り直すことがある)
  const rowOf = (el: EventTarget | null) => Number((el as HTMLElement | null)?.closest<HTMLElement>('[data-key]')?.dataset.key ?? -1);
  list.addEventListener('click', e => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]'), i = rowOf(b);
    if (!b || i < 0) return;
    if (b.dataset.act === 'go') app.gotoKey(i);
    else if (b.dataset.act === 'set') app.setKey(i);
    else if (b.dataset.act === 'del') app.removeKey(i);
  });
  list.addEventListener('change', e => {
    const el = e.target as HTMLInputElement | HTMLSelectElement, i = rowOf(el);
    if (i < 0) return;
    if (el.dataset.act === 'sec') {
      const v = el.value.trim() === '' ? NaN : +el.value;
      app.setKeyOption(i, { seconds: Number.isFinite(v) ? v : KEY_SECONDS.def });
      // 丸めた値を入力欄にも戻す(入力中は refresh で書き換えないため)
      const k = app.keyDraft[i];
      if (k) el.value = k.seconds.toFixed(1);
    }
    else if (el.dataset.act === 'mode') app.setKeyOption(i, { mode: el.value as KeyMode });
  });

  function keyRow(): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'key-row';
    li.innerHTML = `<button class="btn btn-xs btn-ghost key-no" data-act="go" title="この視点を見る"></button>`
      + `<button class="btn btn-xs" data-act="set" title="今の視点で登録し直す">登録</button>`
      + `<button class="btn btn-xs btn-ghost btn-square" data-act="del" title="削除" aria-label="削除">×</button>`
      + `<label class="flex items-center gap-0.5"><input data-act="sec" type="number" min="${KEY_SECONDS.min}" max="${KEY_SECONDS.max}" step="0.1" class="input input-xs w-14 text-right" title="次のフレームまでの時間(最後は最初へ戻るまで)" aria-label="次まで(秒)"><span class="text-xs">秒</span></label>`
      + `<select data-act="mode" class="select select-xs" title="なめらか: 止まらず通り抜ける / 弾む: 急に止まって揺れる" aria-label="通り方"><option value="smooth">なめらか</option><option value="bounce">弾む</option></select>`;
    return li;
  }

  function refreshKeys(): void {
    const keys = app.keyDraft;
    while (list.children.length < keys.length) list.append(keyRow());
    while (list.children.length > keys.length) list.lastElementChild!.remove();
    keys.forEach((k, i) => {
      const li = list.children[i] as HTMLLIElement;
      li.dataset.key = String(i);
      li.querySelector('.key-no')!.textContent = String(i + 1);
      const s = li.querySelector<HTMLInputElement>('[data-act=sec]')!, m = li.querySelector<HTMLSelectElement>('[data-act=mode]')!;
      // 入力中・開いている選択肢は書き換えない
      if (document.activeElement !== s && +s.value !== k.seconds) s.value = k.seconds.toFixed(1);
      if (m.value !== k.mode) m.value = k.mode;
    });
    ui.keyCount.textContent = `${keys.length}/${MAX_KEYS}`;
    add.disabled = keys.length >= MAX_KEYS || !app.doc;
    const total = keys.reduce((a, k) => a + k.seconds, 0);
    make.disabled = keys.length < 2 || total < TAKE_MIN_SECONDS - 1e-9 || !app.doc || app.exporting || app.takeState === 'recording';
    ui.keyTotal.textContent = keys.length < 2 ? '2つ以上' : total < TAKE_MIN_SECONDS - 1e-9 ? `1周 ${TAKE_MIN_SECONDS}秒以上` : `1周 ${sec(total)}`;
  }

  let shown = '';
  function refresh(): void {
    const s = app.takeState, has = !!app.project.take, len = app.takeLength;
    label(rec).textContent = s === 'recording' ? '停止' : '記録';
    rec.setAttribute('aria-pressed', String(s === 'recording'));
    play.querySelector('[data-icon]')!.textContent = s === 'playing' ? '■' : '▶';
    label(play).textContent = s === 'playing' ? '停止' : '再生';
    play.setAttribute('aria-pressed', String(s === 'playing'));
    info.textContent = s === 'recording' ? `● ${sec(len)} / 60秒`
      : s === 'playing' ? `▶ ${app.takePosition.toFixed(1)} / ${sec(len)}`
      : has ? `${app.project.take?.keys ? 'キーフレーム' : '記録'} ${sec(takeSeconds(app.project.take))}` : 'なし';
    info.classList.toggle('badge-error', s === 'recording');
    const text = s === 'recording' ? `記録中 ${sec(len)} ■` : s === 'playing' ? `▶ ${app.takePosition.toFixed(1)}/${sec(len)} ■` : '';
    if (text !== shown) {
      shown = text;
      badge.textContent = text;
      badge.classList.toggle('hidden', !text);
      badge.classList.toggle('recording', s === 'recording');
      badge.title = s === 'recording' ? '記録を止める (R)' : '再生を止める (L)';
    }
    refreshKeys();
  }

  app.on('take', refresh);
  app.on('status', refresh);
  app.on('file', refresh);
  app.store.on('project', ({ keys }) => { if (keys.includes('take')) refresh(); });
  app.store.on('replace', refresh);
  // 記録中・再生中は秒数を進める(表示が変わったときだけ書き換える)
  let last = 0;
  app.on('frame', () => {
    if (app.takeState === 'idle') return;
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    refresh();
  });
  refresh();
}
