/**
 * 操作の記録・ループ再生とキーフレームの部品(右のパネルの「アニメーション」。スマホではシートの「アニメ」タブへ移す)と、
 * 3Dビューの左上の印。説明は文章で並べず、状態は短いラベル、詳しいことはツールチップに置く。
 * 記録・再生・消すのボタンはコマンド(data-cmd。押したときの処理・使えるか・ツールチップは ui/actions.ts)で、ここは表示だけを変える。
 */
import type { App } from '../app';
import { ui } from './ids';
import { icon } from './icons';
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

  /*
   * 一覧はフレームの行と、その間の行を交互に並べる。フレームの行は、そのフレームの瞬間の値(番号・通り方)と上書き・削除。
   * 間の行は、次のフレームまでの秒数(2つ以上のとき)。最後のフレームの後には、最初へ戻るまでの秒数と、薄い最初の番号を出す。
   */
  function keyRow(): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'key-row';
    // 番号・通り方・今の視点で上書き・削除の順(上書きと削除は行の末尾に寄せる)
    li.innerHTML = `<button class="btn btn-xs btn-ghost key-no" data-act="go" title="この視点を見る"></button>`
      + `<select data-act="mode" class="select select-xs" title="なめらか: 止まらず通り抜ける / 弾む: 勢いよく着いて止まり、揺れる" aria-label="通り方"><option value="smooth">なめらか</option><option value="bounce">弾む</option></select>`
      + `<button class="btn btn-xs btn-ghost btn-square key-set" data-act="set" title="今の視点で上書きする" aria-label="今の視点で上書き">${icon('keySet')}</button>`
      + `<button class="btn btn-xs btn-ghost btn-square" data-act="del" title="削除" aria-label="削除">×</button>`;
    return li;
  }
  function gapRow(): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'key-gap';
    li.innerHTML = `<span class="key-arrow" aria-hidden="true"></span>`
      + `<label class="flex items-center gap-0.5"><input data-act="sec" type="number" min="${KEY_SECONDS.min}" max="${KEY_SECONDS.max}" step="0.1" class="input input-xs w-14 text-right"><span class="text-xs">秒</span></label>`;
    return li;
  }
  function backRow(): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'key-row key-back';
    li.setAttribute('aria-hidden', 'true');
    li.innerHTML = `<span class="key-no">1</span><span class="text-xs">最初へ戻る</span>`;
    return li;
  }

  /** 並びの形(フレームの数)が変わったときだけ行を作り直す。入力中の欄を消さないように */
  let built = -1;
  function buildKeys(n: number): void {
    if (n === built) return;
    built = n;
    const rows: HTMLLIElement[] = [];
    for (let i = 0; i < n; i++) {
      const r = keyRow(); r.dataset.key = String(i); rows.push(r);
      if (n < 2) continue;
      const g = gapRow(); g.dataset.key = String(i); rows.push(g);
      const last = i === n - 1;
      g.classList.toggle('back', last);
      g.querySelector('.key-arrow')!.textContent = last ? '↩' : '↓';
      const s = g.querySelector<HTMLInputElement>('[data-act=sec]')!;
      s.title = last ? `${n} から 1 へ戻るまでの時間` : `${i + 1} から ${i + 2} までの時間`;
      s.setAttribute('aria-label', last ? `${n}から1へ戻るまで(秒)` : `${i + 1}から${i + 2}まで(秒)`);
    }
    if (n >= 2) rows.push(backRow());
    list.replaceChildren(...rows);
  }

  function refreshKeys(): void {
    const keys = app.keyDraft;
    buildKeys(keys.length);
    keys.forEach((k, i) => {
      const row = list.querySelector<HTMLLIElement>(`.key-row[data-key="${i}"]`)!;
      row.querySelector('.key-no')!.textContent = String(i + 1);
      const m = row.querySelector<HTMLSelectElement>('[data-act=mode]')!;
      if (m.value !== k.mode) m.value = k.mode;
      // 入力中の欄は書き換えない
      const s = list.querySelector<HTMLInputElement>(`.key-gap[data-key="${i}"] [data-act=sec]`);
      if (s && document.activeElement !== s && +s.value !== k.seconds) s.value = k.seconds.toFixed(1);
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
