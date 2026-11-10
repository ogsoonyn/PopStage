/**
 * パフォーマンスのデバッグ表示。?debug を付けて開くか、Ctrl+Shift+Alt+P で出し入れする。
 * 表示している間だけ、フレーム間隔・処理ごとの時間・長いタスク・ヒープ量を記録する。
 * 「記録を保存」で、止まった瞬間(フレーム間隔が 250ms を超えた所)の前後を含む JSON を書き出す。
 */
import type { App } from '../app';
import { PerfStats, FREEZE_MS, type FreezeRecord } from './perfStats';

interface Running { stats: PerfStats; stop: () => void }
let running: Running | null = null;

/** 出ていれば閉じ、出ていなければ出す */
export function togglePerfOverlay(app: App): void {
  if (running) { running.stop(); running = null; return; }
  running = startPerfOverlay(app);
}

const VERDICT: Record<FreezeRecord['verdict'], string> = {
  page: 'このページの処理',
  outside: 'ページの外(CPU・GPU の取り合いなど)',
  mixed: 'ページの処理とページの外の両方',
};

const COLORS = { physics: '#4ade80', upload: '#facc15', render: '#60a5fa', other: '#9ca3af', freeze: '#f87171' };

function startPerfOverlay(app: App): Running {
  const stats = new PerfStats();
  const origin = performance.timeOrigin;
  const clock = (t: number) => new Date(origin + t).toLocaleTimeString('ja-JP', { hour12: false }) + '.' + String(Math.floor((origin + t) % 1000)).padStart(3, '0');

  /* ---------- 記録 ---------- */
  const observers: PerformanceObserver[] = [];
  const observe = (type: string, fn: (e: PerformanceEntry) => void) => {
    try {
      const o = new PerformanceObserver(l => l.getEntries().forEach(fn));
      o.observe({ type, buffered: false } as PerformanceObserverInit);
      observers.push(o);
    } catch { /* このブラウザでは使えない */ }
  };
  observe('longtask', e => stats.event({ t: e.startTime, d: e.duration, kind: 'longtask' }));
  // 長いアニメーションフレーム(Chrome 123 以降)。どのスクリプトが時間を使ったかが分かる
  observe('long-animation-frame', e => {
    const scripts = ((e as unknown as { scripts?: { duration: number; invoker?: string; sourceURL?: string; sourceFunctionName?: string }[] }).scripts ?? [])
      .slice().sort((a, b) => b.duration - a.duration).slice(0, 3)
      .map(s => `${Math.round(s.duration)}ms ${s.invoker ?? ''} ${(s.sourceURL ?? '').replace(location.origin, '')}${s.sourceFunctionName ? ' ' + s.sourceFunctionName : ''}`.trim());
    stats.event({ t: e.startTime, d: e.duration, kind: 'loaf', detail: scripts.join(' / ') || undefined });
  });
  const onVis = () => stats.event({ t: performance.now(), d: 0, kind: 'visibility', detail: document.visibilityState });
  document.addEventListener('visibilitychange', onVis);
  // 開発サーバーでソースが書き換わったとき(HMR)。ページの再読み込みは、未保存なら「このサイトを離れますか?」で止まる
  const onHmr = (kind: string) => (p: { updates?: { path: string }[]; path?: string }) =>
    stats.event({ t: performance.now(), d: 0, kind, detail: p?.updates?.map(u => u.path).join(', ') ?? p?.path });
  const hmrUpdate = onHmr('hmr-update'), hmrReload = onHmr('hmr-reload');
  import.meta.hot?.on('vite:beforeUpdate', hmrUpdate);
  import.meta.hot?.on('vite:beforeFullReload', hmrReload);
  const heapTimer = window.setInterval(() => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    if (m) stats.sampleHeap(performance.now(), m.usedJSHeapSize);
  }, 1000);
  stats.onFreeze = f => console.warn(`PopStage: ${Math.round(f.gap)}ms 止まりました(${clock(f.t)})。`, f);
  app.perf = stats;

  /* ---------- 表示 ---------- */
  const box = document.createElement('div');
  box.id = 'perfOverlay';
  box.style.cssText = 'position:fixed;left:8px;bottom:36px;z-index:60;width:340px;max-height:70vh;overflow:auto;padding:8px;border-radius:8px;background:rgba(17,24,39,.88);color:#e5e7eb;font:11px/1.45 ui-monospace,Consolas,monospace;box-shadow:0 2px 10px rgba(0,0,0,.4)';
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <b>パフォーマンス</b>
      <span>
        <button type="button" data-act="save" style="background:#374151;border-radius:4px;padding:0 6px">記録を保存</button>
        <button type="button" data-act="clear" style="background:#374151;border-radius:4px;padding:0 6px">消去</button>
        <button type="button" data-act="close" aria-label="閉じる" style="background:#374151;border-radius:4px;padding:0 6px">✕</button>
      </span>
    </div>
    <canvas width="324" height="80" style="width:324px;height:80px;background:#111827;display:block"></canvas>
    <div style="display:flex;gap:8px;margin:2px 0 4px;opacity:.85">
      <span style="color:${COLORS.physics}">■物理</span><span style="color:${COLORS.upload}">■ウェイト転送</span><span style="color:${COLORS.render}">■描画</span><span style="color:${COLORS.other}">■そのほか</span>
    </div>
    <pre data-k="text" style="margin:0;white-space:pre-wrap"></pre>
    <div style="margin-top:4px"><b>止まった記録</b>(${FREEZE_MS}ms 以上)</div>
    <pre data-k="freezes" style="margin:0;white-space:pre-wrap"></pre>`;
  document.body.append(box);
  const canvas = box.querySelector('canvas')!, g = canvas.getContext('2d')!;
  const text = box.querySelector<HTMLElement>('[data-k=text]')!, freezes = box.querySelector<HTMLElement>('[data-k=freezes]')!;

  box.addEventListener('click', e => {
    const act = (e.target as HTMLElement).dataset?.act;
    if (act === 'close') togglePerfOverlay(app);
    else if (act === 'clear') { stats.events.length = 0; stats.freezes.length = 0; }
    else if (act === 'save') download();
  });

  const fmt = (v: number) => v.toFixed(v < 10 ? 2 : 0);
  function draw(): void {
    const rows = stats.frames(162), W = canvas.width, H = canvas.height, bw = 2, scale = H / 66; // 上端が 66ms
    g.clearRect(0, 0, W, H);
    rows.forEach((r, i) => {
      const x = i * bw;
      if (r.interval > FREEZE_MS) { g.fillStyle = COLORS.freeze; g.fillRect(x, 0, bw, H); return; }
      let y = H;
      const bar = (v: number, c: string) => { const h = Math.max(0, v * scale); g.fillStyle = c; g.fillRect(x, y - h, bw, h); y -= h; };
      bar(r.physics, COLORS.physics); bar(r.upload, COLORS.upload); bar(r.render, COLORS.render);
      bar(Math.max(0, r.interval - r.physics - r.upload - r.render), COLORS.other);
    });
    g.strokeStyle = 'rgba(255,255,255,.35)';
    for (const ms of [16.7, 33.3]) { const y = H - ms * scale; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }

    const s = stats.summary(1000), now = performance.now();
    const recent = stats.events.filter(e => e.t > now - 10_000);
    const lt = recent.filter(e => e.kind === 'longtask');
    const last = (kind: string) => { for (let i = stats.events.length - 1; i >= 0; i--) if (stats.events[i].kind === kind) return stats.events[i]; return undefined; };
    const as = last('autosave'), aw = last('autosave-write'), heap = stats.heap[stats.heap.length - 1];
    text.textContent = [
      `${s.fps.toFixed(0)} fps  間隔 平均 ${fmt(s.interval.avg)} / 95% ${fmt(s.interval.p95)} / 最大 ${fmt(s.interval.max)} ms`,
      `内訳(平均/最大 ms) 物理 ${fmt(s.sections.physics.avg)}/${fmt(s.sections.physics.max)}  転送 ${fmt(s.sections.upload.avg)}/${fmt(s.sections.upload.max)}  描画 ${fmt(s.sections.render.avg)}/${fmt(s.sections.render.max)}`,
      `長いタスク(10秒) ${lt.length} 件 最大 ${lt.length ? Math.round(Math.max(...lt.map(e => e.d))) : 0} ms`,
      `自動保存 ${as ? `${fmt(as.d)} ms(${clock(as.t)})` : '-'}  書き込み ${aw ? `${Math.round(aw.d)} ms` : '-'}`,
      `ヒープ ${heap ? `${heap.mb} MB` : '-'}  描画ループ ${app.loops} 本${app.loops > 1 ? '(重なっています)' : ''}  CPU ${navigator.hardwareConcurrency ?? '?'} スレッド`,
    ].join('\n');
    freezes.textContent = stats.freezes.length ? stats.freezes.slice(-5).reverse().map(f => {
      const top = f.events.filter(e => e.kind !== 'loaf' && e.d > 5).sort((a, b) => b.d - a.d).slice(0, 2).map(e => `${e.kind} ${Math.round(e.d)}ms`).join(', ');
      return `${clock(f.t)} ${Math.round(f.gap)}ms 止まる → ${VERDICT[f.verdict]}(ページの処理 ${f.pageBusy}ms)${top ? `\n  直前: ${top}` : ''}`;
    }).join('\n') : 'まだありません';
  }
  const drawTimer = window.setInterval(() => { stats.refreshVerdicts(); draw(); }, 250);
  draw();

  function download(): void {
    const gl = app.stage.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const doc = app.doc;
    const data = {
      app: 'PopStage', version: __APP_VERSION__, savedAt: new Date().toISOString(), timeOrigin: origin,
      env: {
        userAgent: navigator.userAgent, threads: navigator.hardwareConcurrency, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        devicePixelRatio: window.devicePixelRatio, canvas: [app.stage.canvas.width, app.stage.canvas.height], loops: app.loops,
      },
      document: doc ? { image: [doc.image.width, doc.image.height], imageBytes: doc.image.bytes.byteLength, layers: doc.layers.length, meshDensity: doc.meshDensity, vertices: app.stage.vertexCount, multi: app.view.multi } : null,
      ...stats.toJSON(),
    };
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = `popstage-perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  return {
    stats,
    stop() {
      observers.forEach(o => o.disconnect());
      document.removeEventListener('visibilitychange', onVis);
      import.meta.hot?.off?.('vite:beforeUpdate', hmrUpdate);
      import.meta.hot?.off?.('vite:beforeFullReload', hmrReload);
      clearInterval(heapTimer); clearInterval(drawTimer);
      if (app.perf === stats) app.perf = null;
      box.remove();
    },
  };
}
