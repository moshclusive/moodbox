(() => {
  "use strict";

  const DB_NAME = "moodboxDownload-library";
  const DB_VERSION = 1;
  const TRAY_ID = "__selection__";
  const NO_FOLDER_ID = "__no_folder__";
  let dbPromise = null;

  function requestAsPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted."));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    });
  }

  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("folders")) {
          const folders = db.createObjectStore("folders", {keyPath: "id"});
          folders.createIndex("nameLower", "nameLower", {unique: true});
          folders.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains("items")) {
          const items = db.createObjectStore("items", {keyPath: "id"});
          items.createIndex("folderId", "folderId");
          items.createIndex("folderFingerprint", ["folderId", "fingerprint"], {unique: true});
          items.createIndex("createdAt", "createdAt");
          items.createIndex("sourceHost", "sourceHost");
          items.createIndex("type", "type");
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error("Could not open MoodBox storage."));
      request.onblocked = () => reject(new Error("MoodBox storage upgrade is blocked by another open tab."));
    });
    return dbPromise;
  }

  function cleanFolderName(value) {
    return String(value || "")
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 80);
  }

  function cleanFilename(value, fallback = "asset") {
    return (String(value || "")
      .split(/[\\/]/).pop()
      .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
      .replace(/[. ]+$/g, "")
      .trim() || fallback).slice(0, 180);
  }

  function normalizeRecord(record, folderId) {
    const now = Date.now();
    const fingerprint = String(record?.fingerprint || record?.id || record?.url || crypto.randomUUID());
    let sourceHost = "";
    try { sourceHost = new URL(String(record?.pageUrl || record?.url || "")).hostname.replace(/^www\./, ""); } catch (_) {}
    const blob = record?.blob instanceof Blob ? record.blob : null;
    const bytes = Math.max(Number(record?.bytes || 0), Number(blob?.size || 0));
    return {
      id: String(record?.libraryId || crypto.randomUUID()),
      folderId: String(folderId || TRAY_ID),
      fingerprint,
      filename: cleanFilename(record?.filename, `asset-${now}`),
      type: String(record?.type || "asset").toLowerCase(),
      kind: String(record?.kind || "other"),
      width: Math.max(0, Number(record?.width || 0)),
      height: Math.max(0, Number(record?.height || 0)),
      bytes,
      blob,
      mime: String(record?.mime || blob?.type || "application/octet-stream"),
      sourceUrl: String(record?.sourceUrl || record?.url || ""),
      pageUrl: String(record?.pageUrl || ""),
      pageTitle: String(record?.pageTitle || ""),
      sourceHost,
      alt: String(record?.alt || ""),
      fontFamily: String(record?.fontFamily || ""),
      fontStyle: String(record?.fontStyle || ""),
      fontWeight: String(record?.fontWeight || ""),
      createdAt: Number(record?.createdAt || now),
      updatedAt: now,
      order: Number.isFinite(Number(record?.order)) ? Number(record.order) : now
    };
  }

  function betterRecord(first, second) {
    if (!first) return second;
    if (!second) return first;
    const firstArea = Number(first.width || 0) * Number(first.height || 0);
    const secondArea = Number(second.width || 0) * Number(second.height || 0);
    if (secondArea > firstArea) return {...first, ...second, id: first.id, createdAt: first.createdAt};
    if (secondArea === firstArea && Number(second.bytes || 0) > Number(first.bytes || 0)) {
      return {...first, ...second, id: first.id, createdAt: first.createdAt};
    }
    return {...second, ...first, updatedAt: Date.now()};
  }

  async function saveItem(record, folderId = TRAY_ID) {
    const db = await openDatabase();
    const tx = db.transaction(["items"], "readwrite");
    const store = tx.objectStore("items");
    const index = store.index("folderFingerprint");
    const incoming = normalizeRecord(record, folderId);
    const existing = await requestAsPromise(index.get([incoming.folderId, incoming.fingerprint]));
    const finalRecord = existing ? betterRecord(existing, incoming) : incoming;
    store.put(finalRecord);
    await transactionDone(tx);
    return finalRecord;
  }

  async function getItemByFolderFingerprint(folderId, fingerprint) {
    const db = await openDatabase();
    const tx = db.transaction(["items"], "readonly");
    const result = await requestAsPromise(tx.objectStore("items").index("folderFingerprint").get([String(folderId), String(fingerprint)]));
    await transactionDone(tx);
    return result || null;
  }

  async function getItems(folderId = null) {
    const db = await openDatabase();
    const tx = db.transaction(["items"], "readonly");
    const store = tx.objectStore("items");
    const rows = folderId === null
      ? await requestAsPromise(store.getAll())
      : await requestAsPromise(store.index("folderId").getAll(String(folderId)));
    await transactionDone(tx);
    return (rows || []).sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  }

  async function getTrayItems() {
    return getItems(TRAY_ID);
  }

  async function deleteItems(ids) {
    const list = [...new Set((ids || []).map(String).filter(Boolean))];
    if (!list.length) return 0;
    const db = await openDatabase();
    const tx = db.transaction(["items"], "readwrite");
    const store = tx.objectStore("items");
    list.forEach(id => store.delete(id));
    await transactionDone(tx);
    return list.length;
  }

  async function deleteTrayFingerprints(fingerprints) {
    const wanted = new Set((fingerprints || []).map(String));
    if (!wanted.size) return 0;
    const tray = await getTrayItems();
    return deleteItems(tray.filter(item => wanted.has(item.fingerprint)).map(item => item.id));
  }

  async function clearFolder(folderId) {
    const rows = await getItems(folderId);
    await deleteItems(rows.map(row => row.id));
    return rows.length;
  }

  async function createFolder(name) {
    const clean = cleanFolderName(name);
    if (!clean) throw new Error("Enter a folder name.");
    const db = await openDatabase();
    const tx = db.transaction(["folders"], "readwrite");
    const store = tx.objectStore("folders");
    const byName = store.index("nameLower");
    const nameLower = clean.toLowerCase();
    const existing = await requestAsPromise(byName.get(nameLower));
    if (existing) {
      await transactionDone(tx);
      return existing;
    }
    const now = Date.now();
    const folder = {id: crypto.randomUUID(), name: clean, nameLower, createdAt: now, updatedAt: now};
    store.add(folder);
    await transactionDone(tx);
    return folder;
  }

  async function getFolders() {
    const db = await openDatabase();
    const tx = db.transaction(["folders"], "readonly");
    const rows = await requestAsPromise(tx.objectStore("folders").getAll());
    await transactionDone(tx);
    return (rows || []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  async function getFolder(folderId) {
    const db = await openDatabase();
    const tx = db.transaction(["folders"], "readonly");
    const result = await requestAsPromise(tx.objectStore("folders").get(String(folderId)));
    await transactionDone(tx);
    return result || null;
  }

  async function renameFolder(folderId, name) {
    const clean = cleanFolderName(name);
    if (!clean) throw new Error("Enter a folder name.");
    const db = await openDatabase();
    const tx = db.transaction(["folders"], "readwrite");
    const store = tx.objectStore("folders");
    const current = await requestAsPromise(store.get(String(folderId)));
    if (!current) throw new Error("Folder not found.");
    current.name = clean;
    current.nameLower = clean.toLowerCase();
    current.updatedAt = Date.now();
    store.put(current);
    await transactionDone(tx);
    return current;
  }

  async function deleteFolder(folderId, {deleteContents = true} = {}) {
    const id = String(folderId || "");
    if (!id || id === TRAY_ID) return 0;
    let removed = 0;
    if (deleteContents) removed = await clearFolder(id);
    const db = await openDatabase();
    const tx = db.transaction(["folders"], "readwrite");
    tx.objectStore("folders").delete(id);
    await transactionDone(tx);
    return removed;
  }

  async function moveTrayFingerprintsToFolder(fingerprints, folderId) {
    const wanted = [...new Set((fingerprints || []).map(String).filter(Boolean))];
    if (!wanted.length) return {moved: 0, merged: 0, missing: 0};
    const targetId = String(folderId || "");
    if (!targetId || targetId === TRAY_ID) throw new Error("Choose a collection folder.");

    const db = await openDatabase();
    const tx = db.transaction(["items", "folders"], "readwrite");
    const itemStore = tx.objectStore("items");
    const folderStore = tx.objectStore("folders");
    const index = itemStore.index("folderFingerprint");
    let moved = 0, merged = 0, missing = 0;

    for (const fingerprint of wanted) {
      const source = await requestAsPromise(index.get([TRAY_ID, fingerprint]));
      if (!source) { missing += 1; continue; }
      const target = await requestAsPromise(index.get([targetId, fingerprint]));
      if (target) {
        itemStore.put(betterRecord(target, {...source, folderId: targetId, updatedAt: Date.now()}));
        itemStore.delete(source.id);
        merged += 1;
      } else {
        source.folderId = targetId;
        source.updatedAt = Date.now();
        itemStore.put(source);
        moved += 1;
      }
    }

    const folder = await requestAsPromise(folderStore.get(targetId));
    if (folder) {
      folder.updatedAt = Date.now();
      folderStore.put(folder);
    }
    await transactionDone(tx);
    return {moved, merged, missing};
  }

  async function moveItemsToFolder(itemIds, folderId) {
    const ids = [...new Set((itemIds || []).map(String).filter(Boolean))];
    const targetId = String(folderId || "");
    if (!ids.length) return {moved: 0, merged: 0, missing: 0};
    if (!targetId || targetId === TRAY_ID) throw new Error("Choose a collection folder.");
    const db = await openDatabase();
    const tx = db.transaction(["items", "folders"], "readwrite");
    const itemStore = tx.objectStore("items");
    const folderStore = tx.objectStore("folders");
    const index = itemStore.index("folderFingerprint");
    let moved = 0, merged = 0, missing = 0;
    for (const id of ids) {
      const source = await requestAsPromise(itemStore.get(id));
      if (!source) { missing += 1; continue; }
      if (source.folderId === targetId) continue;
      const target = await requestAsPromise(index.get([targetId, source.fingerprint]));
      if (target) {
        itemStore.put(betterRecord(target, {...source, folderId: targetId, updatedAt: Date.now()}));
        itemStore.delete(source.id);
        merged += 1;
      } else {
        source.folderId = targetId;
        source.updatedAt = Date.now();
        itemStore.put(source);
        moved += 1;
      }
    }
    const folder = await requestAsPromise(folderStore.get(targetId));
    if (folder) { folder.updatedAt = Date.now(); folderStore.put(folder); }
    await transactionDone(tx);
    return {moved, merged, missing};
  }

  async function copyItemToFolder(itemId, folderId) {
    const db = await openDatabase();
    const tx = db.transaction(["items"], "readonly");
    const item = await requestAsPromise(tx.objectStore("items").get(String(itemId)));
    await transactionDone(tx);
    if (!item) throw new Error("Saved asset not found.");
    const copy = {...item, libraryId: undefined, id: undefined, createdAt: Date.now()};
    return saveItem(copy, folderId);
  }

  async function summary() {
    const [folders, items] = await Promise.all([getFolders(), getItems(null)]);
    const counts = new Map();
    const bytes = new Map();
    for (const item of items) {
      counts.set(item.folderId, (counts.get(item.folderId) || 0) + 1);
      bytes.set(item.folderId, (bytes.get(item.folderId) || 0) + Number(item.bytes || item.blob?.size || 0));
    }
    return {folders, items, counts, bytes};
  }

  async function requestPersistence() {
    let persisted = false;
    try {
      if (navigator.storage?.persist) persisted = await navigator.storage.persist();
    } catch (_) {}
    let estimate = {usage: 0, quota: 0};
    try {
      if (navigator.storage?.estimate) estimate = await navigator.storage.estimate();
    } catch (_) {}
    return {persisted, usage: Number(estimate.usage || 0), quota: Number(estimate.quota || 0)};
  }

  globalThis.MoodBoxLibrary = Object.freeze({
    DB_NAME,
    DB_VERSION,
    TRAY_ID,
    NO_FOLDER_ID,
    openDatabase,
    cleanFolderName,
    cleanFilename,
    saveItem,
    getItemByFolderFingerprint,
    getItems,
    getTrayItems,
    deleteItems,
    deleteTrayFingerprints,
    clearFolder,
    createFolder,
    getFolders,
    getFolder,
    renameFolder,
    deleteFolder,
    moveTrayFingerprintsToFolder,
    moveItemsToFolder,
    copyItemToFolder,
    summary,
    requestPersistence
  });
})();
