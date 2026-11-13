/**
 * 再生・記録の進み具合のバー。ループ再生中と記録中だけ、主ビューの下に重ねて出す(3面図が出ているときはその左まで)。
 *
 * - 再生中: 停止・一時停止・時間・トラック・ループの印・カメラを戻す。トラックを押す・ドラッグすると、その位置へ移る
 *   (ドラッグの間は一時停止してその瞬間を見せ、離すと元の状態で続ける)。キーフレームから作った動きなら、
 *   各フレームを通る時刻に番号を出す(形は枠表示と同じで、なめらかは丸、弾むはひし形)。番号を押すとその時刻へ移る。
 * - 記録中: 赤いバーで最長(60 秒)までの進みを出す。■ で記録を止める。位置は動かせない。
 * - 書き出し中は出さない(画面の部品なので、書き出した絵には入らない)。
 */
import type { App } from '../app';
import { keyCurve, TAKE_MAX_SECONDS, type Take } from '../physics/take';
import { PHYSICS_DT } from '../physics/world';
import { ui } from './ids';
import { icon } from './icons';

const fmt = (v: number) => v.toFixed(1);
/** ボタンの印。⏸ などの文字は絵文字で出る環境があるので、塗りの SVG にする */
const svg = (d: string) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">${d}</svg>`;
const ICON_STOP = svg('<rect x="3" y="3" width="10" height="10" rx="1"/>');
const ICON_PAUSE = svg('<rect x="3.5" y="2.5" width="3" height="11" rx=".8"/><rect x="9.5" y="2.5" width="3" height="11" rx=".8"/>');
const ICON_PLAY = svg('<path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.2-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5z"/>');
/** ←・→ で動かす秒数(Shift で細かく) */
const STEP = 0.5, FINE_STEP = 0.1;
/** 番号を押したあと、これより動かすまでは番号の時刻のまま(px) */
const DRAG_SLOP = 6;

