/** 「全体をぼかす(ガウス)」ダイアログ。半径を動かすとその場でプレビューし、適用で1手として記録する。 */
import type { App } from '../app';
import { ui } from './ids';

export function bindBlurDialog(app: App): { open: () => void } {
  const dlg = ui.blurDialog;
  const range = ui.blurRadius, num = ui.blurRadiusN;
  let lastRadius = 16, queued = false, closing = false;

  const value = () => Math.max(0, Math.min(200, Math.round(+range.value || 0)));
  // 大きな画像でも滑らかに動かせるよう、プレビューは1フレームに1回だけ計算する
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; app.previewBlur(value()); });
  };
  range.addEventListener('input', () => { num.value = String(value()); schedule(); });
  num.addEventListener('input', () => { range.value = String(Math.max(0, Math.min(200, +num.value || 0))); schedule(); });
  num.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } });

  function finish(apply: boolean): void {
    if (closing) return;
    closing = true;
    const r = value();
    if (apply) lastRadius = r;
    app.endBlurPreview(apply && r > 0, r);
    dlg.close();
    closing = false;
  }
  ui.blurApply.addEventListener('click', () => finish(true));
  ui.blurCancel.addEventListener('click', () => finish(false));
  dlg.addEventListener('cancel', e => { e.preventDefault(); finish(false); }); // Esc はキャンセル扱い

  return {
    open() {
      const layer = app.activeLayer;
      if (!layer || !app.beginBlurPreview()) return;
      ui.blurTarget.textContent = `選択中のレイヤー「${layer.name}」全体にかけます。`;
      range.value = num.value = String(lastRadius);
      dlg.showModal();
      range.focus();
      app.previewBlur(lastRadius);
    },
  };
}
