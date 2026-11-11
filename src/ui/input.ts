/**
 * 3Dビュー上のポインタ操作。
 *   右ドラッグ: 回転 / 中ドラッグ・Space+左ドラッグ・「移動」の左ドラッグ: 平行移動 / ホイール: ズーム
 *   (平行移動で画像が画面上を動くと、塗った部分がその勢いで揺れる。physics/world.ts)
 *   左ドラッグ: 選択中のツール(ブラシ中に Alt で一時的に消しゴム。膨らませるでは範囲を描き、Shift で正円・正方形)
 *   「揺らす」の左ドラッグ: カメラを画像に付けたまま振る。画面上は動かず、平行移動と同じ揺れだけが出る
 *   Ctrl(⌘)か Shift を押している間は、回転・平行移動・ズーム・つかむ・揺らすの動きを 1/5 にする(ui/fine.ts)
 *   揺らし方「ピストン」で画像全体が動いている間は、塗り・膨らませる範囲のドラッグ中だけ画像を止め(app.holdImage)、
 *   止まっているポインタの下のブラシの円は毎フレーム当て直す
 * 指(タッチ)では、1本指は選択中のツール(画像の外では回転)、2本指は平行移動とピンチでズーム。
 *   2本目の指を置くと、1本目で始めた塗り・範囲・つかむは取り消す。2本指タップで戻す、3本指タップでやり直す、
 *   画像の外のダブルタップで視点を戻す
 */
import type { App } from '../app';
import type { PaintMode } from '../paint/stroke';
import { fineFactor, wheelFineFactor, wheelDelta, FINE, isFineLocked } from './fine';
import { toast } from './dom';

type DragMode = 'orbit' | 'pan' | 'shake' | 'grab' | 'paint' | 'area' | null;

