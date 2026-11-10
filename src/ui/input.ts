/**
 * 3Dビュー上のポインタ操作。
 *   右ドラッグ: 回転 / 中ドラッグ・Space+左ドラッグ: 平行移動 / ホイール: ズーム
 *   左ドラッグ: 選択中のツール(ブラシ中に Alt で一時的に消しゴム)
 */
import type { App } from '../app';
import type { PaintMode } from '../paint/stroke';

type DragMode = 'orbit' | 'pan' | 'grab' | 'paint' | null;

export function bindStageInput(app: App, canvas: HTMLCanvasElement): { isSpaceDown: () => boolean } {
  const drag = { mode: null as DragMode, id: -1, lx: 0, ly: 0, sx: 0, sy: 0 };
  let space = false, alt = false, hover: { x: number; y: number } | null = null;

  const isPaintTool = () => app.tool === 'brush' || app.tool === 'erase' || app.tool === 'smooth';
  const paintMode = (): PaintMode => (app.tool === 'brush' && alt ? 'erase' : (app.tool as PaintMode));
  const pressureOf = (e: PointerEvent) => (e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0) : 1);

  const updateCursor = () => {
    const showBrush = isPaintTool() && !space && (drag.mode === null || drag.mode === 'paint');
    app.stage.setBrush(showBrush ? hover : null, app.brush.size / 2);
    canvas.style.cursor = space || drag.mode === 'pan' ? 'move'
      : drag.mode === 'orbit' ? 'grabbing'
      : app.tool === 'grab' ? (drag.mode === 'grab' ? 'grabbing' : 'grab')
      : app.tool === 'view' ? 'move' : showBrush && hover ? 'none' : 'crosshair';
  };
  app.on('tool', updateCursor);

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  canvas.addEventListener('pointerdown', e => {
    if (drag.mode || !app.doc) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    drag.id = e.pointerId; drag.lx = drag.sx = e.clientX; drag.ly = drag.sy = e.clientY;
    alt = e.altKey;
    if (e.button === 2 || (e.button === 0 && app.tool === 'view' && !space)) drag.mode = 'orbit';
    else if (e.button === 1 || (e.button === 0 && space)) { drag.mode = 'pan'; e.preventDefault(); }
    else if (e.button === 0 && app.tool === 'grab') startGrab(e);
    else if (e.button === 0 && isPaintTool()) {
      const p = app.stage.pick(e.clientX, e.clientY);
      if (p && app.beginStroke(paintMode(), p.x, p.y, pressureOf(e))) drag.mode = 'paint';
    }
    updateCursor();
  });

  canvas.addEventListener('pointermove', e => {
    const p = app.stage.pick(e.clientX, e.clientY);
    hover = p ? { x: p.x, y: p.y } : null;
    if (drag.mode && e.pointerId === drag.id) {
      const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly;
      drag.lx = e.clientX; drag.ly = e.clientY;
      const cam = app.project.camera;
      if (drag.mode === 'orbit') {
        cam.yaw -= dx * 0.008;
        cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.008));
      } else if (drag.mode === 'pan') {
        const k = app.stage.pixelToWorld(cam), { right, up } = app.stage.screenAxes();
        cam.target.x += -dx * k * right.x + dy * k * up.x;
        cam.target.y += -dx * k * right.y + dy * k * up.y;
        cam.target.z += -dx * k * right.z + dy * k * up.z;
      } else if (drag.mode === 'grab') {
        moveGrab(e);
      } else if (drag.mode === 'paint') {
        // 速い動きでも線が途切れないよう、まとめられたイベントも使う
        const events = e.getCoalescedEvents?.() ?? [e];
        for (const ce of events.length ? events : [e]) {
          const q = app.stage.pick(ce.clientX, ce.clientY);
          if (q) app.strokeTo(q.x, q.y, pressureOf(ce));
        }
      }
    }
    updateCursor();
  });

  const end = (e: PointerEvent) => {
    if (e.pointerId !== drag.id) return;
    if (drag.mode === 'paint') app.endStroke();
    if (drag.mode === 'grab') { app.world.grab = null; app.world.grabGains.clear(); }
    drag.mode = null; drag.id = -1;
    updateCursor();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { hover = null; updateCursor(); });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const cam = app.project.camera;
    cam.zoom = Math.max(0.05, Math.min(10, cam.zoom * Math.exp(e.deltaY * 0.0012)));
    app.emit('status', undefined);
  }, { passive: false });

  function startGrab(e: PointerEvent): void {
    const doc = app.doc!, p = app.stage.pick(e.clientX, e.clientY);
    // つかんだ位置のウェイトが大きいレイヤーほど強く引っ張る。どこにも塗りが無ければ全レイヤー
    const gains = new Map<string, number>();
    let max = 0;
    for (const l of doc.layers) {
      const w = p && p.inside ? l.weights.sampleUV(p.u, p.v) : 0;
      gains.set(l.id, w); max = Math.max(max, w);
    }
    for (const [id, w] of gains) gains.set(id, max < 0.05 ? 1 : Math.max(0.15, w / max));
    app.world.grabGains = gains;
    app.world.grab = { x: 0, y: 0, z: 0 };
    drag.mode = 'grab';
  }

  function moveGrab(e: PointerEvent): void {
    const cam = app.project.camera, k = app.stage.pixelToWorld(cam), { right, up } = app.stage.screenAxes();
    const dx = (e.clientX - drag.sx) * k, dy = -(e.clientY - drag.sy) * k, norm = 2 / app.imageLong;
    app.world.grab = {
      x: (right.x * dx + up.x * dy) * norm,
      y: (right.y * dx + up.y * dy) * norm,
      z: (right.z * dx + up.z * dy) * norm,
    };
  }

  window.addEventListener('keydown', e => {
    if (e.key === 'Alt') { alt = true; e.preventDefault(); }
    if (e.code === 'Space' && !isTyping(e) && (e.target === canvas || e.target === document.body)) {
      if (!space) { space = true; updateCursor(); }
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'Alt') { alt = false; e.preventDefault(); }
    if (e.code === 'Space') { space = false; updateCursor(); }
  });
  window.addEventListener('blur', () => { space = false; alt = false; });

  return { isSpaceDown: () => space };
}

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.matches('input:not([type=range]):not([type=checkbox]):not([type=radio]), select, textarea') || t.isContentEditable);
}
