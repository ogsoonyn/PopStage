/**
 * 3面図(正面・右から・下から・自由角度)。キャンバスは画面全体に敷いたまま、
 * 右側に並べたセルの位置を Stage へ渡して、その矩形に別のカメラで描かせる。
 * 正面・右から・下からの拡大率と平行移動は画面だけの設定で、保存も「未保存」の印も付けない。
 * 自由角度の視点はプロジェクトに保存するので、主ビューの視点と同じく動かすと「未保存」になる。
 * どちらもアンドゥには積まない。
 * 主ビューの平行移動と違って揺れの計算にも渡さない。
 */
import type { App } from '../app';
import { defaultMultiCamera, defaultOrthoView } from '../model/project';
import type { SubViewKind, ViewRect } from '../stage/stage';
import { $ } from './dom';

export function bindMultiView(app: App, canvas: HTMLCanvasElement): { layout: () => void } {
  const panel = $('multiView');
  const cells = [...panel.querySelectorAll<HTMLElement>('.mv-cell')];

  function layout(): void {
    const on = app.view.multi;
    panel.classList.toggle('hidden', !on);
    panel.classList.toggle('flex', on);
    if (!on) { app.stage.setLayout(null, []); return; }
    const c = canvas.getBoundingClientRect(), p = panel.getBoundingClientRect();
    const rel = (r: DOMRect): ViewRect => ({ x: Math.round(r.left - c.left), y: Math.round(r.top - c.top), w: Math.round(r.width), h: Math.round(r.height) });
    app.stage.setLayout(
      { x: 0, y: 0, w: Math.max(1, Math.round(p.left - c.left)), h: Math.round(c.height) },
      cells.map(el => ({ kind: el.dataset.kind as SubViewKind, rect: rel(el.getBoundingClientRect()) })),
    );
  }

  app.on('view', layout);
  new ResizeObserver(layout).observe(panel);

  for (const el of cells) el.addEventListener('contextmenu', e => e.preventDefault());

  /**
   * セルの上のドラッグ。どのボタンで何をするかは modeOf が決め、null なら受け付けない。
   * アンドゥには積まない(自由角度だけは move の中で「未保存」にする)
   */
  function bindDrag<M extends string>(el: HTMLElement, modeOf: (e: PointerEvent) => M | null, cursor: (m: M) => string,
    move: (m: M, dx: number, dy: number) => void): void {
    let drag: { id: number; x: number; y: number; mode: M } | null = null;
    el.addEventListener('pointerdown', e => {
      if (drag) return;
      const mode = modeOf(e);
      if (!mode) return;
      e.preventDefault(); // 中ボタンでの自動スクロールや文字の選択を始めない
      // preventDefault でフォーカスが移らないので、入力欄に残ったフォーカスを外す(ショートカットが効くように)
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) active.blur();
      el.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, mode };
      el.style.cursor = cursor(mode);
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      move(drag.mode, e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      el.style.cursor = '';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end); // ドラッグ中にセルが隠れたときも終える
  }

  // 自由角度: 左・右ドラッグで回転、中ドラッグ・Shift+左ドラッグで平行移動、ホイールでズーム、ダブルクリックで戻す
  const free = cells.find(el => el.dataset.kind === 'free')!;
  bindDrag(free,
    e => (e.button === 1 || (e.button === 0 && e.shiftKey) ? 'pan' : e.button === 0 || e.button === 2 ? 'orbit' : null),
    m => (m === 'pan' ? 'move' : 'grabbing'),
    (m, dx, dy) => {
      const cam = app.multiCam;
      app.cameraChanged(); // 自由角度の視点は保存するので、主ビューの視点と同じく「未保存」にする
      if (m === 'pan') { app.stage.panFree(cam, dx, dy); return; }
      cam.yaw -= dx * 0.01;
      cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.01));
    });
  free.addEventListener('dblclick', () => { app.multiCam = defaultMultiCamera(); app.cameraChanged(); });
  free.addEventListener('wheel', e => {
    e.preventDefault();
    const cam = app.multiCam;
    cam.zoom = Math.max(0.2, Math.min(10, cam.zoom * Math.exp(e.deltaY * 0.0012)));
    app.cameraChanged();
  }, { passive: false });

  // 正面・右から・下から: ドラッグで平行移動、ホイールでポインタの位置を中心にズーム、ダブルクリックで戻す。
  // 拡大率と平行移動は3つの図で共有する(縮尺と位置の対応がそろったままになる)
  for (const el of cells) {
    if (el === free) continue;
    const kind = el.dataset.kind as Exclude<SubViewKind, 'free'>;
    bindDrag(el, e => (e.button === 0 || e.button === 1 ? 'pan' : null), () => 'move',
      (_m, dx, dy) => app.stage.panOrtho(app.multiOrtho, kind, dx, dy));
    el.addEventListener('dblclick', () => { app.multiOrtho = defaultOrthoView(); });
    // 他のセルの上と同じく、ホイールで主ビューがズームしないよう既定の動作を止める
    el.addEventListener('wheel', e => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      app.stage.zoomOrtho(app.multiOrtho, kind, Math.exp(-e.deltaY * 0.0012),
        e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    }, { passive: false });
  }

  return { layout };
}
