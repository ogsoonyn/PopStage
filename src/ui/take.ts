/**
 * 操作の記録とループ再生のボタン(右のパネル。スマホではシートの「揺れ」タブへ移す)と、3Dビューの左上の印。
 */
import type { App } from '../app';
import { $ } from './dom';

export function bindTakeControls(app: App): void {
  const rec = $<HTMLButtonElement>('takeRec'), play = $<HTMLButtonElement>('takePlay'), clear = $<HTMLButtonElement>('takeClear');
  const info = $('takeInfo'), badge = $<HTMLButtonElement>('takeBadge');
  const label = (b: HTMLElement) => b.querySelector<HTMLElement>('[data-label]')!;

  rec.addEventListener('click', () => app.toggleRecording());
  play.addEventListener('click', () => app.togglePlay());
  clear.addEventListener('click', () => app.clearTake());
  badge.addEventListener('click', () => { if (app.takeState === 'recording') app.stopRecording(); else app.stopTake(); });

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
      : has ? `${len.toFixed(1)} 秒の記録があります。保存すると .pukupop に入ります。`
      : '「記録」を押してから、つかむ・揺らす・移動・視点で動かし、止めるとループ再生できます。';
    const text = s === 'recording' ? `記録中 ${len.toFixed(1)}秒 ■` : s === 'playing' ? `▶ ループ再生中 ${app.takePosition.toFixed(1)}/${len.toFixed(1)}秒 ■` : '';
    if (text !== shown) {
      shown = text;
      badge.textContent = text;
      badge.classList.toggle('hidden', !text);
      badge.classList.toggle('recording', s === 'recording');
      badge.title = s === 'recording' ? '押すと記録を止める (R)' : '押すと再生を止める (L)';
    }
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
