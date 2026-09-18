/* L-Nutra Voice of the Customer — db.js (A1)
 * IndexedDB wrapper ('voc' v1; stores records / overlays / meta, keyPath 'id') with an in-memory Map fallback
 * used when indexedDB is undefined (jsc, private windows) or open() rejects, blocks or exceeds 2 s. SPEC §4.2.
 */
window.VOC = window.VOC || {};
(function () {
  'use strict';

  const DB_NAME = 'voc';
  const DB_VERSION = 1;
  const STORES = ['records', 'overlays', 'meta'];
  const OPEN_TIMEOUT_MS = 2000;

  let mode = 'unknown';          // 'idb' | 'memory' | 'unknown'
  let idb = null;                // IDBDatabase when mode === 'idb'
  let opening = null;            // Promise<'idb'|'memory'> while open() is in flight
  const memory = {};             // store → Map<id, obj>
  STORES.forEach((s) => { memory[s] = new Map(); });

  function useMemory() {
    mode = 'memory';
    idb = null;
    return mode;
  }

  function openIdb() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
        resolve(value);
      };
      const timer = typeof setTimeout === 'function' ? setTimeout(() => finish(useMemory()), OPEN_TIMEOUT_MS) : null;
      let req;
      try {
        req = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        finish(useMemory());
        return;
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        STORES.forEach((s) => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
        });
      };
      req.onsuccess = () => {
        const db = req.result;
        const missing = STORES.some((s) => !db.objectStoreNames.contains(s));
        if (missing) { db.close(); finish(useMemory()); return; }
        db.onversionchange = () => { db.close(); useMemory(); };
        idb = db;
        mode = 'idb';
        finish(mode);
      };
      req.onerror = () => finish(useMemory());
      req.onblocked = () => finish(useMemory());
    });
  }

  /**
   * Open the database. Resolves 'idb' or 'memory'; never rejects.
   * @returns {Promise<'idb'|'memory'>}
   */
  function open() {
    if (mode !== 'unknown') return Promise.resolve(mode);
    if (opening) return opening;
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
      opening = Promise.resolve(useMemory());
    } else {
      opening = openIdb();
    }
    return opening;
  }

  function assertStore(store) {
    if (!STORES.includes(store)) throw new Error('VOC.db: unknown store "' + store + '"');
  }

  /** Run fn(objectStore) inside a transaction; resolves with the request result. Falls back to memory on failure. */
  function tx(store, rwMode, fn) {
    assertStore(store);
    return open().then(() => {
      if (mode !== 'idb') return fn(null);
      return new Promise((resolve, reject) => {
        let t;
        try {
          t = idb.transaction(store, rwMode);
        } catch (e) {
          useMemory();
          resolve(fn(null));
          return;
        }
        const os = t.objectStore(store);
        let result;
        try {
          result = fn(os);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error || new Error('VOC.db: transaction failed'));
        t.onabort = () => reject(t.error || new Error('VOC.db: transaction aborted'));
      });
    });
  }

  function requestToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const db = {
    open,
    /** @returns {'idb'|'memory'|'unknown'} */
    persistence() { return mode; },
    /**
     * All objects in a store.
     * @param {'records'|'overlays'|'meta'} store
     * @returns {Promise<any[]>}
     */
    getAll(store) {
      return tx(store, 'readonly', (os) => {
        if (!os) return Array.from(memory[store].values());
        return requestToPromise(os.getAll());
      });
    },
    /**
     * One object by id, or undefined.
     * @returns {Promise<any>}
     */
    get(store, id) {
      return tx(store, 'readonly', (os) => {
        if (!os) return memory[store].get(id);
        return requestToPromise(os.get(id));
      });
    },
    /**
     * Insert or replace one object (must carry an id).
     * @returns {Promise<any>} the stored object
     */
    put(store, obj) {
      if (!obj || obj.id === undefined || obj.id === null) return Promise.reject(new Error('VOC.db.put: object needs an id'));
      return tx(store, 'readwrite', (os) => {
        if (!os) { memory[store].set(obj.id, obj); return obj; }
        os.put(obj);
        return obj;
      });
    },
    /**
     * Insert or replace many objects in one transaction. Items without an id are skipped.
     * @returns {Promise<number>} count written
     */
    bulkPut(store, arr) {
      const items = (arr || []).filter((o) => o && o.id !== undefined && o.id !== null);
      if (!items.length) return open().then(() => 0);
      return tx(store, 'readwrite', (os) => {
        if (!os) { items.forEach((o) => memory[store].set(o.id, o)); return items.length; }
        items.forEach((o) => os.put(o));
        return items.length;
      });
    },
    /** Delete one object by id. @returns {Promise<void>} */
    remove(store, id) {
      return tx(store, 'readwrite', (os) => {
        if (!os) { memory[store].delete(id); return undefined; }
        os.delete(id);
        return undefined;
      });
    },
    /** Delete every object in a store. @returns {Promise<void>} */
    clear(store) {
      return tx(store, 'readwrite', (os) => {
        if (!os) { memory[store].clear(); return undefined; }
        os.clear();
        return undefined;
      });
    }
  };

  VOC.db = db;
})();
