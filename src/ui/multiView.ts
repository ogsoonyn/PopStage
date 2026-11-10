/**
 * 3面図(正面・右から・下から・自由角度)。キャンバスは画面全体に敷いたまま、
 * 右側に並べたセルの位置を Stage へ渡して、その矩形に別のカメラで描かせる。
 */
import type { App } from '../app';
import { defaultMultiCamera } from '../model/project';
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

  // 自由角度: ドラッグで回転、ホイールでズーム、ダブルクリックで戻す
  const free = cells.find(el => el.dataset.kind === 'free')!;
  let drag: { id: number; x: number; y: number } | null = null;
  free.addEventListener('pointerdown', e => {
    if (e.button !== 0 && e.button !== 2) return;
    free.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    free.classList.replace('cursor-grab', 'cursor-grabbing');
  });
  free.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const cam = app.multiCam;
    cam.yaw -= (e.clientX - drag.x) * 0.01;
    cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + (e.clientY - drag.y) * 0.01));
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    free.classList.replace('cursor-grabbing', 'cursor-grab');
  };
  free.addEventListener('pointerup', end);
  free.addEventListener('pointercancel', end);
  free.addEventListener('contextmenu', e => e.preventDefault());
  free.addEventListener('dblclick', () => { app.multiCam = defaultMultiCamera(); });
  free.addEventListener('wheel', e => {
    e.preventDefault();
    const cam = app.multiCam;
    cam.zoom = Math.max(0.2, Math.min(10, cam.zoom * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });
  // 他のセルの上ではホイールで主ビューがズームしないようにする
  for (const el of cells) if (el !== free) el.addEventListener('wheel', e => e.preventDefault(), { passive: false });

  return { layout };
}
