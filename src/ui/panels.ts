/** 右パネル(レイヤー一覧とプロパティ)とツールオプション。 */
import type { App } from '../app';
import { PRESETS, PRESET_ORDER, MOTIONS, LIMITS, applyPreset, type Layer, type PhysicsParams, type PresetName, type MotionPattern, type Project, type Document } from '../model/project';
import { PatchLayer, PatchDocument, PatchProject, Batch } from '../commands/commands';
import { $, toast } from './dom';
import { drawWeightThumb } from './imageio';

type Target = 'layer' | 'doc' | 'project';

export function bindPanels(app: App): { refresh: () => void } {
  const { store, history } = app;

  /* ---------- 汎用: スライダー → パッチ(ドラッグ中はその場で反映、離したら1手として記録) ---------- */

  function patchNow(target: Target, patch: object): void {
    if (target === 'layer') { const l = app.activeLayer; if (l) store.patchLayer(l.id, patch as Partial<Layer>); }
    else if (target === 'doc') { const d = app.doc; if (d) store.patchDocument(d.id, patch as Partial<Document>); }
    else store.patchProject(patch as Partial<Project>);
  }

  function snapshot(target: Target, keys: string[]): Record<string, unknown> {
    const src = (target === 'layer' ? app.activeLayer : target === 'doc' ? app.doc : app.project) as unknown as Record<string, unknown> | undefined;
    const out: Record<string, unknown> = {};
    if (src) for (const k of keys) out[k] = structuredClone(src[k]);
    return out;
  }

  function record(target: Target, label: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (target === 'layer') { const l = app.activeLayer; if (l) history.push(new PatchLayer(label, l.id, before, after)); }
    else if (target === 'doc') { const d = app.doc; if (d) history.push(new PatchDocument(label, d.id, before, after)); }
    else history.push(new PatchProject(label, before, after));
  }

  function bindRange(id: string, o: { target: Target; keys: string[]; label: string; toPatch: (v: number) => object; fmt?: (v: number) => string }): void {
    const el = $<HTMLInputElement>(id), out = document.getElementById(id + 'O');
    let before: Record<string, unknown> | null = null;
    el.addEventListener('input', () => {
      before ??= snapshot(o.target, o.keys);
      patchNow(o.target, o.toPatch(+el.value));
      if (out && o.fmt) out.textContent = o.fmt(+el.value);
    });
    el.addEventListener('change', () => {
      if (!before) return;
      record(o.target, o.label, before, snapshot(o.target, o.keys));
      before = null;
    });
  }

  function exec(target: Target, label: string, patch: object): void {
    const keys = Object.keys(patch), before = snapshot(target, keys);
    patchNow(target, patch);
    record(target, label, before, snapshot(target, keys));
  }

  const physics = () => app.activeLayer?.physics;
  const physPatch = (k: keyof PhysicsParams, v: number) => ({ physics: { ...physics()!, [k]: v / 100, preset: 'custom' as PresetName } });
  const pct = (v: number) => `${Math.round(v)}`;

  /* ---------- レイヤーのプロパティ ---------- */

  bindRange('pPop', { target: 'layer', keys: ['pop'], label: 'ポップ量', toPatch: v => ({ pop: v }) });
  $<HTMLInputElement>('pPop').addEventListener('input', e => { $<HTMLInputElement>('pPopN').value = (e.target as HTMLInputElement).value; });
  $<HTMLInputElement>('pPopN').addEventListener('change', e => {
    const v = Math.max(LIMITS.pop.min, Math.min(LIMITS.pop.max, Math.round(+(e.target as HTMLInputElement).value || 0)));
    exec('layer', 'ポップ量', { pop: v });
  });
  $<HTMLInputElement>('pSwing').addEventListener('change', e => exec('layer', '揺れの切替', { physics: { ...physics()!, enabled: (e.target as HTMLInputElement).checked } }));
  // プリセットと揺らし方の選択肢はモデルの定義から作る
  const presetSel = $<HTMLSelectElement>('pPreset'), motionSel = $<HTMLSelectElement>('pMotion');
  presetSel.replaceChildren(...PRESET_ORDER.map(k => new Option(PRESETS[k].label, k)), new Option('カスタム', 'custom'));
  motionSel.replaceChildren(...(Object.keys(MOTIONS) as MotionPattern[]).map(k => new Option(MOTIONS[k].label, k)));

  // プリセットは材質と揺らし方を変え、自動揺らしの周期もおすすめの値にする。まとめて1手
  presetSel.addEventListener('change', () => {
    const name = presetSel.value as PresetName, l = app.activeLayer;
    if (!l) return;
    if (name === 'custom') { exec('layer', 'プリセット', { physics: { ...l.physics, preset: 'custom' } }); return; }
    const pr = PRESETS[name], label = `プリセット「${pr.label}」`;
    history.execute(new Batch(label, [
      PatchLayer.from(store, l.id, { physics: applyPreset(l.physics, name) }, label),
      PatchProject.from(store, { autoSwing: { ...app.project.autoSwing, period: pr.period } }, label),
    ]));
    if (!app.project.autoSwing.enabled) toast('「自動で揺らす」がオフなので、自動では動きません。「つかむ」で揺らすか、自動揺らしをオンにしてください。', 'info', 5000);
    else if (!l.physics.enabled) toast('このレイヤーは「揺れ」がオフです。', 'info');
  });
  motionSel.addEventListener('change', () => {
    const p = physics(); if (!p) return;
    exec('layer', '揺らし方', { physics: { ...p, motion: motionSel.value as MotionPattern, preset: 'custom' } });
  });

  // 詳細設定の開閉は、見る人ごとの好みとしてブラウザに覚えておく(使えなければ毎回閉じた状態)
  const details = $<HTMLDetailsElement>('physDetails');
  try { details.open = localStorage.getItem('popstage.physDetails') === 'open'; } catch { /* 無視 */ }
  details.addEventListener('toggle', () => {
    try { localStorage.setItem('popstage.physDetails', details.open ? 'open' : 'closed'); } catch { /* 無視 */ }
  });
  bindRange('pHard', { target: 'layer', keys: ['physics'], label: '硬さ', toPatch: v => physPatch('hardness', v), fmt: pct });
  bindRange('pMass', { target: 'layer', keys: ['physics'], label: '質量', toPatch: v => physPatch('mass', v), fmt: pct });
  bindRange('pDamp', { target: 'layer', keys: ['physics'], label: 'おさまり', toPatch: v => physPatch('damping', v), fmt: pct });
  // 「重さ」はプリセットに含まれないので、変えてもカスタムにはしない
  bindRange('pWeight', { target: 'layer', keys: ['physics'], label: '重さ', toPatch: v => ({ physics: { ...physics()!, weight: v / 100 } }), fmt: pct });

  /* ---------- 画像・カメラ・自動揺らし ---------- */

  bindRange('pDensity', { target: 'doc', keys: ['meshDensity'], label: 'メッシュ密度', toPatch: v => ({ meshDensity: v }), fmt: v => `${v}` });
  bindRange('pOpacity', { target: 'doc', keys: ['opacity'], label: '不透明度', toPatch: v => ({ opacity: v / 100 }), fmt: v => `${v}%` });
  bindRange('pFov', { target: 'project', keys: ['camera'], label: '画角', toPatch: v => ({ camera: { ...app.project.camera, fov: v } }), fmt: v => `${v}°` });
  bindRange('pPeriod', { target: 'project', keys: ['autoSwing'], label: '自動揺らしの周期', toPatch: v => ({ autoSwing: { ...app.project.autoSwing, period: v / 10 } }), fmt: v => `${(v / 10).toFixed(1)}秒` });
  bindRange('pAutoStr', { target: 'project', keys: ['autoSwing'], label: '自動揺らしの強さ', toPatch: v => ({ autoSwing: { ...app.project.autoSwing, strength: v / 100 } }), fmt: pct });
  $<HTMLInputElement>('pAuto').addEventListener('change', e => exec('project', '自動揺らしの切替', { autoSwing: { ...app.project.autoSwing, enabled: (e.target as HTMLInputElement).checked } }));
  $<HTMLInputElement>('pBgTransparent').addEventListener('change', e => {
    exec('project', '背景', { background: (e.target as HTMLInputElement).checked ? null : $<HTMLInputElement>('pBgColor').value });
  });
  {
    const el = $<HTMLInputElement>('pBgColor');
    let before: Record<string, unknown> | null = null;
    el.addEventListener('input', () => { before ??= snapshot('project', ['background']); patchNow('project', { background: el.value }); });
    el.addEventListener('change', () => { if (before) record('project', '背景色', before, snapshot('project', ['background'])); before = null; });
  }

  /* ---------- 表示 ---------- */

  $<HTMLInputElement>('vOverlay').addEventListener('change', e => app.setViewOption('overlay', (e.target as HTMLInputElement).checked));
  $<HTMLInputElement>('vGrid').addEventListener('change', e => app.setViewOption('grid', (e.target as HTMLInputElement).checked));
  $<HTMLInputElement>('vShade').addEventListener('change', e => app.setViewOption('shade', (e.target as HTMLInputElement).checked));
  $<HTMLInputElement>('vPause').addEventListener('change', e => app.setPaused((e.target as HTMLInputElement).checked));

  /* ---------- ツールオプション ---------- */

  const brushRange = (id: string, set: (v: number) => void, fmt: (v: number) => string) => {
    const el = $<HTMLInputElement>(id), out = $(id + 'O');
    const f = () => { set(+el.value); out.textContent = fmt(+el.value); };
    el.addEventListener('input', f); f();
  };
  brushRange('brushSize', v => { app.brush.size = v; }, v => `${v}px`);
  brushRange('brushStrength', v => { app.brush.strength = v / 100; }, v => `${v}%`);
  brushRange('brushHardness', v => { app.brush.hardness = v / 100; }, v => `${v}%`);
  $<HTMLSelectElement>('brushPressure').addEventListener('change', e => { app.brush.pressure = (e.target as HTMLSelectElement).value as typeof app.brush.pressure; });

  /* ---------- レイヤー一覧 ---------- */

  const list = $('layerList');
  const thumbs = new Map<string, HTMLCanvasElement>();

  function renderList(): void {
    const doc = app.doc;
    list.replaceChildren();
    thumbs.clear();
    if (!doc) return;
    $('layerCount').textContent = `${doc.layers.length} / ${LIMITS.maxLayers}`;
    // 上ほど手前(配列の後ろ)に並べる
    for (const layer of [...doc.layers].reverse()) {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 rounded px-1.5 py-1 cursor-pointer hover:bg-base-200';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(layer.id === app.activeLayerId));
      li.dataset.id = layer.id;

      const eye = document.createElement('input');
      eye.type = 'checkbox'; eye.className = 'checkbox checkbox-xs'; eye.checked = layer.visible; eye.title = '表示';
      eye.addEventListener('click', e => e.stopPropagation());
      eye.addEventListener('change', () => history.execute(PatchLayer.from(store, layer.id, { visible: eye.checked }, eye.checked ? 'レイヤーを表示' : 'レイヤーを非表示')));

      const th = document.createElement('canvas');
      th.width = 44; th.height = 33; th.className = 'shrink-0';
      drawWeightThumb(th, layer.weights.data, layer.weights.width, layer.weights.height);
      thumbs.set(layer.id, th);

      const name = document.createElement('span');
      name.className = 'truncate flex-1'; name.textContent = layer.name; name.title = 'ダブルクリックで名前を変更';
      name.addEventListener('dblclick', () => rename(layer, name));

      const info = document.createElement('span');
      info.className = 'text-xs opacity-60 tabular-nums';
      info.textContent = `${layer.pop > 0 ? '+' : ''}${layer.pop}`;

      li.append(eye, th, name, info);
      li.addEventListener('click', () => { if (layer.id !== app.activeLayerId) app.setActiveLayer(layer.id); });
      list.append(li);
    }
  }

  function updateSelection(): void {
    list.querySelectorAll('li').forEach(li => li.setAttribute('aria-selected', String(li.dataset.id === app.activeLayerId)));
  }

  function rename(layer: Layer, span: HTMLElement): void {
    const input = document.createElement('input');
    input.className = 'input input-xs flex-1 min-w-0'; input.value = layer.name;
    span.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (ok && v && v !== layer.name) history.execute(PatchLayer.from(store, layer.id, { name: v }, '名前の変更'));
      else renderList();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); });
    input.addEventListener('blur', () => finish(true));
  }

  const pendingThumbs = new Set<string>();
  let thumbTimer = 0;
  store.on('weights', ({ layerId }) => {
    pendingThumbs.add(layerId);
    if (thumbTimer) return;
    thumbTimer = window.setTimeout(() => {
      thumbTimer = 0;
      for (const id of pendingThumbs) {
        const c = thumbs.get(id), l = store.findLayer(id)?.layer;
        if (c && l) drawWeightThumb(c, l.weights.data, l.weights.width, l.weights.height);
      }
      pendingThumbs.clear();
    }, 250);
  });

  /* ---------- 状態 → 画面 ---------- */

  const setRange = (id: string, v: number, text?: string) => {
    const el = $<HTMLInputElement>(id);
    if (document.activeElement !== el || !el.matches(':active')) el.value = String(v);
    const out = document.getElementById(id + 'O');
    if (out && text !== undefined) out.textContent = text;
  };

  function refreshProps(): void {
    const l = app.activeLayer, d = app.doc, p = app.project;
    const disabled = !l;
    document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#props input, #props select').forEach(el => { if (!el.id.startsWith('v')) el.disabled = disabled; });
    $('activeLayerName').textContent = l?.name ?? '-';
    if (l) {
      setRange('pPop', l.pop);
      if (document.activeElement !== $('pPopN')) $<HTMLInputElement>('pPopN').value = String(l.pop);
      $<HTMLInputElement>('pSwing').checked = l.physics.enabled;
      presetSel.value = l.physics.preset;
      motionSel.value = l.physics.motion;
      $('pPresetDesc').textContent = l.physics.preset === 'custom' ? `${MOTIONS[l.physics.motion].desc}(詳細設定で調整中)` : PRESETS[l.physics.preset].desc;
      $('physSummary').textContent = `— ${MOTIONS[l.physics.motion].label}`;
      setRange('pHard', Math.round(l.physics.hardness * 100), pct(l.physics.hardness * 100));
      setRange('pMass', Math.round(l.physics.mass * 100), pct(l.physics.mass * 100));
      setRange('pWeight', Math.round(l.physics.weight * 100), pct(l.physics.weight * 100));
      setRange('pDamp', Math.round(l.physics.damping * 100), pct(l.physics.damping * 100));
    }
    if (d) {
      setRange('pDensity', d.meshDensity, `${d.meshDensity}`);
      setRange('pOpacity', Math.round(d.opacity * 100), `${Math.round(d.opacity * 100)}%`);
    }
    setRange('pFov', p.camera.fov, `${p.camera.fov}°`);
    $<HTMLInputElement>('pBgTransparent').checked = p.background === null;
    if (p.background) $<HTMLInputElement>('pBgColor').value = p.background;
    $<HTMLInputElement>('pAuto').checked = p.autoSwing.enabled;
    setRange('pPeriod', Math.round(p.autoSwing.period * 10), `${p.autoSwing.period.toFixed(1)}秒`);
    setRange('pAutoStr', Math.round(p.autoSwing.strength * 100), pct(p.autoSwing.strength * 100));
    $<HTMLInputElement>('vOverlay').checked = app.view.overlay;
    $<HTMLInputElement>('vGrid').checked = app.view.grid;
    $<HTMLInputElement>('vShade').checked = app.view.shade;
    $<HTMLInputElement>('vPause').checked = app.paused;
  }

  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; refreshProps(); });
  };

  store.on('replace', () => { renderList(); refresh(); });
  store.on('layers', () => { renderList(); refresh(); });
  store.on('layer', ({ keys }) => { if (keys.some(k => k === 'name' || k === 'visible' || k === 'pop')) renderList(); refresh(); });
  store.on('document', refresh);
  store.on('project', refresh);
  app.on('active', () => { updateSelection(); refresh(); });
  app.on('view', refresh);

  renderList(); refresh();
  return { refresh };
}