export function bindPlayBar(app: App): void {
  const { playBar: bar, playStop: stop, playPause: pause, playTime: time, playTrack: track, playKeys: keys, playLoop: loop, playCam: cam } = ui;
  const fill = track.querySelector<HTMLElement>('.play-fill')!, head = track.querySelector<HTMLElement>('.play-head')!;
  cam.querySelector('.play-cam-icon')!.innerHTML = icon('keySet');
  stop.innerHTML = ICON_STOP;

  // 停止は記録中にも使う(記録を止める)ので、再生だけに効くコマンド(stopPlay)にはせず、ここで分ける。
  // 一時停止はコマンド(togglePlayPause、data-cmd)で、押したときの処理・キー・ツールチップは ui/actions.ts
  stop.addEventListener('click', () => { if (app.takeState === 'recording') app.stopRecording(); else app.stopTake(); });

  /** 再生中の1周の長さ(秒) */
  const length = () => app.takeLength;

  /* ---------- トラック: 押す・ドラッグで位置を移す ---------- */
  /** onKey: 番号を押して、まだ動かしていない(少しの揺れでは番号の時刻から離さない) */
  let drag: { id: number; wasPaused: boolean; x: number; onKey: boolean } | null = null;
  const timeAt = (clientX: number) => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * length();
  };
  track.addEventListener('pointerdown', e => {
    if (app.takeState !== 'playing' || drag || e.button !== 0) return;
    e.preventDefault();
    track.focus({ preventScroll: true });
    track.setPointerCapture(e.pointerId);
    // 番号を押したときは、その番号の時刻ちょうどへ
    const k = (e.target as HTMLElement).closest<HTMLElement>('.play-key');
    drag = { id: e.pointerId, wasPaused: app.playPaused, x: e.clientX, onKey: !!k };
    app.setPlayPaused(true);
    app.seekTake(k ? +k.dataset.t! : timeAt(e.clientX));
    refresh();
  });
  track.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.onKey && Math.abs(e.clientX - drag.x) < DRAG_SLOP) return;
    drag.onKey = false;
    app.seekTake(timeAt(e.clientX));
    refresh();
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    const was = drag.wasPaused;
    drag = null;
    app.setPlayPaused(was);
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('lostpointercapture', end);
  track.addEventListener('keydown', e => {
    // 修飾キー付き(Shift+Home のカメラを戻すなど)はショートカットに渡す。Shift は矢印の細かい刻みにだけ使う
    if (app.takeState !== 'playing' || e.ctrlKey || e.altKey || e.metaKey) return;
    const len = length(), pos = app.takePosition, step = e.shiftKey ? FINE_STEP : STEP, arrow = e.key.startsWith('Arrow');
    if (e.shiftKey && !arrow) return;
    // PageUp・PageDown は前・次のキーフレームの番号の時刻へ
    const marks = [...keys.querySelectorAll<HTMLElement>('.play-key')].map(k => +k.dataset.t!);
    let to: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = Math.max(0, pos - step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = Math.min(len - PHYSICS_DT, pos + step);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = len - PHYSICS_DT;
    else if (e.key === 'PageDown' && marks.length) to = marks.find(t => t > pos + 1e-6) ?? marks[0];
    else if (e.key === 'PageUp' && marks.length) to = [...marks].reverse().find(t => t < pos - 1e-6) ?? marks.at(-1)!;
    if (to === null) return;
    // 視点のリセット(Home)などのショートカットに渡さない
    e.preventDefault(); e.stopPropagation();
    app.seekTake(to);
    refresh();
  });

  /* ---------- キーフレームの番号 ---------- */
  let keysOf: Take | null | undefined;
  function buildKeys(take: Take | null): void {
    if (take === keysOf) return;
    keysOf = take;
    const curve = take?.keys ? keyCurve(take.keys, app.project.camera.fov) : null;
    keys.replaceChildren(...(curve ? curve.starts.map((t, i) => {
      // 記録は1周の刻み数をそろえるため少し伸び縮みしているので、時刻は1周に対する割合で置く
      const s = document.createElement('span'), f = t / curve.total;
      s.className = 'play-key';
      s.dataset.mode = curve.keys[i].mode;
      s.dataset.t = String(f * takeLen(take));
      s.style.left = `${f * 100}%`;
      s.textContent = String(i + 1);
      s.title = `${i + 1} 番のフレーム(${curve.keys[i].mode === 'bounce' ? '弾む' : 'なめらか'})へ移る`;
      return s;
    }) : []));
  }
  const takeLen = (take: Take | null) => (take?.samples.length ?? 0) * PHYSICS_DT;

  /* ---------- 表示 ---------- */
  const setText = (el: Element, text: string) => { if (el.textContent !== text) el.textContent = text; };
  function refresh(): void {
    const s = app.takeState, show = s !== 'idle' && !app.exporting;
    if (bar.hidden === show) {
      // 隠すときにバーの中にフォーカスがあれば、3Dビューへ移す(居場所が分からなくならないように)
      if (!show && bar.contains(document.activeElement)) ui.view.focus({ preventScroll: true });
      bar.hidden = !show;
    }
    if (!show) return;
    const rec = s === 'recording', len = rec ? TAKE_MAX_SECONDS : length(), pos = rec ? app.takeLength : app.takePosition;
    bar.classList.toggle('recording', rec);
    pause.hidden = loop.hidden = cam.hidden = rec;
    stop.setAttribute('aria-label', rec ? '記録を止める' : '停止');
    stop.title = rec ? '記録を止める (R)' : '再生を止める (L)';
    const paused = !rec && app.playPaused;
    if (pause.dataset.icon !== String(paused)) { pause.dataset.icon = String(paused); pause.innerHTML = paused ? ICON_PLAY : ICON_PAUSE; }
    // 名前は「一時停止」のまま、押されているかで状態を伝える
    pause.setAttribute('aria-pressed', String(paused));
    setText(time, rec ? `● ${fmt(pos)} / ${fmt(len)}秒` : `${fmt(pos)} / ${fmt(len)}秒`);
    const p = len > 0 ? Math.min(1, pos / len) : 0;
    fill.style.width = `${p * 100}%`;
    head.style.left = `${p * 100}%`;
    head.hidden = rec;
    track.setAttribute('aria-valuemax', fmt(len));
    // 読み上げの値は、進んでいる間は1秒ごとにだけ変える(しゃべり続けないように)
    const spoken = rec || !paused ? Math.floor(pos).toFixed(0) : fmt(pos);
    if (track.getAttribute('aria-valuenow') !== spoken) {
      track.setAttribute('aria-valuenow', spoken);
      track.setAttribute('aria-valuetext', `${spoken}秒 / ${fmt(len)}秒`);
    }
    track.setAttribute('aria-disabled', String(rec));
    track.tabIndex = rec ? -1 : 0;
    buildKeys(rec ? null : app.project.take);
  }

  app.on('take', refresh);
  app.on('status', refresh);
  app.on('file', refresh);
  app.store.on('replace', refresh);
  app.store.on('project', ({ keys: k }) => { if (k.includes('take')) refresh(); });
  // 進み具合は描画のたびに追う(書き換えは軽いので間引かない)
  app.on('frame', () => { if (app.takeState !== 'idle') refresh(); });
  refresh();
}
