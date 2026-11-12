/**
 * ツールオプションの欄(上のバー)。選択中のツールの設定だけを出す。
 *   ブラシ・消しゴム・ぼかし: ブラシのサイズ・強さ・硬さ・筆圧(data-brush-opt)
 *   膨らみ: 次に範囲を描くときの形・断面・縁のなだらかさ・重ね方(data-inflate-opt)。描いたあとのプレビュー中は、
 *           下のパネルと同じ値を変える。次に描くときの設定はブラウザに覚える(適用したときの設定も覚え、キャンセルした分は覚えない)
 *   そのほか(つかむ・揺らす・視点・移動): 設定は無く、操作のヒントだけ
 * スマホでは、ブラシの設定はシートの「ツール」タブへ移す(ui/mobile.ts)。
 */
import type { App, InflateSettings } from '../app';
import type { InflateBlend, InflateProfile } from '../paint/inflate';
import { prefs } from '../storage/prefs';
import { ui } from './ids';
import { toolDef } from './tools';

const PAINT_TOOLS = new Set(['brush', 'erase', 'smooth']);

export function bindToolOptions(app: App): void {
  const brushOpts = [...document.querySelectorAll<HTMLElement>('[data-brush-opt]')];
  const inflateOpts = [...document.querySelectorAll<HTMLElement>('[data-inflate-opt]')];

  /* ---------- 膨らみの既定値 ---------- */

  const KEY = 'inflateDefaults';
  const save = () => { const s = app.inflateSettings; prefs.set(KEY, { shape: s.shape, profile: s.profile, softness: s.softness, blend: s.blend }); };
  // 覚えている設定を戻す(値は選べるものだけ)
  {
    const v = prefs.get<Partial<InflateSettings>>(KEY) ?? {};
    const pick = <T extends string>(x: unknown, ok: readonly T[]): T | undefined => (ok.includes(x as T) ? (x as T) : undefined);
    const shape = pick(v.shape, ['ellipse', 'rect'] as const), profile = pick(v.profile, ['dome', 'cushion', 'cone'] as const);
    const blend = pick(v.blend, ['max', 'add', 'replace'] as const);
    const softness = typeof v.softness === 'number' && v.softness >= 0 && v.softness <= 1 ? v.softness : undefined;
    app.inflateSettings = { ...app.inflateSettings, ...(shape && { shape }), ...(profile && { profile }), ...(blend && { blend }), ...(softness !== undefined && { softness }) };
  }
  /** プレビューへの反映は1フレームに1回にまとめる(大きな画像でも滑らかに動かせるよう) */
  let pending: Partial<InflateSettings> = {}, scheduled = false;
  const flush = () => { scheduled = false; const p = pending; pending = {}; if (app.previewingInflate) app.updateInflate({ settings: p }); };
  /** プレビュー中ならその設定を、そうでなければ次に描くときの設定を変えて覚える */
  const setInflate = (patch: Partial<InflateSettings>) => {
    if (app.previewingInflate) {
      pending = { ...pending, ...patch };
      if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
      return;
    }
    app.inflateSettings = { ...app.inflateSettings, ...patch };
    save();
  };
  const softText = () => { ui.tInflSoftO.textContent = `${ui.tInflSoft.value}%`; };
  ui.tInflKind.addEventListener('change', () => setInflate({ shape: ui.tInflKind.value as InflateSettings['shape'] }));
  ui.tInflProfile.addEventListener('change', () => setInflate({ profile: ui.tInflProfile.value as InflateProfile }));
  ui.tInflBlend.addEventListener('change', () => setInflate({ blend: ui.tInflBlend.value as InflateBlend }));
  ui.tInflSoft.addEventListener('input', () => { softText(); setInflate({ softness: +ui.tInflSoft.value / 100 }); });

  /** 欄の値を今の設定に合わせる(入力中の欄は書き換えない) */
  function syncInflate(): void {
    const st = app.inflateState?.settings ?? app.inflateSettings;
    const set = (el: HTMLInputElement | HTMLSelectElement, v: string) => { if (document.activeElement !== el && el.value !== v) el.value = v; };
    set(ui.tInflKind, st.shape);
    set(ui.tInflProfile, st.profile);
    set(ui.tInflBlend, st.blend);
    set(ui.tInflSoft, String(Math.round(st.softness * 100)));
    softText();
  }
  app.on('inflate', phase => {
    if (phase === 'end') { pending = {}; save(); } // 適用したら、その設定が次に描くときの設定になる(キャンセルなら前のまま)
    syncInflate();
  });
  syncInflate();

  /* ---------- ツールに合わせて中身を入れ替える ---------- */

  function refresh(): void {
    const paint = PAINT_TOOLS.has(app.tool);
    for (const el of brushOpts) el.hidden = !paint;
    for (const el of inflateOpts) el.hidden = app.tool !== 'inflate';
    ui.toolHint.textContent = toolDef(app.tool).hint;
  }
  app.on('tool', refresh);
  refresh();
}
