/**
 * Origin-private recovery storage for local document tabs that do not have a
 * trusted desktop-library reference (web/PWA and mobile file pickers).
 *
 * Electron document tabs recover through an opaque main-process library id,
 * so their bytes are never duplicated here. Browser/mobile tabs have no
 * durable filesystem capability after the picker closes; IndexedDB is the
 * only cross-restart, same-origin store that can preserve their exact bytes.
 * Records are profile-scoped, bounded to the document workspace's 300 MiB
 * per-file limit, and contain no source path.
 */

const DB_NAME = 'yayra-document-recovery';
const DB_VERSION = 1;
const STORE_NAME = 'documents';
const MAX_RECOVERY_BYTES = 300 * 1024 * 1024;
const RECOVERY_ID = /^docrec-[A-Za-z0-9_-]{8,120}$/;

function profileIdOf(getProfileId) {
  try {
    const value = String(getProfileId?.() || 'default');
    return /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : 'default';
  } catch {
    return 'default';
  }
}

function safeRecoveryId(value) {
  const id = String(value || '');
  return RECOVERY_ID.test(id) ? id : null;
}

function copyArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (!value || !Number.isFinite(value.byteLength)) return null;
  try {
    const view = value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  } catch {
    return null;
  }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexeddb-request-failed'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('indexeddb-transaction-failed'));
    transaction.onabort = () => reject(transaction.error || new Error('indexeddb-transaction-aborted'));
  });
}

export function createDocumentRecoveryRepo({
  indexedDBImpl = typeof indexedDB !== 'undefined' ? indexedDB : null,
  getProfileId = () => 'default',
  now = () => Date.now(),
  maxBytes = MAX_RECOVERY_BYTES
} = {}) {
  let dbPromise = null;
  const byteLimit = Math.max(1, Math.min(MAX_RECOVERY_BYTES, Number(maxBytes) || MAX_RECOVERY_BYTES));

  function openDatabase() {
    if (!indexedDBImpl || typeof indexedDBImpl.open !== 'function') return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let request;
      try { request = indexedDBImpl.open(DB_NAME, DB_VERSION); } catch (error) { reject(error); return; }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('profileId', 'profileId', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('indexeddb-open-failed'));
      request.onblocked = () => reject(new Error('indexeddb-upgrade-blocked'));
    }).catch(() => null);
    return dbPromise;
  }

  const keyFor = (id) => `${profileIdOf(getProfileId)}:${id}`;

  return {
    get available() { return Boolean(indexedDBImpl && typeof indexedDBImpl.open === 'function'); },

    async save({ id, name, mime = '', bytes } = {}) {
      const recoveryId = safeRecoveryId(id);
      const data = copyArrayBuffer(bytes);
      if (!recoveryId || !data || data.byteLength <= 0 || data.byteLength > byteLimit) return null;
      const db = await openDatabase();
      if (!db) return null;
      const profileId = profileIdOf(getProfileId);
      const record = {
        key: `${profileId}:${recoveryId}`,
        profileId,
        id: recoveryId,
        name: String(name || 'Local file').replace(/\\/g, '/').split('/').pop()
          .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'Local file',
        mime: String(mime || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200),
        size: data.byteLength,
        savedAt: now(),
        data
      };
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(record);
        await transactionDone(transaction);
        return { id: record.id, name: record.name, mime: record.mime, size: record.size, savedAt: record.savedAt };
      } catch {
        return null;
      }
    },

    async load(id) {
      const recoveryId = safeRecoveryId(id);
      if (!recoveryId) return null;
      const db = await openDatabase();
      if (!db) return null;
      try {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const record = await requestResult(transaction.objectStore(STORE_NAME).get(keyFor(recoveryId)));
        if (!record || record.profileId !== profileIdOf(getProfileId) || record.id !== recoveryId) return null;
        const data = copyArrayBuffer(record.data);
        if (!data || data.byteLength <= 0 || data.byteLength > byteLimit) return null;
        return {
          id: recoveryId,
          name: String(record.name || 'Local file').replace(/\\/g, '/').split('/').pop()
            .replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'Local file',
          mime: String(record.mime || '').slice(0, 200),
          size: data.byteLength,
          savedAt: Number(record.savedAt) || null,
          data
        };
      } catch {
        return null;
      }
    },

    async remove(id) {
      const recoveryId = safeRecoveryId(id);
      if (!recoveryId) return false;
      const db = await openDatabase();
      if (!db) return false;
      try {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(keyFor(recoveryId));
        await transactionDone(transaction);
        return true;
      } catch {
        return false;
      }
    }
  };
}

export function newDocumentRecoveryId({ now = () => Date.now(), random = Math.random } = {}) {
  return `docrec-${now().toString(36)}-${random().toString(36).slice(2, 12)}`;
}

export function isDocumentRecoveryId(value) {
  return RECOVERY_ID.test(String(value || ''));
}

export { MAX_RECOVERY_BYTES };
