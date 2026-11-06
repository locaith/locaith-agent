/** StoreIO trên IndexedDB cho bản trình duyệt: mỗi "tệp" là một bản ghi; ghi trong MỘT giao dịch nên nguyên tử. */

import type { StoreIO } from '../shared/sessionStore';

const STORE = 'files';

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbStoreIO(dbName = 'nd-sessions'): StoreIO {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const store = async (mode: IDBTransactionMode) => (await db()).transaction(STORE, mode).objectStore(STORE);

  return {
    async read(name) {
      const v = await reqToPromise((await store('readonly')).get(name));
      if (!(v instanceof Uint8Array)) throw new Error(`Không có bản ghi: ${name}`);
      return v;
    },
    async write(name, data) {
      await reqToPromise((await store('readwrite')).put(data, name));
    },
    async remove(name) {
      await reqToPromise((await store('readwrite')).delete(name));
    },
    async names() {
      return (await reqToPromise((await store('readonly')).getAllKeys())).filter((k): k is string => typeof k === 'string');
    },
  };
}
