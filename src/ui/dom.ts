/** DOM まわりの小さな道具。 */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

export function toast(message: string, kind: 'info' | 'success' | 'error' | 'warning' = 'info', ms = 3500): void {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = `alert alert-${kind} py-2 px-3 text-sm shadow`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

interface AskOptions { title: string; body?: string; yes?: string; no?: string | null; input?: { label: string; value: number; min: number; max: number; step?: number } }

/** 確認・数値入力用のモーダル。ブラウザ標準の confirm/prompt は使わない。 */
export function ask(o: AskOptions): Promise<{ ok: boolean; value?: number }> {
  const dlg = $<HTMLDialogElement>('askDialog');
  $('askTitle').textContent = o.title;
  $('askBody').textContent = o.body ?? '';
  const yes = $<HTMLButtonElement>('askYes'), no = $<HTMLButtonElement>('askNo');
  yes.textContent = o.yes ?? 'OK';
  no.textContent = o.no ?? 'キャンセル';
  no.classList.toggle('hidden', o.no === null);
  const wrap = $('askInputWrap'), input = $<HTMLInputElement>('askInput');
  wrap.classList.toggle('hidden', !o.input);
  if (o.input) {
    $('askInputLabel').textContent = o.input.label;
    Object.assign(input, { value: String(o.input.value), min: String(o.input.min), max: String(o.input.max), step: String(o.input.step ?? 1) });
  }
  return new Promise(resolve => {
    const done = (ok: boolean) => {
      yes.onclick = no.onclick = null; dlg.onclose = null; input.onkeydown = null;
      dlg.close();
      const v = o.input ? Math.max(o.input.min, Math.min(o.input.max, Number(input.value) || o.input.value)) : undefined;
      resolve({ ok, value: v });
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } };
    // close イベントは閉じた後に遅れて届く。続けて ask() を開いたとき、前の分の close で
    // 新しいダイアログが閉じないよう、まだ開いているなら無視する(Esc で閉じたときは閉じている)
    dlg.onclose = () => { if (!dlg.open) done(false); };
    dlg.showModal();
    (o.input ? input : yes).focus();
  });
}

export function setBusy(on: boolean): void {
  const el = $('busy');
  el.classList.toggle('hidden', !on);
  el.classList.toggle('flex', on);
}

/**
 * ファイルを保存する。Chrome 系では保存先を選ぶダイアログを使い、無ければダウンロードにする。
 * 戻り値は保存したハンドル(ダウンロード時は null)。キャンセル時は undefined。
 */
export async function saveFile(blob: Blob, name: string, types: FilePickerAcceptType[], handle?: FileSystemFileHandle | null): Promise<FileSystemFileHandle | null | undefined> {
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob); await w.close();
    return handle;
  }
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types });
      const w = await h.createWritable();
      await w.write(blob); await w.close();
      return h;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return undefined;
      // セキュリティ上の制限などで使えないときはダウンロードへ
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
