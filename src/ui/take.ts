/**
 * 操作の記録とループ再生のボタン(右のパネル。スマホではシートの「揺れ」タブへ移す)と、3Dビューの左上の印。
 */
import type { App } from '../app';
import { $ } from './dom';
import { PATH_SECONDS } from '../physics/take';

export function bindTakeControls(app: App): void {
  const rec = $<HTMLButtonElement>('takeRec'), play = $<HTMLButtonElement>('takePlay'), clear = $<HTMLButtonElement>('takeClear');
  const info = $('takeInfo'), badge = $<HTMLButtonElement>('takeBadge');
  const label = (b: HTMLElement) => b.querySelector<HTMLElement>('[data-label]')!;

  rec.addEventListener('click', () => app.toggleRecording());
  play.addEventListener('click', () => app.togglePlay());
  clear.addEventListener('click', () => app.clearTake());
  badge.addEventListener('click', () => { if (app.takeState === 'recording') app.stopRecording(); else app.stopTake(); });

  /* ---------- スタートとエンドで動きを作る ---------- */
  const sec = $<HTMLInputElement>('pathSec'), secO = $('pathSecO'), easeSel = $<HTMLSelectElement>('pathEase'), repeatSel = $<HTMLSelectElement>('pathRepeat');
  const make = $<HTMLButtonElement>('pathMake'), pathInfo = $('pathInfo');
  sec.min = String(PATH_SECONDS.min * 10); sec.max = String(PATH_SECONDS.max * 10);
  $('pathSetStart').addEventListener('click', () => app.setPathKey('start'));
  $('pathSetEnd').addEventListener('click', () => app.setPathKey('end'));
  $('pathGoStart').addEventListener('click', () => app.gotoPathKey('start'));
  $('pathGoEnd').addEventListener('click', () => app.gotoPathKey('end'));
  sec.addEventListener('input', () => app.setPathOption({ seconds: +sec.value / 10 }));
  easeSel.addEventListener('change', () => app.setPathOption({ ease: easeSel.value as 'smooth' | 'linear' }));
  repeatSel.addEventListener('change', () => app.setPathOption({ repeat: repeatSel.value as 'pingpong' | 'loop' }));
  make.addEventListener('click', () => app.makePathTake());

  function refreshPath(): void {
    const d = app.pathDraft, ready = !!d.start && !!d.end;
    $('pathSetStart').parentElement!.dataset.set = String(!!d.start);
    $('pathSetEnd').parentElement!.dataset.set = String(!!d.end);
    $<HTMLButtonElement>('pathGoStart').disabled = !d.start;
    $<HTMLButtonElement>('pathGoEnd').disabled = !d.end;
    if (document.activeElement !== sec) sec.value = String(Math.round(d.seconds * 10));
    secO.textContent = `${d.seconds.toFixed(1)}秒`;
    easeSel.value = d.ease; repeatSel.value = d.repeat;
    make.disabled = !ready || !app.doc || app.exporting;
    const loop = d.repeat === 'pingpong' ? d.seconds * 2 : d.seconds;
    pathInfo.textContent = ready ? `1周 ${loop.toFixed(1)} 秒。作ると今の記録と入れ替わります(元に戻せます)。`
      : 'スタートとエンドに視点を決めてください。視点を回す・ズームする・画像を動かしてから「今の視点にする」を押します。';
  }

  let shown = '';
  function refresh(): void {
    const s = app.takeState, has = !!app.project.take, len = app.takeLength;
    rec.disabled = !app.doc || app.exporting;
    play.disabled = !has || s === 'recording' || app.exporting;
    clear.disabled = !has || s === 'recording';
    label(rec).textContent = s === 'recording' ? '記録を止める' : '記録';
    rec.setAttribute('aria-pressed', String(s === 'recording'));
    play.querySelector('[data-icon]')!.textContent = s === 'playing' ? '■' : '▶';
    label(play).textContent = s === 'playing' ? '再生を止める' : 'ループ再生';
    play.setAttribute('aria-pressed', String(s === 'playing'));
    info.textContent = s === 'recording' ? `記録中 ${len.toFixed(1)} 秒(最長 60 秒)。つかむ・揺らす・移動・視点で動かしてから止めてください。`
      : s === 'playing' ? `${app.takePosition.toFixed(1)} / ${len.toFixed(1)} 秒をくり返し再生中。画面を触ると止まります。`
      : has ? `${len.toFixed(1)} 秒の${app.project.take?.path ? '動き(スタートとエンドから作ったもの)' : '記録'}があります。保存すると .pukupop に入ります。`
      : '「記録」を押してから、つかむ・揺らす・移動・視点で動かし、止めるとループ再生できます。';
    const text = s === 'recording' ? `記録中 ${len.toFixed(1)}秒 ■` : s === 'playing' ? `▶ ループ再生中 ${app.takePosition.toFixed(1)}/${len.toFixed(1)}秒 ■` : '';
    if (text !== shown) {
      shown = text;
      badge.textContent = text;
      badge.classList.toggle('hidden', !text);
      badge.classList.toggle('recording', s === 'recording');
      badge.title = s === 'recording' ? '押すと記録を止める (R)' : '押すと再生を止める (L)';
    }
    refreshPath();
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
