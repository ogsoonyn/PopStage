/**
 * 「膨らませる」のパネル。膨らみツールで範囲を描くと開き、数値を変えるとその場でプレビューする。
 * 視点を回して形を確かめられるよう、ほかの操作を止めないダイアログ(show)にする。適用で1手として記録する。
 */
import type { App, InflateArea, InflateSettings } from '../app';
import type { InflateProfile, InflateBlend } from '../paint/inflate';
import { LIMITS } from '../model/project';
import { popToSlider, sliderToPop } from './popSlider';
import { $ } from './dom';

export function bindInflateDialog(app: App): void {
  const dlg = $<HTMLDialogElement>('inflateDialog');
  const kind = $<HTMLSelectElement>('inflKind'), w = $<HTMLInputElement>('inflW'), h = $<HTMLInputElement>('inflH');
  const height = $<HTMLInputElement>('inflHeight'), heightN = $<HTMLInputElement>('inflHeightN');
  const soft = $<HTMLInputElement>('inflSoft'), softN = $<HTMLInputElement>('inflSoftN');
  const blend = $<HTMLSelectElement>('inflBlend');
  const profiles = [...document.querySelectorAll<HTMLInputElement>('input[name=inflProfile]')];
  let queued: { settings?: Partial<InflateSettings>; area?: Partial<InflateArea> } = {}, scheduled = false;

  const clampInt = (v: string, min: number, max: number) => Math.max(min, Math.min(max, Math.round(+v || 0)));
  const flush = () => { const q = queued; queued = {}; app.updateInflate(q); };
  /** 大きな画像でも滑らかに動かせるよう、プレビューは1フレームに1回だけ計算する */
  const update = (patch: typeof queued) => {
    queued = { settings: { ...queued.settings, ...patch.settings }, area: { ...queued.area, ...patch.area } };
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; flush(); });
  };

  kind.addEventListener('change', () => update({ settings: { shape: kind.value as InflateSettings['shape'] } }));
  w.addEventListener('input', () => { if (+w.value >= 2) update({ area: { w: clampInt(w.value, 2, 8192) } }); });
  h.addEventListener('input', () => { if (+h.value >= 2) update({ area: { h: clampInt(h.value, 2, 8192) } }); });
  // 高さのスライダーはポップ量と同じ目盛り(前半ほど細かい)
  height.addEventListener('input', () => { const v = sliderToPop(+height.value); heightN.value = String(v); update({ settings: { height: v } }); });
  heightN.addEventListener('input', () => { const v = clampInt(heightN.value, 0, LIMITS.pop.max); height.value = String(popToSlider(v)); update({ settings: { height: v } }); });
  soft.addEventListener('input', () => { softN.value = soft.value; update({ settings: { softness: clampInt(soft.value, 0, 100) / 100 } }); });
  softN.addEventListener('input', () => { soft.value = String(clampInt(softN.value, 0, 100)); update({ settings: { softness: clampInt(softN.value, 0, 100) / 100 } }); });
  blend.addEventListener('change', () => update({ settings: { blend: blend.value as InflateBlend } }));
  for (const r of profiles) r.addEventListener('change', () => { if (r.checked) update({ settings: { profile: r.value as InflateProfile } }); });
  for (const el of [w, h, heightN, softN]) el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });

  function finish(apply: boolean): void {
    if (!app.previewingInflate) return;
    if (scheduled || queued.settings || queued.area) flush(); // まだ反映していない入力があれば、先に反映してから確定する
    app.endInflate(apply);
  }
  $('inflApply').addEventListener('click', () => finish(true));
  $('inflCancel').addEventListener('click', () => finish(false));
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && dlg.open) { e.preventDefault(); finish(false); } });

  /** 入力中の欄は書き換えない(打っている途中の値が消えないように) */
  const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => { if (document.activeElement !== el) el.value = v; };

  function fill(): void {
    const s = app.inflateState; if (!s) return;
    const layer = app.store.findLayer(s.layerId)?.layer, st = s.settings;
    $('inflTarget').textContent = `レイヤー「${layer?.name ?? ''}」に重ねます。ドラッグし直すと範囲を描き直せます。`;
    set(kind, st.shape);
    set(w, String(Math.round(s.area.w))); set(h, String(Math.round(s.area.h)));
    set(height, String(popToSlider(st.height))); set(heightN, String(st.height));
    set(soft, String(Math.round(st.softness * 100))); set(softN, String(Math.round(st.softness * 100)));
    set(blend, st.blend);
    for (const r of profiles) r.checked = r.value === st.profile;
    // 高さ = ウェイト × ポップ量。足りないときはポップ量を上げることを知らせる
    const note = $('inflNote'), raised = s.pop !== s.originalPop;
    note.textContent = raised
      ? `ポップ量を ${s.originalPop}px → ${s.pop}px に上げます。${s.originalPop > 0 ? '今の塗りの高さはそのままです。' : '今の塗りもいっしょに持ち上がります。'}`
      : `頂上は ${st.height}px(ポップ量 ${s.pop}px の ${s.pop > 0 ? Math.round(st.height / s.pop * 100) : 0}%)。右ドラッグで視点を回して確かめられます。`;
    note.classList.toggle('text-warning', raised);
  }

  app.on('inflate', phase => {
    if (phase === 'end') { queued = {}; if (dlg.open) dlg.close(); return; }
    fill();
    if (phase === 'begin' && !dlg.open) dlg.show();
  });
}
