/** 最近開いたファイルのダイアログ。縮小画像の一覧から選んで開き直す。 */
import type { App } from '../app';
import { recent, type RecentEntry } from '../storage/recent';
import { ask, toast, formatBytes } from './dom';
import { ui } from './ids';

const KIND_LABEL = { project: 'プロジェクト', image: '画像' } as const;
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pukupop: 'application/zip', popstage: 'application/zip' };

function when(t: number): string {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `今日 ${time}`;
  const date = d.toLocaleDateString('ja-JP', d.getFullYear() === now.getFullYear() ? { month: 'numeric', day: 'numeric' } : { year: 'numeric', month: 'numeric', day: 'numeric' });
  return `${date} ${time}`;
}

export function bindRecentDialog(app: App): { open: () => Promise<void> } {
  const dlg = ui.recentDialog, list = ui.recentList, empty = ui.recentEmpty, clear = ui.recentClear;
  let urls: string[] = [];
  const revoke = () => { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; };
  dlg.addEventListener('close', revoke);

  async function render(focusIndex = -1): Promise<void> {
    const entries = await recent.list();
    revoke();
    list.replaceChildren(...entries.map(card));
    empty.classList.toggle('hidden', entries.length > 0);
    clear.disabled = entries.length === 0;
    if (focusIndex < 0) return;
    if (entries.length) list.querySelectorAll<HTMLButtonElement>('button.recent-open')[Math.min(focusIndex, entries.length - 1)]?.focus();
    else dlg.querySelector<HTMLButtonElement>('form[method=dialog] button')?.focus(); // 空になったら「閉じる」へ
  }

  function card(e: RecentEntry, i: number): HTMLElement {
    const li = document.createElement('li');
    li.className = 'relative';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-open flex flex-col w-full text-left rounded-box border border-base-300 bg-base-100 hover:border-primary focus-visible:outline-2 focus-visible:outline-primary overflow-hidden';
    btn.title = `${e.name}(${formatBytes(e.size)})\nDelete キーで一覧から外す`;
    btn.setAttribute('aria-keyshortcuts', 'Delete');
    const pic = document.createElement('div');
    pic.className = 'recent-thumb aspect-[4/3] bg-base-200 flex items-center justify-center';
    if (e.thumb) {
      const img = document.createElement('img'), url = URL.createObjectURL(e.thumb);
      urls.push(url);
      img.src = url; img.alt = ''; img.className = 'w-full h-full object-contain';
      pic.append(img);
    } else {
      pic.textContent = KIND_LABEL[e.kind];
      pic.classList.add('text-xs', 'opacity-60');
    }
    const name = document.createElement('span');
    name.className = 'recent-name px-2 pt-1 text-sm font-medium truncate';
    name.textContent = e.name;
    const meta = document.createElement('span');
    meta.className = 'px-2 pb-1.5 text-xs opacity-70 flex items-center gap-1';
    meta.textContent = `${KIND_LABEL[e.kind]} · ${when(e.openedAt)}`;
    if (!e.handle) {
      const b = document.createElement('span');
      b.className = 'badge badge-ghost badge-xs';
      b.textContent = 'コピー';
      b.title = 'このブラウザに控えた中身から開きます(元のファイルとは別扱いです)';
      meta.append(b);
    }
    btn.append(pic, name, meta);
    btn.addEventListener('click', () => void openEntry(e, i));
    btn.addEventListener('keydown', ev => { if (ev.key === 'Delete') { ev.preventDefault(); void removeEntry(e, i); } });
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'recent-remove btn btn-xs btn-circle btn-ghost bg-base-100/80 absolute top-1 right-1';
    x.textContent = '✕';
    x.setAttribute('aria-label', `「${e.name}」を一覧から外す`);
    x.title = '一覧から外す(ファイルは消えません)';
    x.addEventListener('click', () => void removeEntry(e, i));
    li.append(btn, x);
    return li;
  }

  async function removeEntry(e: RecentEntry, i: number): Promise<void> {
    await recent.remove(e.id);
    await render(i);
  }

  async function readEntry(e: RecentEntry): Promise<File | null> {
    if (e.handle) {
      const h = e.handle;
      // 開き直すたびにブラウザが読む許可を確かめる。クリックの直後に呼ぶ必要がある
      if (h.queryPermission && (await h.queryPermission({ mode: 'read' })) !== 'granted') {
        if ((await h.requestPermission?.({ mode: 'read' })) !== 'granted') { toast('ファイルを読む許可が得られませんでした。', 'warning'); return null; }
      }
      return await h.getFile();
    }
    if (e.bytes) {
      const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
      return new File([e.bytes], e.name, { type: MIME[ext] ?? '' });
    }
    throw new DOMException('中身が残っていません', 'NotFoundError');
  }

  /** ダブルクリックなどで2回目が来ても無視する */
  let opening = false;

  async function openEntry(e: RecentEntry, i: number): Promise<void> {
    if (opening) return;
    if (app.busy) { toast('いまはファイルを開けません。処理が終わってからもう一度お試しください。', 'warning'); return; }
    opening = true;
    try { await openEntryNow(e, i); } finally { opening = false; }
  }

  async function openEntryNow(e: RecentEntry, i: number): Promise<void> {
    let file: File | null;
    try { file = await readEntry(e); } catch (err) {
      if ((err as DOMException).name === 'NotFoundError') {
        const r = await ask({ title: `「${e.name}」が見つかりません`, body: '移動・名前の変更・削除をした可能性があります。一覧から外しますか?', yes: '一覧から外す', no: 'そのまま' });
        if (r.ok) await recent.remove(e.id);
        if (dlg.open) await render(i); // 外したカードの位置へフォーカスを戻す
      } else toast(`開けませんでした: ${err instanceof Error ? err.message : err}`, 'error', 6000);
      return;
    }
    if (!file) return;
    // 新しいタブで開く(開いているプロジェクトならそのタブを出す)。タブの数が上限なら、一覧を出したまま伝える
    if (!(await app.roomFor(e.handle))) return;
    dlg.close();
    await app.openFile(file, e.handle);
  }

  clear.addEventListener('click', async () => {
    const r = await ask({ title: '一覧を消去しますか?', body: '最近開いたファイルの一覧と、このブラウザに控えたコピーを消します。ファイル自体は消えません。', yes: '消去する' });
    if (!r.ok) return;
    await recent.clear();
    if (dlg.open) await render();
  });

  return {
    async open() {
      await render();
      dlg.showModal();
      list.querySelector<HTMLButtonElement>('button.recent-open')?.focus();
    },
  };
}
