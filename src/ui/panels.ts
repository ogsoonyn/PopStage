/** 右パネル(レイヤー一覧とプロパティ)とツールオプション。 */
import type { App } from '../app';
import { PRESETS, PRESET_ORDER, BLENDS, BLEND_ORDER, MOTIONS, MOTION_PARAMS, LIMITS, motionParam, type MotionParamDef, type Layer, type PhysicsParams, type PresetName, type MotionPattern, type BlendMode, type Project, type Document } from '../model/project';
import { PatchLayer, PatchDocument, PatchProject, SetFov } from '../commands/commands';
import { prefs } from '../storage/prefs';
import { ui } from './ids';
import { drawWeightThumb } from './imageio';
import { popToSlider, sliderToPop } from './popSlider';
import { createHelp } from './help';

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

  /**
   * 動かしている間はその場で反映し(input)、離したら1手として記録する(change)。
   * begin は動かし始めに1回だけ呼び、その戻り値(変える前の値)を commit に渡す。
   */
  function bindLive<B>(el: HTMLInputElement, o: { begin: () => B; input: (value: string) => void; commit: (before: B) => void }): void {
    let before: { v: B } | null = null;
    el.addEventListener('input', () => { before ??= { v: o.begin() }; o.input(el.value); });
    el.addEventListener('change', () => { if (before) o.commit(before.v); before = null; });
  }

  /** スライダー → 対象(レイヤー・ドキュメント・プロジェクト)への変更。out があれば値を書く */
  function bindRange(el: HTMLInputElement, out: HTMLElement | null, o: { target: Target; keys: string[]; label: string; toPatch: (v: number) => object; fmt?: (v: number) => string }): void {
    bindLive(el, {
      begin: () => snapshot(o.target, o.keys),
      input: v => { patchNow(o.target, o.toPatch(+v)); if (out && o.fmt) out.textContent = o.fmt(+v); },
      commit: before => record(o.target, o.label, before, snapshot(o.target, o.keys)),
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

  // ポップ量のスライダーは目盛りと px が比例しない(後半ほど粗い。popSlider.ts)
  bindRange(ui.pPop, null, { target: 'layer', keys: ['pop'], label: 'ポップ量', toPatch: v => ({ pop: sliderToPop(v) }) });
  ui.pPop.addEventListener('input', () => { ui.pPopN.value = String(sliderToPop(+ui.pPop.value)); });
  ui.pPopN.addEventListener('change', () => {
    const v = Math.max(LIMITS.pop.min, Math.min(LIMITS.pop.max, Math.round(+ui.pPopN.value || 0)));
    exec('layer', 'ポップ量', { pop: v });
  });
  // 重ね方
  const blendSel = ui.pBlend;
  for (const b of BLEND_ORDER) blendSel.add(new Option(BLENDS[b].label, b));
  blendSel.addEventListener('change', () => exec('layer', '重ね方', { blend: blendSel.value as BlendMode }));
  // 「揺れ」「自動で揺らす」は右のパネルと上のツールバーの両方に置く。どちらも App を通して変え、表示は refreshProps で合わせる
  for (const el of [ui.pSwing, ui.tSwing]) el.addEventListener('change', () => app.setLayerSwing(el.checked));
  for (const el of [ui.pAuto, ui.tAuto]) el.addEventListener('change', () => app.setAutoSwing(el.checked));
  // プリセットと揺らし方の選択肢はモデルの定義から作る
  const presetSel = ui.pPreset, motionSel = ui.pMotion;
  presetSel.replaceChildren(...PRESET_ORDER.map(k => new Option(PRESETS[k].label, k)), new Option('カスタム', 'custom'));
  motionSel.replaceChildren(...(Object.keys(MOTIONS) as MotionPattern[]).map(k => new Option(MOTIONS[k].label, k)));

  // プリセットは材質と揺らし方を変え、自動揺らしの周期もおすすめの値にする(スマホのボタンと共通。app.setPreset)
  presetSel.addEventListener('change', () => app.setPreset(presetSel.value as PresetName));
  motionSel.addEventListener('change', () => {
    const p = physics(); if (!p) return;
    exec('layer', '揺らし方', { physics: { ...p, motion: motionSel.value as MotionPattern, preset: 'custom' } });
  });

  // 詳細設定の開閉は、見る人ごとの好みとしてブラウザに覚えておく(使えなければ毎回閉じた状態)
  const details = ui.physDetails;
  details.open = prefs.get<boolean>('physDetails') ?? legacyDetailsOpen();
  details.addEventListener('toggle', () => prefs.set('physDetails', details.open));

  /* ---------- 揺らし方の固有設定(選んだ揺らし方に合わせて作り直す) ---------- */

  const paramBox = ui.motionParams;
  let paramKey = '';
  const fmtParam = (d: MotionParamDef, v: number) => (d.unit === '%' ? `${Math.round(v * 100)}%` : d.unit === 'Hz' ? `${v.toFixed(1)}Hz` : '');
  const paramPatch = (key: string, v: number) => {
    const p = physics()!;
    return { physics: { ...p, preset: 'custom' as PresetName, motionParams: { ...p.motionParams, [key]: v } } };
  };

  function buildMotionParams(l: Layer): void {
    const motion = l.physics.motion, defs = MOTION_PARAMS[motion];
    paramBox.replaceChildren();
    paramBox.classList.toggle('hidden', defs.length === 0);
    for (const d of defs) {
      const key = `${motion}.${d.key}`, row = document.createElement('div'), label = `${MOTIONS[motion].label}: ${d.label}`;
      row.className = 'prop';
      const labelEl = document.createElement('label');
      labelEl.textContent = d.label; labelEl.htmlFor = `mp-${d.key}`;
      // 補足があれば「?」で開けるようにする(説明は行の下に出す)
      const help = d.hint ? createHelp(`mp-${d.key}-help`, d.label, d.hint) : null;
      const name = help ? Object.assign(document.createElement('span'), { className: 'prop-name' }) : labelEl;
      if (help) name.append(labelEl, help.button);
      if (d.options) {
        const sel = document.createElement('select');
        sel.id = `mp-${d.key}`; sel.className = 'select select-xs col-span-2 w-full'; sel.dataset.param = key;
        sel.append(...d.options.map(([v, text]) => new Option(text, String(v))));
        sel.addEventListener('change', () => exec('layer', label, paramPatch(key, +sel.value)));
        if (help) sel.setAttribute('aria-describedby', help.text.id);
        row.append(name, sel);
      } else {
        const input = document.createElement('input'), out = document.createElement('output');
        input.id = `mp-${d.key}`; input.type = 'range'; input.className = 'range range-xs'; input.dataset.param = key;
        input.min = String(d.min); input.max = String(d.max); input.step = String(d.step);
        bindRange(input, out, { target: 'layer', keys: ['physics'], label, toPatch: v => paramPatch(key, v), fmt: v => fmtParam(d, v) });
        if (help) input.setAttribute('aria-describedby', help.text.id);
        row.append(name, input, out);
      }
      paramBox.append(row);
      if (help) paramBox.append(help.text);
    }
  }

  function refreshMotionParams(l: Layer): void {
    const k = `${l.id}/${l.physics.motion}`;
    if (k !== paramKey) { paramKey = k; buildMotionParams(l); }
    for (const d of MOTION_PARAMS[l.physics.motion]) {
      const el = paramBox.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-param="${l.physics.motion}.${d.key}"]`);
      if (!el) continue;
      const v = motionParam(l.physics.motionParams, l.physics.motion, d.key);
      if (!(el instanceof HTMLInputElement && el.matches(':active'))) el.value = String(v);
      if (el instanceof HTMLInputElement) (el.nextElementSibling as HTMLElement).textContent = fmtParam(d, v);
    }
  }

  bindRange(ui.pHard, ui.pHardO, { target: 'layer', keys: ['physics'], label: '硬さ', toPatch: v => physPatch('hardness', v), fmt: pct });
  bindRange(ui.pMass, ui.pMassO, { target: 'layer', keys: ['physics'], label: '質量', toPatch: v => physPatch('mass', v), fmt: pct });
  bindRange(ui.pDamp, ui.pDampO, { target: 'layer', keys: ['physics'], label: 'おさまり', toPatch: v => physPatch('damping', v), fmt: pct });
  // 「重さ」はプリセットに含まれないので、変えてもカスタムにはしない
  bindRange(ui.pWeight, ui.pWeightO, { target: 'layer', keys: ['physics'], label: '重さ', toPatch: v => ({ physics: { ...physics()!, weight: v / 100 } }), fmt: pct });

  /* ---------- 画像・カメラ・自動揺らし ---------- */

  bindRange(ui.pDensity, ui.pDensityO, { target: 'doc', keys: ['meshDensity'], label: 'メッシュ密度', toPatch: v => ({ meshDensity: v }), fmt: v => `${v}` });
  bindRange(ui.pOpacity, ui.pOpacityO, { target: 'doc', keys: ['opacity'], label: '不透明度', toPatch: v => ({ opacity: v / 100 }), fmt: v => `${v}%` });
  // 画角は視点と同じ camera に入っているが、アンドゥでは画角だけを戻す
  bindLive(ui.pFov, {
    begin: () => app.project.camera.fov,
    input: v => { store.patchProject({ camera: { ...app.project.camera, fov: +v } }); ui.pFovO.textContent = `${v}°`; },
    commit: before => { if (before !== +ui.pFov.value) history.push(new SetFov('画角', before, +ui.pFov.value)); },
  });
  bindRange(ui.pPeriod, ui.pPeriodO, { target: 'project', keys: ['autoSwing'], label: '自動揺らしの周期', toPatch: v => ({ autoSwing: { ...app.project.autoSwing, period: v / 10 } }), fmt: v => `${(v / 10).toFixed(1)}秒` });
  bindRange(ui.pAutoStr, ui.pAutoStrO, { target: 'project', keys: ['autoSwing'], label: '自動揺らしの強さ', toPatch: v => ({ autoSwing: { ...app.project.autoSwing, strength: v / 100 } }), fmt: pct });
  ui.pBgTransparent.addEventListener('change', () => exec('project', '背景', { background: ui.pBgTransparent.checked ? null : ui.pBgColor.value }));
  bindLive(ui.pBgColor, {
    begin: () => snapshot('project', ['background']),
    input: v => patchNow('project', { background: v }),
    commit: before => record('project', '背景色', before, snapshot('project', ['background'])),
  });

  /* ---------- 表示 ---------- */

  const viewToggles = [[ui.vOverlay, 'overlay'], [ui.vFade, 'fade'], [ui.vMulti, 'multi'], [ui.vFlat, 'flat'], [ui.vGrid, 'grid']] as const;
  for (const [el, key] of viewToggles) el.addEventListener('change', () => app.setViewOption(key, el.checked));
  ui.vPause.addEventListener('change', () => app.setPaused(ui.vPause.checked));

  /* ---------- ツールオプション ---------- */

  const brushRange = (el: HTMLInputElement, out: HTMLElement, set: (v: number) => void, fmt: (v: number) => string) => {
    const f = () => { set(+el.value); out.textContent = fmt(+el.value); };
    el.addEventListener('input', f); f();
  };
  brushRange(ui.brushSize, ui.brushSizeO, v => { app.brush.size = v; }, v => `${v}px`);
  brushRange(ui.brushStrength, ui.brushStrengthO, v => { app.brush.strength = v / 100; }, v => `${v}%`);
  brushRange(ui.brushHardness, ui.brushHardnessO, v => { app.brush.hardness = v / 100; }, v => `${v}%`);
  ui.brushPressure.addEventListener('change', () => { app.brush.pressure = ui.brushPressure.value as typeof app.brush.pressure; });

  /* ---------- レイヤー一覧 ---------- */

  const list = ui.layerList;
  const thumbs = new Map<string, HTMLCanvasElement>();

  function renderList(): void {
    const doc = app.doc;
    // 作り直してもキーボードのフォーカスを失わないよう、一覧にフォーカスがあったかを覚えておく
    const hadFocus = list.contains(document.activeElement) && document.activeElement?.tagName === 'LI';
    list.replaceChildren();
    thumbs.clear();
    if (!doc) return;
    ui.layerCount.textContent = `${doc.layers.length} / ${LIMITS.maxLayers}`;
    // 上ほど手前(配列の後ろ)に並べる
    for (const layer of [...doc.layers].reverse()) {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-2 rounded px-1.5 py-1 cursor-pointer hover:bg-base-200';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(layer.id === app.activeLayerId));
      li.setAttribute('aria-label', layer.name);
      // 一覧の中では選択中の項目だけを Tab で止め、矢印キーで移る(roving tabindex)
      li.tabIndex = layer.id === app.activeLayerId ? 0 : -1;
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
      info.textContent = layer.blend === 'max' ? `${BLENDS.max.short} ${layer.pop}` : `${layer.pop > 0 ? '+' : ''}${layer.pop}`;
      info.title = `重ね方: ${BLENDS[layer.blend].label} / ポップ量 ${layer.pop}px`;

      li.append(eye, th, name, info);
      li.addEventListener('click', () => { if (layer.id !== app.activeLayerId) app.setActiveLayer(layer.id); });
      li.addEventListener('keydown', e => {
        if (e.target !== li) return;
        if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); e.stopPropagation(); rename(layer, name); }
      });
      list.append(li);
    }
    if (hadFocus) list.querySelector<HTMLElement>('li[aria-selected=true]')?.focus();
  }

  // 上下の矢印・Home・End で選ぶレイヤーを移す
  list.addEventListener('keydown', e => {
    if ((e.target as HTMLElement).tagName !== 'LI') return;
    const items = [...list.querySelectorAll<HTMLElement>('li')];
    const i = items.indexOf(e.target as HTMLElement);
    const j = e.key === 'ArrowUp' ? i - 1 : e.key === 'ArrowDown' ? i + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -2;
    if (j === -2) return;
    e.preventDefault(); e.stopPropagation();
    const next = items[Math.max(0, Math.min(items.length - 1, j))];
    if (next.dataset.id && next.dataset.id !== app.activeLayerId) app.setActiveLayer(next.dataset.id);
    next.focus();
  });

  function updateSelection(): void {
    list.querySelectorAll<HTMLElement>('li').forEach(li => {
      const on = li.dataset.id === app.activeLayerId;
      li.setAttribute('aria-selected', String(on));
      li.tabIndex = on ? 0 : -1;
    });
  }

  function rename(layer: Layer, span: HTMLElement): void {
    const input = document.createElement('input');
    input.className = 'input input-xs flex-1 min-w-0'; input.value = layer.name;
    span.replaceWith(input); input.focus(); input.select();
    let done = false;
    const finish = (ok: boolean, byKey = false) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (ok && v && v !== layer.name) history.execute(PatchLayer.from(store, layer.id, { name: v }, '名前の変更'));
      else renderList();
      // Enter / Esc で終えたときは、項目にフォーカスを戻す(クリックで外したときは奪わない)
      if (byKey) list.querySelector<HTMLElement>('li[aria-selected=true]')?.focus();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') finish(true, true); if (e.key === 'Escape') finish(false, true); e.stopPropagation(); });
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

  const setRange = (el: HTMLInputElement, out: HTMLElement | null, v: number, text?: string) => {
    if (document.activeElement !== el || !el.matches(':active')) el.value = String(v);
    if (out && text !== undefined) out.textContent = text;
  };

  /**
   * 選択中のレイヤーが無いとき(画像を開く前)に止める部品の入れ物。表示の切り替えは画像が無くても使えるので除く。
   * スマホではシートへ移すので、いま #props の中にあるかどうかではなく、最初に入れ物ごと覚えておく
   */
  const viewSection = ui.vOverlay.closest('section');
  const layerSections = [...ui.props.querySelectorAll('section')].filter(s => s !== viewSection);

  function refreshProps(): void {
    const l = app.activeLayer, d = app.doc, p = app.project;
    const disabled = !l;
    for (const s of layerSections) for (const el of s.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) el.disabled = disabled;
    ui.tSwing.disabled = ui.tAuto.disabled = disabled;
    // 膨らませるのプレビュー中は、新しいレイヤーに作るかどうかがこのレイヤーのポップ量で決まるので、ポップ量は触らせない。
    // レイヤー一覧も、仮に入れたレイヤーの名前や表示を変えて記録しないよう、操作できなくする
    if (app.previewingInflate) ui.pPop.disabled = ui.pPopN.disabled = true;
    list.inert = app.previewingInflate;
    list.classList.toggle('opacity-60', app.previewingInflate);
    ui.activeLayerName.textContent = l?.name ?? '-';
    if (l) {
      setRange(ui.pPop, null, popToSlider(l.pop));
      if (document.activeElement !== ui.pPopN) ui.pPopN.value = String(l.pop);
      blendSel.value = l.blend;
      // 説明は画面に並べず、「?」で開く欄に入れる(選択欄の aria-describedby でも読み上げる)
      ui.pBlendDesc.textContent = BLENDS[l.blend].desc;
      ui.pSwing.checked = ui.tSwing.checked = l.physics.enabled;
      presetSel.value = l.physics.preset;
      motionSel.value = l.physics.motion;
      ui.pPresetDesc.textContent = l.physics.preset === 'custom' ? `${MOTIONS[l.physics.motion].desc}(詳細設定で調整中)` : PRESETS[l.physics.preset].desc;
      refreshMotionParams(l);
      ui.physSummary.textContent = `— ${MOTIONS[l.physics.motion].label}`;
      setRange(ui.pHard, ui.pHardO, Math.round(l.physics.hardness * 100), pct(l.physics.hardness * 100));
      setRange(ui.pMass, ui.pMassO, Math.round(l.physics.mass * 100), pct(l.physics.mass * 100));
      setRange(ui.pWeight, ui.pWeightO, Math.round(l.physics.weight * 100), pct(l.physics.weight * 100));
      setRange(ui.pDamp, ui.pDampO, Math.round(l.physics.damping * 100), pct(l.physics.damping * 100));
    }
    if (d) {
      setRange(ui.pDensity, ui.pDensityO, d.meshDensity, `${d.meshDensity}`);
      setRange(ui.pOpacity, ui.pOpacityO, Math.round(d.opacity * 100), `${Math.round(d.opacity * 100)}%`);
    }
    setRange(ui.pFov, ui.pFovO, p.camera.fov, `${p.camera.fov}°`);
    ui.pBgTransparent.checked = p.background === null;
    if (p.background) ui.pBgColor.value = p.background;
    ui.pAuto.checked = ui.tAuto.checked = p.autoSwing.enabled;
    setRange(ui.pPeriod, ui.pPeriodO, Math.round(p.autoSwing.period * 10), `${p.autoSwing.period.toFixed(1)}秒`);
    setRange(ui.pAutoStr, ui.pAutoStrO, Math.round(p.autoSwing.strength * 100), pct(p.autoSwing.strength * 100));
    for (const [el, key] of viewToggles) el.checked = app.view[key];
    ui.vPause.checked = app.paused;
  }

  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; refreshProps(); });
  };

  store.on('replace', () => { renderList(); refresh(); });
  store.on('layers', () => { renderList(); refresh(); });
  store.on('layer', ({ keys }) => { if (keys.some(k => k === 'name' || k === 'visible' || k === 'pop' || k === 'blend')) renderList(); refresh(); });
  store.on('document', refresh);
  store.on('project', refresh);
  app.on('active', () => { updateSelection(); refresh(); });
  app.on('view', refresh);
  app.on('inflate', refresh); // プレビュー中はポップ量を触らせない

  renderList(); refresh();
  return { refresh };
}

/** 前の版は詳細設定の開閉を別のキーに覚えていた。prefs にまだ無いときだけ読む */
function legacyDetailsOpen(): boolean {
  try { return localStorage.getItem('popstage.physDetails') === 'open'; } catch { return false; }
}