export function bindStageInput(app: App, canvas: HTMLCanvasElement): { isSpaceDown: () => boolean } {
  /** gx, gy: つかんだまま動かした量(px、Ctrl・Shift で細かくした分を含む) */
  const drag = { mode: null as DragMode, id: -1, lx: 0, ly: 0, sx: 0, sy: 0, gx: 0, gy: 0 };
  /** 膨らませる範囲を描き始めた点(元画像のローカル座標) */
  let areaStart: { x: number; y: number } | null = null;
  let space = false, alt = false, hover: { x: number; y: number; inside: boolean } | null = null;
  /** ポインタがキャンバスの上にあるか。Space の平行移動はフォーカスの場所ではなくこれで決める */
  let pointerInside = false;
  /** 最後のポインタの位置(画像が動いたときに当て直す)と、前のフレームで画像がずれていたか */
  let last: { x: number; y: number } | null = null, shifted = false;

  const isPaintTool = () => app.tool === 'brush' || app.tool === 'erase' || app.tool === 'smooth';
  const paintMode = (): PaintMode => (app.tool === 'brush' && alt ? 'erase' : (app.tool as PaintMode));
  const pressureOf = (e: PointerEvent) => (e.pointerType === 'pen' ? Math.max(0.05, e.pressure || 0) : 1);

  const updateCursor = () => {
    const showBrush = isPaintTool() && !space && (drag.mode === null || drag.mode === 'paint');
    app.stage.setBrush(showBrush ? hover : null, app.brush.size / 2);
    canvas.style.cursor = space || drag.mode === 'pan' ? 'move'
      : drag.mode === 'orbit' ? 'grabbing'
      : app.tool === 'grab' || app.tool === 'shake' ? (drag.mode === 'grab' || drag.mode === 'shake' ? 'grabbing' : 'grab')
      // ブラシの円は画像の上にしか描けないので、画像の外では十字のカーソルを出して見失わないようにする
      : app.tool === 'view' || app.tool === 'pan' ? 'move' : showBrush && hover?.inside ? 'none' : 'crosshair';
  };
  app.on('tool', updateCursor);

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  /* ---------- 指(タッチ)の操作 ---------- */
  const touches = new Map<number, { x: number; y: number }>();
  /** 2本以上の指を置いている間の、指の中心と間隔 */
  let gesture: { x: number; y: number; d: number } | null = null;
  /** 触り始めてから全部の指を離すまでの記録(タップの判定に使う) */
  let tap: { t: number; n: number; moved: number; x: number; y: number; orbit: boolean } | null = null;
  /** 指ごとの置いた位置(タップかどうかは、それぞれの指が置いた所からどれだけ動いたかで決める) */
  const touchStart = new Map<number, { x: number; y: number }>();
  let lastTap: { t: number; x: number; y: number } | null = null;
  /** このドラッグで膨らませるのプレビューを始めたか(2本目の指で取り消すときは、始めたプレビューごと捨てる) */
  let areaBegan = false;
  /** プレビュー中の範囲を描き直し始めたときの範囲(2本目の指で描き直しをやめたら、これに戻す) */
  let areaBefore: { x: number; y: number; w: number; h: number } | null = null;
  const touchCenter = () => {
    let x = 0, y = 0;
    for (const p of touches.values()) { x += p.x; y += p.y; }
    return { x: x / touches.size, y: y / touches.size };
  };
  const touchSpread = () => {
    const [a, b] = [...touches.values()];
    return a && b ? Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) : 1;
  };
  /** 1本指で始めた操作をやめる(塗りと範囲は無かったことにする) */
  function cancelDrag(): void {
    if (drag.mode === 'paint') { app.cancelStroke(); app.holdImage(false); }
    else if (drag.mode === 'area') {
      areaStart = null; app.holdImage(false);
      if (areaBegan && app.previewingInflate) app.endInflate(false);
      else if (areaBefore && app.previewingInflate) app.updateInflate({ area: areaBefore });
    } else if (drag.mode === 'grab') { app.world.grab = null; app.world.grabGains.clear(); }
    else if (drag.mode === 'orbit' || drag.mode === 'pan') app.cameraChanged();
    drag.mode = null; drag.id = -1;
  }
  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    // 新しく触り始めた(最初の指)ときは、離した所がキャンバスの外で届かなかった指の記録を捨てる
    if (e.isPrimary) { touches.clear(); touchStart.clear(); gesture = null; tap = null; }
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    touchStart.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = performance.now();
    if (!tap) tap = { t: now, n: 0, moved: 0, x: e.clientX, y: e.clientY, orbit: false };
    tap.n = Math.max(tap.n, touches.size);
    if (touches.size < 2) return;
    // 2本目からは視点の操作にする。下の(1本指の)処理には渡さない
    e.stopImmediatePropagation();
    canvas.setPointerCapture(e.pointerId);
    if (drag.mode) cancelDrag();
    gesture = { ...touchCenter(), d: touchSpread() };
    updateCursor();
  });
  canvas.addEventListener('pointermove', e => {
    const t = touches.get(e.pointerId); if (!t) return;
    t.x = e.clientX; t.y = e.clientY;
    const s0 = touchStart.get(e.pointerId);
    if (tap && s0) tap.moved = Math.max(tap.moved, Math.hypot(e.clientX - s0.x, e.clientY - s0.y));
    if (!gesture || touches.size < 2) return;
    e.stopImmediatePropagation();
    const c = touchCenter(), d = touchSpread(), f = isFineLocked() ? FINE : 1;
    const dx = (c.x - gesture.x) * f, dy = (c.y - gesture.y) * f;
    const cam = app.project.camera, k = app.stage.pixelToWorld(cam), { right, up } = app.stage.screenAxes();
    // 平行移動は中ドラッグと同じ(画像が画面上を動くので、その勢いで揺れる)
    cam.target.x += -dx * k * right.x + dy * k * up.x;
    cam.target.y += -dx * k * right.y + dy * k * up.y;
    cam.target.z += -dx * k * right.z + dy * k * up.z;
    // 指を広げると近づく(zoom は小さいほど大きく見える)
    cam.zoom = Math.max(0.05, Math.min(10, cam.zoom * Math.pow(gesture.d / d, f)));
    gesture = { ...c, d };
    app.emit('status', undefined);
  });
  const touchEnd = (e: PointerEvent) => {
    touchStart.delete(e.pointerId);
    if (!touches.delete(e.pointerId)) return;
    if (gesture) {
      if (touches.size >= 2) gesture = { ...touchCenter(), d: touchSpread() };
      else { gesture = null; app.cameraChanged(); }
    }
    if (touches.size > 0 || !tap) return;
    const t = tap; tap = null;
    const quick = performance.now() - t.t < 300;
    if (t.n >= 2) {
      if (!quick || t.moved > 16 || app.stroking || app.previewingInflate) return;
      if (t.n === 2 ? app.history.undo() : app.history.redo()) toast(t.n === 2 ? '元に戻しました' : 'やり直しました');
      return;
    }
    // 画像の外のダブルタップで視点を戻す
    if (!t.orbit || !quick || t.moved > 10) { lastTap = null; return; }
    const now = performance.now();
    if (lastTap && now - lastTap.t < 350 && Math.hypot(lastTap.x - t.x, lastTap.y - t.y) < 32) { lastTap = null; app.resetView(); }
    else lastTap = { t: now, x: t.x, y: t.y };
  };

  canvas.addEventListener('pointerdown', e => {
    if (drag.mode || !app.doc) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    drag.id = e.pointerId; drag.lx = drag.sx = e.clientX; drag.ly = drag.sy = e.clientY;
    alt = e.altKey;
    // 指では、画像の外をなぞると回転する(右ドラッグの代わり)
    const outside = e.pointerType === 'touch' && app.tool !== 'pan' && !app.stage.pick(e.clientX, e.clientY)?.inside;
    if (e.button === 2 || (e.button === 0 && (app.tool === 'view' || outside) && !space)) drag.mode = 'orbit';
    else if (e.button === 1 || (e.button === 0 && (space || app.tool === 'pan'))) { drag.mode = 'pan'; e.preventDefault(); }
    // 振る向きは主ビューの画面の向きで決まるので、主ビューの中から始めたときだけ振る
    else if (e.button === 0 && app.tool === 'shake') { if (app.stage.inMainView(e.clientX, e.clientY)) drag.mode = 'shake'; }
    else if (e.button === 0 && app.tool === 'grab') startGrab(e);
    else if (e.button === 0 && app.tool === 'inflate') startArea(e);
    else if (e.button === 0 && isPaintTool()) {
      const p = app.stage.pick(e.clientX, e.clientY);
      if (p && app.beginStroke(paintMode(), p.x, p.y, pressureOf(e))) { drag.mode = 'paint'; app.holdImage(true); }
    }
    if (tap && e.pointerType === 'touch') tap.orbit = drag.mode === 'orbit';
    updateCursor();
  });

  // 画像全体が動いている間(ピストン)は、ポインタが止まっていても、その下の画像の位置でブラシの円を描き直す
  app.on('frame', () => {
    const now = app.imageShifted;
    if ((now || shifted) && pointerInside && last && !drag.mode) {
      const p = app.stage.pick(last.x, last.y);
      hover = p ? { x: p.x, y: p.y, inside: p.inside } : null;
      updateCursor();
    }
    shifted = now;
  });

  canvas.addEventListener('pointermove', e => {
    const p = app.stage.pick(e.clientX, e.clientY);
    hover = p ? { x: p.x, y: p.y, inside: p.inside } : null;
    last = { x: e.clientX, y: e.clientY };
    if (drag.mode && e.pointerId === drag.id) {
      // 回転・平行移動・揺らす・つかむは、Ctrl か Shift を押している間だけ細かく動かす(押し直しても跳ばない)
      const f = fineFactor(e), dx = (e.clientX - drag.lx) * f, dy = (e.clientY - drag.ly) * f;
      drag.lx = e.clientX; drag.ly = e.clientY;
      const cam = app.project.camera;
      if (drag.mode === 'orbit') {
        cam.yaw -= dx * 0.008;
        cam.pitch = Math.max(-1.45, Math.min(1.45, cam.pitch + dy * 0.008));
      } else if (drag.mode === 'pan' || drag.mode === 'shake') {
        // 「揺らす」はカメラを画像に付けたまま振る。画面上の位置は変えず、物理にだけ平行移動と同じ動きを伝える
        const k = app.stage.pixelToWorld(cam), { right, up } = app.stage.screenAxes();
        const t = drag.mode === 'pan' ? cam.target : app.shake;
        t.x += -dx * k * right.x + dy * k * up.x;
        t.y += -dx * k * right.y + dy * k * up.y;
        t.z += -dx * k * right.z + dy * k * up.z;
      } else if (drag.mode === 'grab') {
        drag.gx += dx; drag.gy += dy;
        moveGrab();
      } else if (drag.mode === 'area') {
        moveArea(e);
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
    if (drag.mode === 'area') areaStart = null;
    if (drag.mode === 'paint' || drag.mode === 'area') app.holdImage(false);
    if ((drag.mode === 'orbit' || drag.mode === 'pan') && (e.clientX !== drag.sx || e.clientY !== drag.sy)) app.cameraChanged();
    drag.mode = null; drag.id = -1;
    updateCursor();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerup', touchEnd);
  canvas.addEventListener('pointercancel', touchEnd);
  canvas.addEventListener('lostpointercapture', end); // pointerup が来ないまま捕捉が外れても、ドラッグ(と止めた画像)を終える
  canvas.addEventListener('pointerenter', () => { pointerInside = true; });
  canvas.addEventListener('pointerleave', () => { pointerInside = false; hover = null; last = null; updateCursor(); });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const cam = app.project.camera;
    cam.zoom = Math.max(0.05, Math.min(10, cam.zoom * Math.exp(wheelDelta(e) * 0.0012 * wheelFineFactor(e))));
    app.emit('status', undefined);
    app.cameraChanged();
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
    drag.gx = drag.gy = 0;
    drag.mode = 'grab';
  }

  function moveGrab(): void {
    const cam = app.project.camera, k = app.stage.pixelToWorld(cam), { right, up } = app.stage.screenAxes();
    const dx = drag.gx * k, dy = -drag.gy * k, norm = 2 / app.imageLong;
    app.world.grab = {
      x: (right.x * dx + up.x * dy) * norm,
      y: (right.y * dx + up.y * dy) * norm,
      z: (right.z * dx + up.z * dy) * norm,
    };
  }

  /** 膨らませる: ドラッグした矩形(Shift で正方形)に収まる楕円・矩形を描く。プレビュー中なら描き直す */
  function startArea(e: PointerEvent): void {
    const p = app.stage.pick(e.clientX, e.clientY);
    if (!p) return;
    areaStart = { x: p.x, y: p.y };
    areaBegan = false;
    const prev = app.inflateState?.area;
    areaBefore = prev ? { x: prev.x, y: prev.y, w: prev.w, h: prev.h } : null;
    drag.mode = 'area';
    app.holdImage(true);
  }

  // Esc などでプレビューが終わったら、描いている途中の範囲も捨てる(次に動かしたときに始め直さない)
  app.on('inflate', phase => { if (phase === 'end' && drag.mode === 'area') { drag.mode = null; areaStart = null; app.holdImage(false); updateCursor(); } });

  function moveArea(e: PointerEvent): void {
    const p = app.stage.pick(e.clientX, e.clientY);
    if (!p || !areaStart) return;
    const dx = p.x - areaStart.x, dy = p.y - areaStart.y;
    let w = Math.abs(dx), h = Math.abs(dy);
    if (e.shiftKey) w = h = Math.max(w, h);
    if (w < 2 || h < 2) return;
    const area = { x: areaStart.x + Math.sign(dx || 1) * w / 2, y: areaStart.y + Math.sign(dy || 1) * h / 2, w: Math.round(w), h: Math.round(h) };
    if (app.previewingInflate) app.updateInflate({ area });
    else if (app.beginInflateArea(area)) areaBegan = true;
    else { drag.mode = null; areaStart = null; app.holdImage(false); }
  }

  window.addEventListener('keydown', e => {
    if (e.key === 'Alt') { alt = true; e.preventDefault(); }
    // ボタンなどにフォーカスが残っていても、ポインタがキャンバス上にあれば平行移動にする。
    // キャンバスの外では Space をボタンの押下などに使えるよう、横取りしない
    // 画面を覆うダイアログの表示中は、ボタンなどを Space で押せるよう横取りしない(膨らませるのパネルは除く)
    const dialogOpen = !!document.querySelector('dialog[open]:modal');
    if (e.code === 'Space' && !isTextEntry(e) && !dialogOpen && (space || pointerInside || drag.mode !== null || e.target === canvas || e.target === document.body)) {
      if (!space) { space = true; updateCursor(); }
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', e => {
    if (e.key === 'Alt') { alt = false; e.preventDefault(); }
    if (e.code === 'Space' && space) {
      space = false; updateCursor();
      e.preventDefault(); // フォーカス中のボタンが Space の離しで押されないようにする
    }
  });
  window.addEventListener('blur', () => { space = false; alt = false; });

  return { isSpaceDown: () => space };
}

/** 文字を打つ欄(テキスト・数値の入力欄など)にいるか。Space をキャンバスの平行移動に使うかの判定に使う */
function isTextEntry(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.matches('textarea, input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=color]):not([type=button]):not([type=submit]):not([type=file])') || t.isContentEditable);
}

export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.matches('input:not([type=range]):not([type=checkbox]):not([type=radio]), select, textarea') || t.isContentEditable);
}
