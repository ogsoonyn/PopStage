/**
 * IndexedDB への自動保存。タブを閉じても作業が消えないようにする(11章)。
 * 中身は .popstage と同じバイト列。
 */
const DB_NAME = 'popstage';
const STORE = 'autosave';
const KEY = 'current';

export interface AutosaveEntry { savedAt: number; name: string; bytes: Uint8Array }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode), req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally { db.close(); }
}

export const autosave = {
  async save(entry: AutosaveEntry): Promise<void> { await tx('readwrite', s => s.put(entry, KEY)); },
  async load(): Promise<AutosaveEntry | undefined> {
    try { return await tx<AutosaveEntry | undefined>('readonly', s => s.get(KEY)); } catch { return undefined; }
  },
  async clear(): Promise<void> { try { await tx('readwrite', s => s.delete(KEY)); } catch { /* 無視 */ } },
};
