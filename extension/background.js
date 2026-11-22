try { importScripts("wawoff2.js"); } catch (_) { }
const BRIDGE_ENDPOINTS = ["http://127.0.0.1:57684", "http://localhost:57684"];
const PICKER_URL = chrome.runtime.getURL("picker.html");
let moodboxStateCache = { active: false, project: null, projects: [], lastUsedProjectId: "", checkedAt: 0 };
// Right-click picker handoff is memory-first so opening the note window never
// waits on chrome.storage.local. Storage remains the recovery path.
const pendingMoodboxCaptures = new Map();
const PENDING_MOODBOX_CAPTURE_TTL_MS = 60_000;
const MOODBOX_STATE_TTL_MS = 1800;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_CANDIDATES_TO_FETCH = 32;
const IMAGE_FETCH_CONCURRENCY = 4;
const MEDIA_DOWNLOAD_CONCURRENCY = 3;
const FONT_STYLESHEET_CONCURRENCY = 4;
const MAX_METADATA_PAGES = 4;
const PENDING_FILENAME_TTL_MS = 30_000;
const pendingFilenameRequests = [];
const DOWNLOAD_HOVER_SETTING = "downloadHoverEnabled";
const MOODBOX_AUTO_SOURCE_CAPTION_SETTING = "moodboxAutoSourceCaption";
const CONTEXT_TARGET_TTL_MS = 20_000;
const PAGE_CONTEXT_MENU_CONTEXTS = ["page", "frame", "selection", "link", "editable", "image", "video", "audio"];
const contextTargetCache = new Map();
const recentHotkeyDownloads = new Map();
const HOTKEY_DEDUP_TTL_MS = 20_000;
const LIBRARY_DB_NAME = "moodboxDownload-library";
const LIBRARY_DB_VERSION = 1;
const LIBRARY_NO_FOLDER_ID = "__no_folder__";
const LIBRARY_TRAY_ID = "__selection__";
let libraryContextMenuDynamicIds = [];
const libraryContextMenuFolderMap = new Map();
let libraryDbPromise = null;
let pageContextMenuBuildPromise = null;
let pageContextMenusReady = false;
const downloadedFonts = new Set();

function contextTargetKey(tabId, frameId = 0) {
  return `${Number(tabId || 0)}:${Number(frameId || 0)}`;
}

function rememberContextTarget(tabId, frameId, value) {
  const key = contextTargetKey(tabId, frameId);
  contextTargetCache.set(key, { ...value, createdAt: Date.now() });
  while (contextTargetCache.size > 80) contextTargetCache.delete(contextTargetCache.keys().next().value);
}

function getContextTarget(tabId, frameId = 0) {
  const key = contextTargetKey(tabId, frameId);
  const row = contextTargetCache.get(key);
  if (!row) return null;
  if (Date.now() - Number(row.createdAt || 0) > CONTEXT_TARGET_TTL_MS) {
    contextTargetCache.delete(key);
    return null;
  }
  return row;
}

function openMoodboxLibraryDatabase() {
  if (libraryDbPromise) return libraryDbPromise;
  libraryDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("folders")) {
        const folders = db.createObjectStore("folders", { keyPath: "id" });
        folders.createIndex("nameLower", "nameLower", { unique: true });
        folders.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("items")) {
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("folderId", "folderId");
        items.createIndex("folderFingerprint", ["folderId", "fingerprint"], { unique: true });
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
    request.onerror = () => reject(request.error || new Error("Could not open MoodBox Library storage."));
    request.onblocked = () => reject(new Error("MoodBox Library storage is busy in another window."));
  });
  return libraryDbPromise;
}

function libraryRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("MoodBox Library storage request failed."));
  });
}

function libraryTxDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("MoodBox Library transaction was aborted."));
    tx.onerror = () => reject(tx.error || new Error("MoodBox Library transaction failed."));
  });
}

function cleanLibraryFilename(value, fallback = "asset") {
  return (String(value || "").split(/[\\/]/).pop().replace(/[<>:"/\\|?*\\x00-\\x1f]+/g, "-").replace(/[. ]+$/g, "").trim() || fallback).slice(0, 180);
}

async function libraryContentFingerprint(blob) {
  try {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return "sha256:" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  } catch (_) {
    return "context:" + (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  }
}

async function getMoodboxLibraryFoldersForContext() {
  try {
    const db = await openMoodboxLibraryDatabase();
    const tx = db.transaction(["folders"], "readonly");
    const rows = await libraryRequest(tx.objectStore("folders").getAll());
    await libraryTxDone(tx);
    return (rows || []).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch (_) {
    return [];
  }
}

function contextMenuCreateAsync(options) {
  return new Promise(resolve => {
    try {
      chrome.contextMenus.create(options, () => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.warn("MoodBox context menu create failed", options?.id, error.message);
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (error) {
      console.warn("MoodBox context menu create threw", options?.id, error?.message || error);
      resolve(false);
    }
  });
}

async function contextMenuRemoveAllAsync() {
  try {
    // Chrome 123+ exposes removeAll() as a Promise. Waiting on a callback here
    // can deadlock the menu builder forever, which leaves the extension with
    // no right-click items at all.
    const result = chrome.contextMenus.removeAll();
    if (result && typeof result.then === "function") {
      await result;
      return true;
    }
    return true;
  } catch (error) {
    console.warn("MoodBox context menu removeAll failed", error?.message || error);
    return false;
  }
}

async function contextMenuRemoveAsync(id) {
  try {
    const result = chrome.contextMenus.remove(id);
    if (result && typeof result.then === "function") {
      await result;
    }
    return true;
  } catch (error) {
    const message = String(error?.message || error || "");
    if (/does not exist|not found/i.test(message)) return true;
    console.warn("MoodBox context menu remove failed", id, message);
    return false;
  }
}

async function rebuildLibraryContextMenuFolders(visible) {
  // Page context menu is strictly limited to "Download Image". No library submenus.
  const old = [...libraryContextMenuDynamicIds];
  libraryContextMenuDynamicIds = [];
  libraryContextMenuFolderMap.clear();
  await Promise.all(old.map(contextMenuRemoveAsync));
}

function libraryTransaction(db, storeNames, mode, worker) {
  return new Promise((resolve, reject) => {
    let tx;
    let result;
    try {
      tx = db.transaction(storeNames, mode);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error || new Error("MoodBox Library transaction was aborted."));
      tx.onerror = () => reject(tx.error || new Error("MoodBox Library transaction failed."));
      Promise.resolve().then(() => worker(tx)).then(value => { result = value; }).catch(error => {
        try { tx.abort(); } catch (_) { }
        reject(error);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function saveContextImageToLibrary(info, tab, folderId) {
  const resource = await resourceFromContextTarget(info, tab, { thumbnail: false });
  if (resource?.mediaKind === "video-thumbnail" || resource?.videoThumbnail || resource?.youtubeThumbnail) {
    throw new Error("Video thumbnails cannot be saved as still images to Moodbox Library.");
  }
  const tabId = Number(tab?.id || 0);
  const best = await resolveBestImage(resource, tabId);
  const normalized = await normalizeDownloadBlob(best.blob);
  const blob = normalized.blob;
  const mime = normalized.mime;
  const normalizedBest = { ...best, blob, mime };
  if (!blob || !Number(blob.size || 0)) throw new Error("The selected image returned no usable image data.");
  const fingerprint = await libraryContentFingerprint(blob);
  const filename = cleanLibraryFilename(finalFilename(resource, mime, normalizedBest), "image.png");
  const now = Date.now();
  const sourceHost = (() => {
    try { return new URL(String(resource?.pageUrl || resource?.url || "")).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
  })();
  const record = {
    id: globalThis.crypto?.randomUUID?.() || `mb-${now}-${Math.random().toString(36).slice(2)}`,
    folderId: String(folderId || LIBRARY_NO_FOLDER_ID),
    fingerprint,
    filename,
    type: String((mime || "image/png").split("/")[1] || "png").toLowerCase().replace("jpeg", "jpg"),
    kind: "image",
    width: Math.max(0, Number(best.width || 0)),
    height: Math.max(0, Number(best.height || 0)),
    bytes: Number(blob.size || 0),
    blob,
    mime: String(mime || blob.type || "image/png"),
    sourceUrl: String(best.resolvedUrl || resource?.url || ""),
    pageUrl: String(resource?.pageUrl || tab?.url || ""),
    pageTitle: String(resource?.pageTitle || tab?.title || ""),
    sourceHost,
    alt: String(resource?.alt || ""),
    fontFamily: "", fontStyle: "", fontWeight: "",
    createdAt: now, updatedAt: now, order: now
  };

  const db = await openMoodboxLibraryDatabase();
  // IndexedDB transactions can auto-commit when an async function yields between
  // a read request and a later write. Keep the read and write inside the same
  // request callback so the transaction can never close before store.put().
  await new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(["items"], "readwrite");
      const store = tx.objectStore("items");
      const index = store.index("folderFingerprint");
      const request = index.get([record.folderId, record.fingerprint]);
      request.onsuccess = () => {
        try {
          const existing = request.result || null;
          if (existing) {
            const existingArea = Number(existing.width || 0) * Number(existing.height || 0);
            const incomingArea = Number(record.width || 0) * Number(record.height || 0);
            const finalRecord = incomingArea > existingArea ||
              (incomingArea === existingArea && record.bytes > Number(existing.bytes || 0))
              ? { ...existing, ...record, id: existing.id, createdAt: existing.createdAt }
              : { ...record, ...existing, updatedAt: now, id: existing.id, createdAt: existing.createdAt };
            store.put(finalRecord);
          } else {
            store.put(record);
          }
        } catch (error) {
          try { tx.abort(); } catch (_) { }
          reject(error);
        }
      };
      request.onerror = () => {
        try { tx.abort(); } catch (_) { }
        reject(request.error || new Error("Could not check Moodbox Library."));
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error("Moodbox Library transaction was aborted."));
      tx.onerror = () => reject(tx.error || new Error("Moodbox Library transaction failed."));
    } catch (error) {
      reject(error);
    }
  });
  return { filename, width: record.width, height: record.height, folderId: record.folderId };
}

async function buildMenus() {
  if (!chrome.contextMenus?.removeAll || !chrome.contextMenus?.create) return false;
  if (pageContextMenuBuildPromise) return pageContextMenuBuildPromise;

  pageContextMenuBuildPromise = (async () => {
    await contextMenuRemoveAllAsync();
    contextSendMenuExists = false;
    contextSendProjectIds = [];
    contextSendSignature = "";

    const create = contextMenuCreateAsync;

    // Extension-action menu.
    await create({ id: "moodbox-download-library", title: "MoodBox Library", contexts: ["action"] });

    // Statically create "Download Image" at startup so it's always ready!
    // Notice: We do NOT create "moodbox-context-send" here!
    // When 0 projects exist, this is the ONLY context menu item, so Chrome displays it
    // directly at root level with NO MoodBox parent menu!
    await create({
      id: "moodbox-context-download",
      title: "Download Image",
      contexts: PAGE_CONTEXT_MENU_CONTEXTS,
      visible: true,
      enabled: true
    });

    pageContextMenusReady = true;
    await loadMoodboxState({ fresh: true }).then(state => {
      const projects = Array.isArray(state?.projects) ? state.projects.filter(p => p?.id) : [];
      if (state?.active && projects.length > 0) {
        return ensureSendMenuItems(projects);
      }
    }).catch(() => { });
    return true;
  })().catch(error => {
    pageContextMenusReady = false;
    console.warn("MoodBox context menu build failed", error);
    return false;
  }).finally(() => {
    pageContextMenuBuildPromise = null;
  });

  return pageContextMenuBuildPromise;
}

async function ensurePageContextMenusReady() {
  if (pageContextMenusReady) return true;
  return buildMenus();
}

function contextHasImageOrVideo(row) {
  const kind = String(row?.contextKind || "").toLowerCase();
  const resource = row?.resource || {};
  return {
    image: kind === "image" && Boolean(resource.url),
    video: kind === "video" || Boolean(resource.videoThumbnail || resource.youtubeThumbnail || resource.mediaKind === "video"),
  };
}

let contextSendMenuExists = false;
let contextSendProjectIds = [];
let contextSendSignature = "";

async function removeSendMenuItems() {
  const childIds = [...contextSendProjectIds];
  contextSendProjectIds = [];
  for (const cid of childIds) {
    await contextMenuRemoveAsync(cid);
  }
  if (contextSendMenuExists) {
    try {
      await contextMenuRemoveAsync("moodbox-context-send");
    } catch (_) { }
    contextSendMenuExists = false;
    contextSendSignature = "";
  }
}

async function ensureSendMenuItems(projects) {
  const list = Array.isArray(projects) ? projects.filter(p => p?.id) : [];
  if (!list.length) {
    await removeSendMenuItems();
    return;
  }

  const sig = list.map(p => `${p.id}:${p.name || "MoodBox"}`).join("|");
  if (contextSendMenuExists && sig === contextSendSignature) {
    try {
      await chrome.contextMenus.update("moodbox-context-send", { visible: true, enabled: true });
    } catch (_) { }
    return;
  }

  if (list.length === 1) {
    const title = `Send to ${list[0].name || "MoodBox"}`;
    for (const cid of contextSendProjectIds) await contextMenuRemoveAsync(cid);
    contextSendProjectIds = [];

    if (contextSendMenuExists) {
      await chrome.contextMenus.update("moodbox-context-send", {
        title,
        visible: true,
        enabled: true
      }).catch(async () => {
        const ok = await contextMenuCreateAsync({
          id: "moodbox-context-send",
          title,
          contexts: PAGE_CONTEXT_MENU_CONTEXTS,
          visible: true,
          enabled: true
        });
        contextSendMenuExists = Boolean(ok);
      });
    } else {
      const ok = await contextMenuCreateAsync({
        id: "moodbox-context-send",
        title,
        contexts: PAGE_CONTEXT_MENU_CONTEXTS,
        visible: true,
        enabled: true
      });
      contextSendMenuExists = Boolean(ok);
    }
    contextSendSignature = sig;
    return;
  }

  // 2+ projects: parent menu with children
  for (const cid of contextSendProjectIds) await contextMenuRemoveAsync(cid);
  contextSendProjectIds = [];

  if (contextSendMenuExists) {
    await chrome.contextMenus.update("moodbox-context-send", {
      title: "Send to MoodBox",
      visible: true,
      enabled: true
    }).catch(async () => {
      const parentOk = await contextMenuCreateAsync({
        id: "moodbox-context-send",
        title: "Send to MoodBox",
        contexts: PAGE_CONTEXT_MENU_CONTEXTS,
        visible: true,
        enabled: true
      });
      contextSendMenuExists = Boolean(parentOk);
    });
  } else {
    const parentOk = await contextMenuCreateAsync({
      id: "moodbox-context-send",
      title: "Send to MoodBox",
      contexts: PAGE_CONTEXT_MENU_CONTEXTS,
      visible: true,
      enabled: true
    });
    contextSendMenuExists = Boolean(parentOk);
  }

  for (const prj of list) {
    const childId = `moodbox-context-send-project:${prj.id}`;
    const ok = await contextMenuCreateAsync({
      id: childId,
      parentId: "moodbox-context-send",
      title: String(prj.name || "MoodBox"),
      contexts: PAGE_CONTEXT_MENU_CONTEXTS,
      visible: true,
      enabled: true
    });
    if (ok) contextSendProjectIds.push(childId);
  }
  contextSendSignature = sig;
}

let menuOpChain = Promise.resolve();

function setContextMenuState({ isFont = false, fontName = "", hasImage = false } = {}) {
  const run = async () => {
    const state = await loadMoodboxState({ fresh: false }).catch(() => null);
    const projects = Array.isArray(state?.projects) ? state.projects.filter(p => p?.id) : [];
    const isMoodboxActive = Boolean(state?.active && projects.length > 0);

    try {
      // 1. Update download menu item title:
      // If font is selected, title MUST be "Download <fontName> font" or "Download font"
      // If image is clicked, title MUST be "Download Image"
      let downloadTitle = "Download Image";
      if (isFont) {
        const cleanFont = String(fontName || "").trim();
        downloadTitle = cleanFont ? `Download ${cleanFont} font` : "Download font";
      }
      await chrome.contextMenus.update("moodbox-context-download", {
        title: downloadTitle,
        visible: Boolean(hasImage || isFont)
      });
    } catch (_) { }

    try {
      // 2. Send to MoodBox is visible whenever a project is active and target is either image or selected text
      if ((hasImage || isFont) && isMoodboxActive) {
        await ensureSendMenuItems(projects);
      } else {
        await removeSendMenuItems();
      }
    } catch (_) { }
    try { chrome.contextMenus.refresh?.(); } catch (_) { }
  };
  menuOpChain = menuOpChain.then(run, run);
  return menuOpChain;
}

async function refreshPageMenuFromCachedTarget(tabId, frameId = 0) {
  if (!pageContextMenusReady) return;
  const cached = getContextTarget(tabId, frameId);
  const isFont = cached?.contextKind === "font";
  const hasImage = (cached?.contextKind === "image" || cached?.contextKind === "video") && Boolean(cached?.resource?.url);
  if (isFont) {
    const fn = String(cached?.fontTarget?.fontFamily || "").replace(/[<>:"/\\|?*]+/g, "").trim();
    await setContextMenuState({ isFont: true, fontName: fn });
  } else if (hasImage) {
    await setContextMenuState({ hasImage: true });
  } else {
    await setContextMenuState({});
  }
}

async function moodboxBridge(path, options = {}) {
  let lastError = null;
  for (const endpoint of BRIDGE_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2200);
    try {
      const response = await fetch(`${endpoint}${path}`, { cache: "no-store", ...options, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "MoodBox rejected this request.");
      return data;
    } catch (error) {
      lastError = error;
    } finally { clearTimeout(timeout); }
  }
  const message = String(lastError?.message || "");
  if (message && !/fetch|network|abort|failed/i.test(message)) throw lastError;
  throw new Error("MoodBox background service is not running. Open MoodBox once, then try again.");
}

function moodboxFeatureEnabled() {
  return moodboxStateCache.active && Array.isArray(moodboxStateCache.projects) && moodboxStateCache.projects.length > 0;
}

function orderMoodboxProjects(projects, lastUsedProjectId = "") {
  const rows = Array.isArray(projects) ? projects.filter(row => row?.id) : [];
  const recent = String(lastUsedProjectId || "");
  if (!recent) return rows;
  const index = rows.findIndex(row => String(row.id) === recent);
  if (index <= 0) return rows;
  return [rows[index], ...rows.slice(0, index), ...rows.slice(index + 1)];
}

async function loadMoodboxState({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && now - moodboxStateCache.checkedAt < MOODBOX_STATE_TTL_MS) return moodboxStateCache;
  try {
    const mode = await moodboxBridge("/api/capture-mode");
    const lastUsedProjectId = String(mode.last_used_project_id || "");
    const rawProjects = Array.isArray(mode.projects) ? mode.projects.filter(row => row?.id) : [];
    const projects = orderMoodboxProjects(rawProjects, lastUsedProjectId);
    const primary = mode.project?.id ? mode.project : (projects[0] || null);
    moodboxStateCache = {
      active: Boolean(mode.feature_active) && projects.length > 0,
      project: primary,
      projects,
      lastUsedProjectId,
      checkedAt: now
    };
  } catch (_) {
    moodboxStateCache = { active: false, project: null, projects: [], lastUsedProjectId: "", checkedAt: now };
  }
  return moodboxStateCache;
}

async function resolveMoodboxProject({ fresh = false } = {}) {
  const state = await loadMoodboxState({ fresh });
  return state.project?.id ? state.project : null;
}

async function resolveMoodboxProjects({ fresh = false } = {}) {
  const state = await loadMoodboxState({ fresh });
  return Array.isArray(state.projects) ? state.projects : [];
}

async function requireMoodboxProjects() {
  const projects = await resolveMoodboxProjects({ fresh: true });
  if (!projects.length) throw new Error("Activate MoodBox and create at least one MoodBox first.");
  return projects;
}

async function requireMoodboxProject() {
  const projects = await requireMoodboxProjects();
  return projects[0];
}

async function autoSourceCaptionEnabled() {
  const stored = await chrome.storage.local.get({ [MOODBOX_AUTO_SOURCE_CAPTION_SETTING]: true });
  return stored[MOODBOX_AUTO_SOURCE_CAPTION_SETTING] !== false;
}

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

function isStockPreviewHost(value) {
  const host = normalizeHost(value);
  return host.endsWith("shutterstock.com") || host.endsWith("stock.adobe.com") ||
    host.endsWith("gettyimages.com") || host.endsWith("istockphoto.com");
}

function stripStockFilenamePrefix(value) {
  const source = String(value || "").trim();
  let clean = source
    .replace(/^(?:stock[-_ ]*(?:photo|image|vector|illustration|video)|shutterstock[-_ ]*(?:photo|image)?|adobe[-_ ]*stock[-_ ]*(?:photo|image)?)[-_ ]+/i, "")
    .replace(/^royalty[-_ ]*free[-_ ]+(?:photo|image|vector|illustration)[-_ ]+/i, "")
    .trim();
  if (clean !== source) clean = clean.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return clean;
}

function metadataPages(resource) {
  const details = [...new Set((Array.isArray(resource?.detailPageUrls) ? resource.detailPageUrls : [])
    .map(value => String(value || "").trim()).filter(value => /^https?:/i.test(value)))];
  if (details.length) return details.slice(0, MAX_METADATA_PAGES);
  return [];
}



function sanitizeBase(value, fallback = "browser-image") {
  const clean = String(value || "")
    .replace(/\s*-\s*YouTube\s*$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 140);
  return clean || fallback;
}

function extensionForMime(mime) {
  const value = String(mime || "").toLowerCase().split(";")[0].trim();
  const map = {
    "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/png": ".png", "image/webp": ".webp",
    "image/avif": ".avif", "image/gif": ".gif", "image/svg+xml": ".svg", "image/bmp": ".bmp",
    "image/tiff": ".tiff", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico"
  };
  return map[value] || ".png";
}

function cleanCompleteFilename(value, fallback = "") {
  const raw = String(value || "").split(/[\\/]/).pop().trim();
  if (!raw) return fallback;
  return raw
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 180) || fallback;
}

function semanticFilenameHost(host) {
  const value = normalizeHost(host);
  return value.endsWith("shutterstock.com") || value.endsWith("stock.adobe.com") ||
    value.endsWith("behance.net") || value.endsWith("pinterest.com") || value === "pin.it" ||
    value.endsWith("magnific.ai") || value.endsWith("magnific.com") ||
    value.endsWith("youtube.com") || value === "youtu.be";
}

function filenameWithMimeExtension(value, mime, { trustNamedExtension = false } = {}) {
  const filename = cleanCompleteFilename(value, "");
  const desired = extensionForMime(mime);
  if (!filename) return `Media${desired}`;
  const match = filename.match(/\.([a-z0-9]{2,7})$/i);
  if (match && trustNamedExtension) return filename;
  if (match && /^(?:avif|bmp|gif|ico|jpe?g|jfif|png|svg|tiff?|webp)$/i.test(match[1])) {
    return filename.slice(0, -(match[1].length + 1)) + desired;
  }
  return filename + desired;
}

function filenameWithExtensionFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    for (const key of ["filename", "file", "name", "download", "original_filename"]) {
      const parameter = decodeURIComponent(url.searchParams.get(key) || "").trim();
      if (parameter) return parameter.split(/[\\/]/).pop() || "";
    }
    return decodeURIComponent(url.pathname.split("/").pop() || "").trim();
  } catch (_) {
    return "";
  }
}

function filenamePartFromUrl(value) {
  return filenameWithExtensionFromUrl(value)
    .replace(/\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp|mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|ogg|oga|m4a|aac|flac|opus|woff2?|ttf|otf|eot|pdf|vtt|srt|json)$/i, "")
    .trim();
}

function urlsMatch(u1, u2) {
  if (!u1 || !u2) return false;
  if (u1 === u2) return true;
  try {
    if (decodeURIComponent(u1) === decodeURIComponent(u2)) return true;
  } catch (_) { }
  try {
    const parsed1 = new URL(u1);
    const parsed2 = new URL(u2);
    if (parsed1.origin !== parsed2.origin) return false;
    const p1 = decodeURIComponent(parsed1.pathname).replace(/\/+$/, "");
    const p2 = decodeURIComponent(parsed2.pathname).replace(/\/+$/, "");
    if (p1 && p1 === p2) return true;
  } catch (_) { }
  const file1 = filenamePartFromUrl(u1).toLowerCase();
  const file2 = filenamePartFromUrl(u2).toLowerCase();
  if (file1 && file2 && file1 === file2) return true;
  return false;
}

function filenameFromContentDisposition(value) {
  const header = String(value || "");
  const utf = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utf?.[1]) {
    try { return decodeURIComponent(utf[1].trim().replace(/^['"]|['"]$/g, "")); } catch (_) { }
  }
  const normal = header.match(/filename\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;]+))/i);
  return String(normal?.[1] || normal?.[2] || normal?.[3] || "").trim();
}

function isGenericMediaName(value) {
  const clean = sanitizeBase(value, "").toLowerCase();
  return !clean || [
    "download", "download image", "image", "browser-image", "browser image", "thumbnail",
    "video-thumbnail", "youtube video", "youtube", "photo", "picture", "media", "file",
    "original", "source", "maxresdefault", "sddefault", "hqdefault", "mqdefault",
    "photo by", "may be an image", "may be a graphic"
  ].includes(clean) || /^(?:download|image|photo|picture|media|file)[-_ ]?\d*$/i.test(clean);
}

function isMarketplaceListingName(value) {
  const text = sanitizeBase(value, "");
  return /^(?:\d[\d,\.\s]*\s+)?(?:icons?|images?|photos?|vectors?|illustrations?)\s+(?:royalty[- ]free|stock)|royalty[- ]free\s+(?:images?|stock photos?)|stock photos?\s*&\s*pictures|search results?/i.test(text) ||
    /^\d[\d,\.\s]+.*(?:royalty[- ]free|stock photos?|pictures)/i.test(text);
}


function isOpaqueMediaName(value) {
  const clean = sanitizeBase(value, "");
  if (!clean || isGenericMediaName(clean)) return true;
  const compact = clean.replace(/[-_. ]/g, "");
  if (/^[a-f0-9]{18,}$/i.test(compact)) return true;
  if (/^[A-Za-z0-9_-]{28,}$/.test(compact) && !/[aeiou]{2,}/i.test(compact)) return true;
  if (/^[0-9]{10,}$/.test(compact)) return true;
  if (/^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(clean)) return true;
  return false;
}

function stripMediaExtension(value) {
  return String(value || "")
    .split(/[\\/]/).pop()
    .replace(/\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp|mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|ogg|oga|m4a|aac|flac|opus|woff2?|ttf|otf|eot|pdf|vtt|srt|json)$/i, "")
    .trim();
}

function meaningfulBase(value, { allowOpaque = false } = {}) {
  const base = sanitizeBase(stripMediaExtension(value), "");
  if (!base || isGenericMediaName(base)) return "";
  if (!allowOpaque && isOpaqueMediaName(base)) return "";
  return base;
}

function stripAccessibilityDescription(value, limit = 160) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  text = text
    .replace(/^(?:this|the)\s+(?:image\s+)?may\s+contain\s*[-:–—]?\s*/i, "")
    .replace(/^photo by\s+.+?\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\.?\s*/i, "")
    .replace(/^photo by\s+.+?\.?\s*(?=may be|might be|image may|the image may)/i, "")
    .replace(/(?:^|[.!?]\s+)(?:may be|might be|image may contain|the image may contain|this image may contain|possibly)\b[\s\S]*$/i, "")
    .replace(/(?:^|[.!?]\s+)no photo description available\.?$/i, "")
    .trim();
  if (/^(?:may be|might be|image may|the image may|this image may|no photo description)/i.test(text)) return "";
  return text.slice(0, limit).trim();
}

function cleanPageName(value, host = "") {
  let clean = stripAccessibilityDescription(value, 220)
    .replace(/\s+/g, " ")
    .replace(/\s*[|·•]\s*(?:Instagram|Pinterest|Behance|Dribbble|Facebook|X|Twitter)\s*$/i, "")
    .replace(/\s*-\s*(?:Instagram|Pinterest|Behance|Dribbble|Facebook|X|Twitter)\s*$/i, "")
    .trim();
  const simpleHost = String(host || "").replace(/^www\./, "").split(".")[0];
  if (simpleHost) clean = clean.replace(new RegExp(`\\s*[-|]\\s*${simpleHost}$`, "i"), "").trim();
  clean = stripStockFilenamePrefix(clean);
  return sanitizeBase(clean, "");
}

function semanticResourceName(resource) {
  const host = (() => {
    try { return new URL(String(resource?.pageUrl || resource?.url || "")).hostname; } catch (_) { return String(resource?.siteHost || ""); }
  })();
  const isInstagram = /(?:^|\.)instagram\.com$/i.test(host);
  if (isInstagram) {
    const creator = cleanPageName(resource?.creatorName, host).replace(/^@/, "");
    const postId = sanitizeBase(resource?.postId, "");
    const caption = cleanPageName(resource?.mediaTitle, host);
    const shortCaption = caption && caption.length <= 92 ? caption : "";
    const instagramName = [
      creator ? `Instagram ${creator}` : "Instagram",
      postId,
      shortCaption
    ].filter(Boolean).join(" - ");
    if (instagramName) return sanitizeBase(instagramName, "Instagram image");
  }

  if (isStockPreviewHost(host)) {
    for (const value of [resource?.mediaTitle, resource?.preferredName, resource?.suggestedName]) {
      const clean = stripStockFilenamePrefix(cleanPageName(value, host));
      if (clean && !isGenericMediaName(clean) && !isOpaqueMediaName(clean) && !isMarketplaceListingName(clean)) return sanitizeBase(clean, "Stock image");
    }
  }

  const values = [
    resource?.preferredName,
    resource?.mediaTitle,
    resource?.suggestedName,
    resource?.pageMetadataTitle,
    resource?.pageTitle
  ];
  for (const value of values) {
    const clean = cleanPageName(value, host);
    if (clean && !isGenericMediaName(clean) && !isOpaqueMediaName(clean) && !isMarketplaceListingName(clean)) return clean;
  }
  const creator = cleanPageName(resource?.creatorName, host);
  const postId = sanitizeBase(resource?.postId, "");
  const site = sanitizeBase(resource?.siteName || host.replace(/^www\./, "").split(".")[0], "Media");
  const combined = [creator, postId ? `${site} ${postId}` : site].filter(Boolean).join(" - ");
  return sanitizeBase(combined, "Media");
}

function youtubeVideoId(resource) {
  const direct = String(resource?.youtubeVideoId || "").trim();
  if (direct) return direct;
  const values = [resource?.pageUrl, resource?.url, ...(resource?.detailPageUrls || [])];
  for (const value of values) {
    try {
      const url = new URL(String(value || ""));
      if (url.hostname === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
      const query = url.searchParams.get("v");
      if (query) return query;
      const path = url.pathname.match(/\/(?:embed|shorts|live|vi|vi_webp)\/([^/?#]+)/i)?.[1];
      if (path) return path;
    } catch (_) { }
  }
  return "";
}

function htmlPageTitle(html) {
  const source = String(html || "");
  const patterns = [
    /<meta[^>]+(?:name|property)=["'](?:title|og:title|twitter:title)["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:title|og:title|twitter:title)["'][^>]*>/i,
    /<title[^>]*>([\s\S]*?)<\/title>/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return decodeHtmlAttribute(match[1]).replace(/\s*-\s*YouTube\s*$/i, "").trim();
  }
  return "";
}

async function liveYouTubeTitle(tabId, videoId = "") {
  if (!Number.isInteger(tabId) || tabId <= 0) return "";
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: expectedId => {
        const clean = value => String(value || "").replace(/\s+/g, " ").replace(/\s*-\s*YouTube\s*$/i, "").trim();
        const pageId = (() => {
          try {
            const url = new URL(location.href);
            return url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|live|embed)\/([^/?#]+)/i)?.[1] || "";
          } catch (_) { return ""; }
        })();
        const selectors = [
          "ytd-watch-metadata h1 yt-formatted-string",
          "ytd-watch-metadata h1",
          "#title h1 yt-formatted-string",
          "#title h1",
          "meta[property='og:title']",
          "meta[name='title']",
          "meta[name='twitter:title']"
        ];
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const value = clean(node?.getAttribute?.("content") || node?.getAttribute?.("title") || node?.textContent);
          if (value && value.toLowerCase() !== "youtube" && value.toLowerCase() !== "download") return value;
        }
        if (!expectedId || !pageId || expectedId === pageId) {
          const value = clean(document.title);
          if (value && value.toLowerCase() !== "youtube" && value.toLowerCase() !== "download") return value;
        }
        return "";
      },
      args: [String(videoId || "")]
    });
    return sanitizeBase(result?.[0]?.result, "");
  } catch (_) {
    return "";
  }
}


function htmlStockSourceCaption(html, host = "") {
  const source = String(html || "");
  const clean = value => String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim()
    .replace(/\s*[|•·]\s*(?:Adobe\s*Stock|Shutterstock|Getty\s*Images|iStock)\s*$/i, "")
    .replace(/\s+-\s+(?:Adobe\s*Stock|Shutterstock|Getty\s*Images|iStock)\s*$/i, "")
    .trim().slice(0, 260);
  const metaPatterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title|title)["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:title|twitter:title|title)["'][^>]*>/i,
  ];
  for (const pattern of metaPatterns) {
    const value = clean(source.match(pattern)?.[1] || "");
    if (value && !isMarketplaceListingName(value)) return value;
  }
  for (const key of ["headline", "caption", "name", "title"]) {
    const pattern = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']{3,260})["']`, "i");
    const value = clean(source.match(pattern)?.[1] || "");
    if (value && !isMarketplaceListingName(value)) return value;
  }
  const heading = clean(source.match(/<h1[^>]*>([\s\S]{3,500})<\/h1>/i)?.[1] || "");
  if (heading && !isMarketplaceListingName(heading) && !/^\s*(?:image|photo|download)\s*$/i.test(heading)) return heading;
  if (normalizeHost(host).includes("stock.adobe.com")) return "";
  const title = clean(source.match(/<title[^>]*>([\s\S]{3,500})<\/title>/i)?.[1] || "");
  return title && !isMarketplaceListingName(title) ? title : "";
}

async function resolveStockSourceCaption(resource) {
  const supplied = sanitizeBase(resource?.sourceCaption || resource?.mediaTitle, "");
  if (supplied && !isMarketplaceListingName(supplied)) return supplied;
  for (const pageUrl of metadataPages(resource).slice(0, 3)) {
    for (const credentials of ["include"]) {
      try {
        const response = await fetch(pageUrl, { cache: "no-store", credentials, redirect: "follow" });
        const type = String(response.headers.get("content-type") || "").toLowerCase();
        if (!response.ok || (!type.includes("text/html") && !type.includes("application/xhtml"))) continue;
        const caption = htmlStockSourceCaption((await response.text()).slice(0, 4 * 1024 * 1024), new URL(pageUrl).hostname);
        if (caption) return caption;
      } catch (_) { }
    }
  }
  return "";
}

async function resolvePageMetadataTitle(resource) {
  const pages = metadataPages(resource);
  for (const pageUrl of pages) {
    for (const credentials of ["include", "omit"]) {
      try {
        const response = await fetch(pageUrl, { cache: "no-store", credentials, redirect: "follow" });
        const type = String(response.headers.get("content-type") || "").toLowerCase();
        if (!response.ok || (!type.includes("text/html") && !type.includes("application/xhtml"))) continue;
        const title = cleanPageName(htmlPageTitle((await response.text()).slice(0, 4 * 1024 * 1024)), new URL(pageUrl).hostname);
        if (title && !isGenericMediaName(title) && !isOpaqueMediaName(title) && !isMarketplaceListingName(title)) return title;
      } catch (_) { }
    }
  }
  return "";
}

async function resolveResourceName(resource, tabId = 0) {
  const copy = { ...(resource || {}) };
  const id = youtubeVideoId(copy);
  const pageHost = (() => {
    try { return new URL(String(copy.pageUrl || "")).hostname; } catch (_) { return ""; }
  })();
  const isYouTube = Boolean(id) || /(?:^|\.)youtube\.com$/i.test(pageHost);

  if (!isYouTube) {
    const supplied = semanticResourceName(copy);
    if (supplied && !isGenericMediaName(supplied)) copy.suggestedName = supplied;
    if (!copy.pageMetadataTitle || isGenericMediaName(copy.pageMetadataTitle)) {
      const remoteTitle = await resolvePageMetadataTitle(copy);
      if (remoteTitle) copy.pageMetadataTitle = remoteTitle;
    }
    if (isStockPreviewHost(pageHost) && !copy.sourceCaption) {
      const remoteCaption = await resolveStockSourceCaption(copy);
      if (remoteCaption) copy.sourceCaption = remoteCaption;
    }
    const resolved = semanticResourceName(copy);
    if (resolved) copy.suggestedName = resolved;
    return copy;
  }

  const explicitTitle = sanitizeBase(copy.youtubeTitle, "");
  if (!isGenericMediaName(explicitTitle)) {
    copy.suggestedName = explicitTitle;
    copy.mediaKind = "video-thumbnail";
    return copy;
  }

  const supplied = sanitizeBase(copy.suggestedName, "");
  if (!isGenericMediaName(supplied)) {
    copy.suggestedName = supplied;
    copy.mediaKind = "video-thumbnail";
    return copy;
  }

  const liveTitle = await liveYouTubeTitle(Number(tabId || 0), id);
  if (!isGenericMediaName(liveTitle)) {
    copy.suggestedName = liveTitle;
    copy.youtubeTitle = liveTitle;
    copy.mediaKind = "video-thumbnail";
    return copy;
  }

  const pageTitle = sanitizeBase(String(copy.pageTitle || "").replace(/\s*-\s*YouTube\s*$/i, ""), "");
  if (!isGenericMediaName(pageTitle)) {
    copy.suggestedName = pageTitle;
    copy.mediaKind = "video-thumbnail";
    return copy;
  }

  if (id) {
    try {
      const response = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`,
        { cache: "no-store", credentials: "omit" }
      );
      if (response.ok) {
        const data = await response.json();
        const title = sanitizeBase(data?.title, "");
        if (!isGenericMediaName(title)) {
          copy.suggestedName = title;
          copy.youtubeTitle = title;
          copy.mediaKind = "video-thumbnail";
          return copy;
        }
      }
    } catch (_) { }

    try {
      const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, {
        cache: "no-store", credentials: "omit", redirect: "follow"
      });
      if (response.ok) {
        const title = sanitizeBase(htmlPageTitle((await response.text()).slice(0, 4 * 1024 * 1024)), "");
        if (!isGenericMediaName(title)) {
          copy.suggestedName = title;
          copy.youtubeTitle = title;
          copy.mediaKind = "video-thumbnail";
          return copy;
        }
      }
    } catch (_) { }
  }

  copy.suggestedName = id ? `YouTube-${id}` : "video-thumbnail";
  copy.mediaKind = "video-thumbnail";
  return copy;
}

function finalFilename(resource, mime, best = {}) {
  const host = (() => {
    try { return new URL(String(resource?.pageUrl || resource?.url || best?.resolvedUrl || "")).hostname; }
    catch (_) { return String(resource?.siteHost || ""); }
  })();

  if (resource?.mediaKind === "video-thumbnail" || youtubeVideoId(resource)) {
    let base = sanitizeBase(resource?.youtubeTitle || resource?.suggestedName || resource?.pageTitle, "video-thumbnail");
    if (isGenericMediaName(base)) {
      const id = youtubeVideoId(resource);
      base = id ? `YouTube-${id}` : "video-thumbnail";
    }
    return `${sanitizeBase(base, "video-thumbnail")}${extensionForMime(mime)}`;
  }

  // Preserve the domain-specific semantic naming that is already reliable for
  // stock/creative platforms. Everywhere else, prefer the server's genuine
  // filename (Content-Disposition, declared original name, then resolved URL).
  if (!semanticFilenameHost(host)) {
    const dispositionName = filenameFromContentDisposition(best?.contentDisposition);
    if (dispositionName) return filenameWithMimeExtension(dispositionName, mime, { trustNamedExtension: true });

    for (const value of [resource?.originalFilename, best?.resolvedUrl, resource?.url]) {
      const filename = filenameWithExtensionFromUrl(value || "") || cleanCompleteFilename(value, "");
      if (filename) return filenameWithMimeExtension(filename, mime);
    }
  }

  let base = "";
  const stockPreview = isStockPreviewHost(host);
  if (stockPreview) base = stripStockFilenamePrefix(semanticResourceName(resource));

  const dispositionName = filenameFromContentDisposition(best?.contentDisposition);
  if (!base) base = meaningfulBase(stripStockFilenamePrefix(dispositionName), { allowOpaque: true });
  if (!base) base = meaningfulBase(stripStockFilenamePrefix(resource?.originalFilename), { allowOpaque: true });

  const resolvedName = filenameWithExtensionFromUrl(best?.resolvedUrl || "");
  if (!base) base = meaningfulBase(stripStockFilenamePrefix(resolvedName), { allowOpaque: true });

  const resourceName = filenameWithExtensionFromUrl(resource?.url || "");
  if (!base) base = meaningfulBase(stripStockFilenamePrefix(resourceName), { allowOpaque: true });

  if (!base) base = stripStockFilenamePrefix(semanticResourceName(resource));
  if (!base || isGenericMediaName(base)) {
    const simpleHost = normalizeHost(host).split(".")[0] || "Media";
    const postId = sanitizeBase(resource?.postId, "");
    base = sanitizeBase([simpleHost, postId].filter(Boolean).join(" - "), "Media");
  }
  base = stripAccessibilityDescription(stripStockFilenamePrefix(base), 140) || stripStockFilenamePrefix(base);
  base = base.replace(/\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp|mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|ogg|oga|m4a|aac|flac|opus|woff2?|ttf|otf|eot|pdf|vtt|srt|json)$/i, "");
  return `${sanitizeBase(base, "Media")}${extensionForMime(mime)}`;
}

async function blobToBase64(blob) {
  if (blob.size > MAX_IMAGE_BYTES) throw new Error("The image is larger than the 64 MB limit.");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBlob(base64, mime = "image/png") {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime || "image/png" });
}

function dataUrlToBlob(source) {
  const comma = source.indexOf(",");
  if (comma < 0) return null;
  const meta = source.slice(0, comma);
  const data = source.slice(comma + 1);
  const mime = (meta.match(/^data:([^;,]+)/i) || [])[1] || "image/png";
  try {
    if (/;base64/i.test(meta)) return base64ToBlob(data, mime);
    return new Blob([decodeURIComponent(data)], { type: mime });
  } catch (_) {
    return null;
  }
}

async function readInsidePage(tabId, source) {
  if (!tabId) return null;
  const reader = async (url, limit) => {
    try {
      const response = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (blob.size <= 0 || blob.size > limit) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      const chunk = 0x8000;
      for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + chunk, bytes.length)));
      }
      return { base64: btoa(binary), mime: blob.type || "application/octet-stream", resolvedUrl: response.url || url, contentDisposition: response.headers.get("content-disposition") || "" };
    } catch (_) {
      return null;
    }
  };
  for (const world of ["ISOLATED", "MAIN"]) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        world,
        func: reader,
        args: [source, MAX_IMAGE_BYTES]
      });
      const payload = result?.[0]?.result || null;
      if (payload?.base64) return payload;
    } catch (_) { }
  }
  return null;
}

async function sniffMime(blob) {
  const fallback = String(blob.type || "").toLowerCase();
  try {
    const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
    const box = String.fromCharCode(...bytes.slice(4, 12));
    if (/ftyp(?:avif|avis|heic|heix|mif1)/i.test(box)) return "image/avif";
  } catch (_) { }
  return fallback.startsWith("image/") ? fallback : "application/octet-stream";
}

async function measureBlob(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const result = { width: Number(bitmap.width || 0), height: Number(bitmap.height || 0) };
    bitmap.close?.();
    return result;
  } catch (_) {
    return { width: 0, height: 0 };
  }
}

async function fetchBlob(source, tabId) {
  if (!source) return null;
  if (source.startsWith("data:image/")) {
    const blob = dataUrlToBlob(source);
    return blob ? { blob, resolvedUrl: source, contentDisposition: "" } : null;
  }
  if (source.startsWith("blob:")) {
    const payload = await readInsidePage(tabId, source);
    return payload ? {
      blob: base64ToBlob(payload.base64, payload.mime),
      resolvedUrl: payload.resolvedUrl || source,
      contentDisposition: payload.contentDisposition || ""
    } : null;
  }

  for (const credentials of ["include", "omit"]) {
    try {
      const response = await fetch(source, {
        cache: "default",
        credentials,
        referrer: ""
      });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (blob.size > 0 && blob.size <= MAX_IMAGE_BYTES) {
        return {
          blob,
          resolvedUrl: response.url || source,
          contentDisposition: response.headers.get("content-disposition") || ""
        };
      }
    } catch (_) { }
  }

  const payload = await readInsidePage(tabId, source);
  return payload ? {
    blob: base64ToBlob(payload.base64, payload.mime),
    resolvedUrl: payload.resolvedUrl || source,
    contentDisposition: payload.contentDisposition || ""
  } : null;
}

function addCandidate(store, raw, rank = 1, authoritative = false, source = "page") {
  const url = String(raw || "").trim();
  if (!url) return;
  const old = store.get(url);
  const value = { url, rank: Number(rank) || 1, authoritative: Boolean(authoritative), source: String(source || "page") };
  if (!old || value.rank > old.rank || (value.authoritative && !old.authoritative)) store.set(url, value);
}

function addUrlUpgrades(store, sourceUrl) {
  const source = String(sourceUrl || "");
  try {
    const url = new URL(source);
    if (/(?:^|\.)pinimg\.com$/i.test(url.hostname)) {
      const upgraded = new URL(url.href);
      upgraded.pathname = url.pathname.replace(
        /\/(?:60x60|75x75_RS|136x136|170x|236x|280x280_RS|474x|564x|736x|1000x|1200x|\d{2,5}x(?:\d{2,5})?(?:_RS)?|originals)\//i,
        "/originals/"
      );
      if (upgraded.pathname !== url.pathname || /\/originals\//i.test(url.pathname)) {
        addCandidate(store, upgraded.href, 2_000_000, true, "pinterest-original");
      }
      // Pinterest sometimes uses non-standard CDN paths where the simple
      // size-folder replacement above is not enough. Try the common large
      // variants as additional fallbacks; resolveBestImage will keep only the
      // highest-resolution candidate that actually responds.
      for (const [token, rank] of [["1200x", 1_900_000], ["736x", 1_800_000], ["564x", 1_700_000]]) {
        const large = new URL(url.href);
        large.pathname = url.pathname.replace(/\/(?:60x60|75x75_RS|136x136|170x|236x|280x280_RS|474x|564x|736x|1000x|1200x|\d{2,5}x(?:\d{2,5})?(?:_RS)?|originals)\//i, `/${token}/`);
        if (large.pathname !== url.pathname) addCandidate(store, large.href, rank, false, `pinterest-${token}`);
      }
    }

    const behanceMatch = url.pathname.match(/\/project_modules\/([^/]+)\//i);
    if (behanceMatch) {
      for (const [variant, rank, authoritative] of [
        ["source", 1_900_000, true],
        ["max_3840", 1_800_000, false],
        ["max_1920", 1_700_000, false],
        ["1400", 1_600_000, false],
        ["max_1200", 1_500_000, false],
        ["fs", 1_400_000, false]
      ]) {
        const upgraded = new URL(url.href);
        upgraded.pathname = url.pathname.replace(/\/project_modules\/[^/]+\//i, `/project_modules/${variant}/`);
        addCandidate(store, upgraded.href, rank, authoritative, `behance-${variant}`);
      }
    }

    if (/(?:^|\.)shutterstock\.com$/i.test(url.hostname) || /(?:^|\.)shutterstockcdn\.com$/i.test(url.hostname)) {
      const sourcePath = url.pathname;
      for (const [from, to, rank] of [
        [/-(?:260nw|300w|400w|500w|600w|750w)-/i, "-1500w-", 2_450_000],
        [/-(?:260nw|300w|400w|500w|600w|750w)-/i, "-2000w-", 2_400_000],
        [/\/(?:260nw|300w|400w|500w|600w|750w)\//i, "/1500w/", 2_350_000]
      ]) {
        if (!from.test(sourcePath)) continue;
        const upgraded = new URL(url.href);
        upgraded.pathname = sourcePath.replace(from, to);
        addCandidate(store, upgraded.href, rank, false, "shutterstock-large-preview");
      }
    }

    if (/(?:^|\.)ftcdn\.net$/i.test(url.hostname) || /(?:^|\.)stock\.adobe\.com$/i.test(url.hostname)) {
      const path = url.pathname;
      for (const [size, rank] of [["2000_F_", 2_480_000], ["1000_F_", 2_400_000], ["500_F_", 2_200_000]]) {
        if (!/(?:240_F_|500_F_|1000_F_|2000_F_)/i.test(path)) continue;
        const upgraded = new URL(url.href);
        upgraded.pathname = path.replace(/(?:240_F_|500_F_|1000_F_|2000_F_)/i, size);
        addCandidate(store, upgraded.href, rank, false, "adobestock-large-preview");
      }
    }

    if (/(?:^|\.)(?:istockphoto|gettyimages)\.com$/i.test(url.hostname)) {
      if (url.searchParams.has("s")) {
        const u2048 = new URL(url.href);
        u2048.searchParams.set("s", "2048x2048");
        u2048.searchParams.delete("w");
        addCandidate(store, u2048.href, 2_480_000, false, "istock-2048");

        const u1024 = new URL(url.href);
        u1024.searchParams.set("s", "1024x1024");
        u1024.searchParams.delete("w");
        addCandidate(store, u1024.href, 2_400_000, false, "istock-1024");
      }
    }

    if (/(?:^|\.)googleusercontent\.com$/i.test(url.hostname)) {
      const s0Url = url.href.replace(/=(?:s\d+|w\d+-h\d+.*|w\d+|h\d+)(?:-no|-rw|-p)?$/i, "=s0");
      if (s0Url !== url.href) {
        addCandidate(store, s0Url, 2_800_000, false, "googleusercontent-s0");
      }
    }

    const youtube = url.pathname.match(/\/vi(?:_webp)?\/([^/]+)\/[^/]+\.(?:jpg|jpeg|webp)/i);
    if (youtube) {
      const id = youtube[1];
      const base = `https://i.ytimg.com/vi/${encodeURIComponent(id)}`;
      addCandidate(store, `${base}/maxresdefault.jpg`, 3_000_000, true, "youtube-maxres");
      addCandidate(store, `${base}/sddefault.jpg`, 2_500_000, false, "youtube-sd");
      addCandidate(store, `${base}/hqdefault.jpg`, 2_000_000, false, "youtube-hq");
      addCandidate(store, `${base}/mqdefault.jpg`, 1_500_000, false, "youtube-mq");
    }

    // Generic CDN / CMS query parameter and filename upgrades (Prothom Alo, Imgix, Cloudflare, Fastly, WordPress, etc.)
    const hasW = url.searchParams.has("w") || url.searchParams.has("width") || url.searchParams.has("maxwidth");
    const hasH = url.searchParams.has("h") || url.searchParams.has("height") || url.searchParams.has("maxheight");
    const hasResize = url.searchParams.has("resize") || url.searchParams.has("size");
    const hasCrop = url.searchParams.has("crop") || url.searchParams.has("rect") || url.searchParams.has("fit");

    if (hasW || hasH || hasResize || hasCrop) {
      for (const [targetW, rank] of [["2400", 2_250_000], ["1920", 2_200_000], ["1600", 2_150_000], ["1200", 2_100_000]]) {
        const u = new URL(url.href);
        if (u.searchParams.has("w")) u.searchParams.set("w", targetW);
        if (u.searchParams.has("width")) u.searchParams.set("width", targetW);
        if (u.searchParams.has("maxwidth")) u.searchParams.set("maxwidth", targetW);
        u.searchParams.delete("h");
        u.searchParams.delete("height");
        u.searchParams.delete("maxheight");
        u.searchParams.delete("crop");
        u.searchParams.delete("rect");
        u.searchParams.delete("fit");
        u.searchParams.delete("resize");
        addCandidate(store, u.href, rank, false, `cdn-w${targetW}`);
      }

      const uNoCrop = new URL(url.href);
      ["w", "width", "maxwidth", "h", "height", "maxheight", "crop", "rect", "fit", "resize", "size"].forEach(p => uNoCrop.searchParams.delete(p));
      if (uNoCrop.href !== url.href) {
        addCandidate(store, uNoCrop.href, 2_220_000, false, "cdn-no-crop");
      }

      const uClean = url.origin + url.pathname;
      if (uClean !== url.href) {
        addCandidate(store, uClean, 2_050_000, false, "cdn-clean-path");
      }
    }

    const wpMatch = url.pathname.match(/^(.+?)-(?:[0-9]{2,4}x[0-9]{2,4}|scaled|rotated)(\.[a-z0-9]+)$/i);
    if (wpMatch) {
      const uWp = new URL(url.href);
      uWp.pathname = wpMatch[1] + wpMatch[2];
      addCandidate(store, uWp.href, 2_300_000, false, "cms-unscaled");
    }

    if (url.pathname.includes("/image/upload/")) {
      const cloudPath = url.pathname.replace(/\/image\/upload\/(?:[a-z]_[^,/]+,?)+\/(v\d+\/)/i, "/image/upload/$1");
      if (cloudPath !== url.pathname) {
        const uCloud = new URL(url.href);
        uCloud.pathname = cloudPath;
        addCandidate(store, uCloud.href, 2_350_000, false, "cloudinary-original");
      }
    }
  } catch (_) { }
}

function stockAssetId(resource) {
  const values = [
    ...(Array.isArray(resource?.detailPageUrls) ? resource.detailPageUrls : []),
    resource?.pageUrl,
    resource?.url
  ].map(value => String(value || ""));
  for (const raw of values) {
    try {
      const url = new URL(raw);
      const host = normalizeHost(url.hostname);
      if (host.endsWith("shutterstock.com")) {
        const id = url.pathname.match(/-(\d{6,})(?:$|[/?#])/i)?.[1];
        if (id) return id;
      }
      if (host.endsWith("stock.adobe.com")) {
        const parts = url.pathname.split("/").filter(Boolean);
        for (let i = parts.length - 1; i >= 0; i -= 1) if (/^\d{6,}$/.test(parts[i])) return parts[i];
      }
      if (host.endsWith("istockphoto.com") || host.endsWith("gettyimages.com")) {
        const id = url.pathname.match(/(?:^|\/|-id)(\d{6,})(?:$|[/?#-])/i)?.[1];
        if (id) return id;
      }
      if (host.endsWith("pinterest.com") || host === "pin.it") {
        const id = url.pathname.match(/\/pin\/(\d+)/i)?.[1];
        if (id) return id;
      }
    } catch (_) { }
  }
  return "";
}

function decodeEscapedUrl(value, baseUrl) {
  let clean = String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .trim();
  if (!clean) return "";
  try { clean = new URL(clean, baseUrl).href; } catch (_) { return ""; }
  return /^https?:/i.test(clean) ? clean : "";
}

function decodeHtmlAttribute(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function metadataImageUrls(html, baseUrl) {
  const output = [];
  const source = String(html || "");
  const push = value => {
    const url = decodeEscapedUrl(value, baseUrl);
    if (url && !output.includes(url)) output.push(url);
  };

  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi,
    /<(?:img|source)[^>]+(?:src|data-src|data-original|data-original-src|data-full|data-full-src|data-hi-res-src|data-high-res-src)=["']([^"']+)["'][^>]*>/gi,
    /<(?:img|source)[^>]+(?:srcset|data-srcset|data-lazy-srcset)=["']([^"']+)["'][^>]*>/gi,
    /<link[^>]+rel=["'][^"']*preload[^"']*["'][^>]+as=["']image["'][^>]+href=["']([^"']+)["'][^>]*>/gi,
    /["'](?:originalImage|original_image|originalImageUrl|original_image_url|imageUrl|image_url|displayUrl|display_url|contentUrl|content_url|image|src|url)["']\s*:\s*["'](https?:\\?\/\/?[^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = match[1];
      if (!value) continue;
      const sourceText = pattern.source;
      if (/srcset|data-srcset|data-lazy-srcset/i.test(sourceText)) {
        for (const part of String(value).split(/\s*,\s*/)) push(part.trim().split(/\s+/)[0]);
      } else {
        push(value);
      }
      if (output.length >= 80) return output;
    }
  }

  const rawUrlPattern = /https?:\/\/[^"'\s<>\\]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s<>\\]*)?/gi;
  for (const match of source.matchAll(rawUrlPattern)) {
    push(match[0]);
    if (output.length >= 80) break;
  }
  return output;
}

async function fetchHtmlInsidePage(tabId, pageUrl) {
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0 || !/^https?:/i.test(String(pageUrl || ""))) return "";
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: "MAIN",
      func: async url => {
        try {
          const response = await fetch(url, { credentials: "include", cache: "no-store", redirect: "follow" });
          const type = String(response.headers.get("content-type") || "").toLowerCase();
          if (!response.ok || (!type.includes("text/html") && !type.includes("application/xhtml"))) return "";
          return (await response.text()).slice(0, 8 * 1024 * 1024);
        } catch (_) { return ""; }
      },
      args: [String(pageUrl)]
    });
    return String(result?.[0]?.result || "");
  } catch (_) {
    return "";
  }
}

async function enrichCandidatesFromPages(store, resource, tabId = 0, options = {}) {
  const fast = Boolean(options.fast);
  const pages = metadataPages(resource).slice(0, fast ? 1 : MAX_METADATA_PAGES);
  const assetId = stockAssetId(resource);

  for (const pageUrl of pages) {
    let html = "";
    for (const credentials of ["include", "omit"]) {
      try {
        const response = await fetch(pageUrl, { cache: "no-store", credentials, redirect: "follow" });
        const type = String(response.headers.get("content-type") || "").toLowerCase();
        if (!response.ok || (!type.includes("text/html") && !type.includes("application/xhtml"))) continue;
        html = (await response.text()).slice(0, 8 * 1024 * 1024);
        if (html) break;
      } catch (_) { }
    }
    if (!html && Number(tabId) > 0) html = await fetchHtmlInsidePage(tabId, pageUrl);
    if (!html) continue;

    const urls = metadataImageUrls(html, pageUrl);
    urls.forEach((url, index) => {
      let rank = 2_700_000 - index;
      let authoritative = false;
      try {
        const host = normalizeHost(new URL(url).hostname);
        const pageIsStock = isStockPreviewHost(pageUrl);
        const candidateMatchesAsset = Boolean(assetId && String(url).includes(String(assetId)));
        if (pageIsStock && candidateMatchesAsset && /(?:shutterstock|ftcdn|gettyimages|istockphoto|pinimg|adobe)/i.test(host)) {
          rank += 3_500_000;
          authoritative = true;
        }
        if (pageIsStock && /(?:istockphoto|media\.gettyimages|media\.istockphoto|shutterstockcdn|ftcdn|stock\.adobe)/i.test(host) && /(?:original|master|download|full|large|\d{3,4}w|\d{3,4}x\d{3,4})/i.test(url)) {
          rank += 350_000;
        }

        // Match against thumbnail/resource URL:
        // If candidate URL shares filename/stem with resource.url, it is the exact same photo!
        const resStem = (() => {
          try {
            const p = new URL(resource?.url || "").pathname.split("/").pop() || "";
            return p.replace(/\.[a-z0-9]+$/i, "").replace(/-(?:[0-9]{2,4}x[0-9]{2,4}|scaled|rotated)$/i, "");
          } catch (_) { return ""; }
        })();
        if (resStem && resStem.length >= 4 && String(url).includes(resStem)) {
          rank += 3_000_000;
          authoritative = true;
        }

        // For linked article cards (pageUrl !== resource.pageUrl):
        // og:image is the hero image of that linked story card!
        if (index === 0 && pageUrl !== resource?.pageUrl) {
          rank += 500_000;
          authoritative = true;
        }
      } catch (_) { }
      if (authoritative) {
        addCandidate(store, url, rank, authoritative, "detail-page-exact-asset");
      }
    });
  }
}

async function normalizeCandidates(resource, tabId = 0, options = {}) {
  const store = new Map();
  const rows = Array.isArray(resource?.candidates) ? resource.candidates : [];
  for (const row of rows) {
    if (typeof row === "string") addCandidate(store, row, 1);
    else if (row && typeof row === "object") addCandidate(store, row.url, row.rank, row.authoritative, row.source);
  }
  addCandidate(store, resource?.url, 500_000, false, "resource-url");
  for (const url of Array.isArray(resource?.fallbackUrls) ? resource.fallbackUrls : []) addCandidate(store, url, 100_000, false, "fallback");
  for (const row of [...store.values()]) addUrlUpgrades(store, row.url);
  await enrichCandidatesFromPages(store, resource, tabId, options);
  for (const row of [...store.values()]) addUrlUpgrades(store, row.url);
  return [...store.values()].sort((a, b) => Number(b.rank) - Number(a.rank));
}

function validAuthoritative(candidate, width, height) {
  const source = String(candidate?.source || "");
  if (source === "youtube-maxres") return width >= 1200 && height >= 675;
  if (source === "pinterest-original") return width >= 120 && height >= 120;
  if (source === "behance-source") return width >= 200 && height >= 200;
  return Boolean(candidate?.authoritative) && width >= 200 && height >= 200;
}

async function captureRenderedResource(resource, tabId) {
  const rect = resource?.viewportRect || {};
  const viewportWidth = Number(resource?.viewportWidth || 0);
  const viewportHeight = Number(resource?.viewportHeight || 0);
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0 || !viewportWidth || !viewportHeight) return null;
  if (!(Number(rect.width) > 2 && Number(rect.height) > 2)) return null;
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    const dataUrl = await chrome.tabs.captureVisibleTab(Number(tab.windowId), { format: "png" });
    const screenshot = dataUrlToBlob(dataUrl);
    if (!screenshot) return null;
    const bitmap = await createImageBitmap(screenshot);
    const scaleX = bitmap.width / viewportWidth;
    const scaleY = bitmap.height / viewportHeight;
    const sourceX = Math.max(0, Math.floor(Number(rect.left || 0) * scaleX));
    const sourceY = Math.max(0, Math.floor(Number(rect.top || 0) * scaleY));
    const sourceW = Math.max(1, Math.min(bitmap.width - sourceX, Math.ceil(Number(rect.width) * scaleX)));
    const sourceH = Math.max(1, Math.min(bitmap.height - sourceY, Math.ceil(Number(rect.height) * scaleY)));
    if (sourceW < 4 || sourceH < 4) { bitmap.close?.(); return null; }
    const canvas = new OffscreenCanvas(sourceW, sourceH);
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) { bitmap.close?.(); return null; }
    context.drawImage(bitmap, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);
    bitmap.close?.();
    const blob = await canvas.convertToBlob({ type: "image/png" });
    if (!blob?.size) return null;
    return {
      blob,
      mime: "image/png",
      width: sourceW,
      height: sourceH,
      area: sourceW * sourceH,
      resolvedUrl: String(resource?.url || "rendered-page-image"),
      contentDisposition: "",
      rank: 0,
      source: "rendered-page-fallback"
    };
  } catch (_) {
    return null;
  }
}

async function mapWithConcurrency(rows, limit, worker) {
  const input = Array.isArray(rows) ? rows : [];
  const output = new Array(input.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(Number(limit || 1), input.length || 1));
  await Promise.all(Array.from({ length: count }, async () => {
    while (cursor < input.length) {
      const index = cursor++;
      try { output[index] = await worker(input[index], index); }
      catch (_) { output[index] = null; }
    }
  }));
  return output;
}

async function fetchCandidateImage(candidate, tabId) {
  const fetched = await fetchBlob(candidate.url, tabId);
  if (!fetched?.blob) return null;
  const blob = fetched.blob;
  const dimensions = await measureBlob(blob);
  if (!dimensions.width || !dimensions.height) return null;
  if (candidate.source === "youtube-maxres" && (dimensions.width < 1200 || dimensions.height < 675)) return null;
  return {
    blob,
    mime: await sniffMime(blob),
    width: dimensions.width,
    height: dimensions.height,
    area: dimensions.width * dimensions.height,
    resolvedUrl: fetched.resolvedUrl || candidate.url,
    contentDisposition: fetched.contentDisposition || "",
    rank: candidate.rank,
    source: candidate.source,
    candidate
  };
}

async function resolveBestImage(resource, tabId, options = {}) {
  const fast = Boolean(options.fast);
  const candidateLimit = fast ? 14 : MAX_CANDIDATES_TO_FETCH;
  const fetchConcurrency = fast ? 8 : IMAGE_FETCH_CONCURRENCY;
  const candidates = (await normalizeCandidates(resource, tabId, { fast })).slice(0, candidateLimit);
  const rows = new Array(candidates.length).fill(null);
  const authoritative = candidates.map((candidate, index) => ({ candidate, index })).filter(row => row.candidate.authoritative);

  if (authoritative.length) {
    const results = await mapWithConcurrency(authoritative, fetchConcurrency, row => fetchCandidateImage(row.candidate, tabId));
    for (let i = 0; i < authoritative.length; i += 1) rows[authoritative[i].index] = results[i];
    for (const { candidate, index } of authoritative) {
      const row = rows[index];
      if (row && validAuthoritative(candidate, row.width, row.height)) return row;
    }
  }

  const remaining = candidates.map((candidate, index) => ({ candidate, index })).filter(row => !row.candidate.authoritative);
  const remainingResults = await mapWithConcurrency(remaining, fetchConcurrency, row => fetchCandidateImage(row.candidate, tabId));
  for (let i = 0; i < remaining.length; i += 1) rows[remaining[i].index] = remainingResults[i];

  let best = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    if (!best || row.area > best.area || (row.area === best.area && row.rank > best.rank)) best = row;
  }

  if (best) return best;
  const rendered = await captureRenderedResource(resource, tabId);
  if (rendered) return rendered;
  if (String(candidates[0]?.url || "").startsWith("blob:")) throw new Error("This temporary browser image is no longer available.");
  throw new Error(candidates.length ? "The website blocked access to this image." : "No image was detected.");
}

async function normalizeDownloadBlob(blob) {
  const mime = await sniffMime(blob);
  if (mime === "image/jpeg" || mime === "image/png") return { blob, mime, converted: false };
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const converted = await canvas.convertToBlob({ type: "image/png" });
    return { blob: converted, mime: "image/png", converted: true };
  } catch (_) {
    throw new Error(`This ${mime || "image"} format could not be converted to PNG.`);
  }
}



async function sendDirectToMoodbox(resource, tabId, projectId = "") {
  const projects = await requireMoodboxProjects();
  const project = projects.find(row => String(row.id) === String(projectId)) || projects[0];
  const sourceResource = { ...(resource || {}) };
  // MoodBox capture no longer displays or persists marketplace titles. Keep the
  // source page/resource data for retrieval, but send only the image itself.
  const best = await resolveBestImage(sourceResource, tabId);
  const normalized = await normalizeDownloadBlob(best.blob);
  await moodboxBridge("/api/add-image", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: project.id,
      image_base64: await blobToBase64(normalized.blob),
      filename: finalFilename(sourceResource, normalized.mime, best),
      source_url: String(best.resolvedUrl || resource?.url || ""),
      source_page_url: String(resource?.pageUrl || ""),
      source_title: "",
      source_caption: "",
      assignments: [], insights: [], focus_notes: [], general_note: ""
    })
  });
  moodboxStateCache = {
    active: true,
    project,
    projects: orderMoodboxProjects(projects, String(project.id || "")),
    lastUsedProjectId: String(project.id || ""),
    checkedAt: Date.now()
  };
  return project;
}

async function resolveMoodboxCaptureImage(resource, tabId = 0, frameId = 0) {
  const sourceResource = { ...(resource || {}) };
  sourceResource.frameId = Number(frameId || sourceResource.frameId || 0);
  const best = await resolveBestImage(sourceResource, Number(tabId || 0));
  const normalized = await normalizeDownloadBlob(best.blob);
  return {
    base64: await blobToBase64(normalized.blob),
    mime: normalized.mime,
    resolvedUrl: String(best.resolvedUrl || sourceResource.url || ""),
    filename: finalFilename(sourceResource, normalized.mime, best)
  };
}

async function openMoodboxPicker(captureId = "") {
  const width = 560, height = 470, margin = 16;
  const suffix = captureId ? `?capture_id=${encodeURIComponent(captureId)}` : "";
  const createData = { url: `${PICKER_URL}${suffix}`, type: "popup", width, height, focused: true };
  let created = null;
  try {
    created = await chrome.windows.create(createData);
  } catch (_) {
    throw new Error("Could not open the MoodBox note window.");
  }
  if (!created?.id) return;

  // Window creation is the latency-critical operation. Geometry resolution is
  // intentionally detached from it so the picker appears immediately.
  void (async () => {
    try {
      const [browserWindow, displays] = await Promise.all([
        chrome.windows.getLastFocused(),
        chrome.system.display.getInfo()
      ]);
      const centerX = Number(browserWindow?.left || 0) + Number(browserWindow?.width || width) / 2;
      const centerY = Number(browserWindow?.top || 0) + Number(browserWindow?.height || height) / 2;
      const display = displays.find(item => {
        const area = item.workArea || item.bounds;
        return area && centerX >= area.left && centerX < area.left + area.width && centerY >= area.top && centerY < area.top + area.height;
      }) || displays.find(item => item.isPrimary) || displays[0];
      const area = display?.workArea || display?.bounds;
      if (!area) return;
      const left = Math.round(area.left + area.width - width - margin);
      const top = Math.round(area.top + area.height - height - margin);
      await chrome.windows.update(created.id, { state: "normal", left, top, width, height, focused: true });
    } catch (_) { }
  })();
}

async function prepareMoodboxNoteCapture(info, tab, preferredProjectId = "") {
  const tabId = Number(tab?.id || 0);
  const frameId = Number(info?.frameId || 0);
  const cached = getContextTarget(tabId, frameId);
  if (cached?.contextKind === "video") throw new Error("Send to MoodBox is available for still images, not video thumbnails.");
  const url = String(cached?.resource?.url || info?.srcUrl || "").trim();
  if (!url) throw new Error("No image was selected.");
  const now = Date.now();
  const captureId = globalThis.crypto?.randomUUID?.() || `mb-${now}-${Math.random().toString(36).slice(2)}`;
  const resource = cached?.resource?.url ? {
    ...cached.resource,
    frameId
  } : {
    url,
    candidates: [{ url, rank: 1_000_000 }],
    pageUrl: String(tab?.url || ""),
    pageTitle: String(tab?.title || ""),
    frameId,
    suggestedName: "browser-image",
    originalFilename: filenameWithExtensionFromUrl(url)
  };
  const capture = {
    captureId, projectId: String(preferredProjectId || ""), imageUrl: url, imageBase64: "", imageMime: "",
    filename: cleanCompleteFilename(resource.originalFilename, "browser-reference.png"),
    pageUrl: resource.pageUrl, pageTitle: "", sourceCaption: "", sourceSite: "",
    tabId: Number(tab?.id || 0), frameId: Number(info?.frameId || 0), resource
  };
  pendingMoodboxCaptures.set(captureId, capture);
  setTimeout(() => pendingMoodboxCaptures.delete(captureId), PENDING_MOODBOX_CAPTURE_TTL_MS);

  // Recovery only. Do not block the UI on this disk-backed write.
  void chrome.storage.local.set({ moodboxPendingCapture: capture }).catch(() => { });
  await openMoodboxPicker(captureId);
}

function queueForcedFilename(filename) {
  const now = Date.now();
  while (pendingFilenameRequests.length && now - pendingFilenameRequests[0].createdAt > PENDING_FILENAME_TTL_MS) {
    pendingFilenameRequests.shift();
  }
  const token = {
    id: (globalThis.crypto?.randomUUID?.() || `${now}-${Math.random().toString(36).slice(2)}`),
    filename: String(filename || "browser-image.png"),
    createdAt: now
  };
  pendingFilenameRequests.push(token);
  return token;
}

function removeForcedFilename(token) {
  const index = pendingFilenameRequests.indexOf(token);
  if (index >= 0) pendingFilenameRequests.splice(index, 1);
}


const ORIGINAL_MEDIA_KINDS = new Set(["video", "video-page", "audio", "font", "document", "animation", "caption"]);
const ORIGINAL_MEDIA_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|ogg|oga|m4a|aac|flac|opus|woff2?|ttf|otf|eot|pdf|vtt|srt|json)(?:$|[?#])/i;
const MIME_EXTENSION = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif", "image/svg+xml": "svg", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
  "font/woff": "woff", "font/woff2": "woff2", "font/ttf": "ttf", "font/otf": "otf", "application/vnd.ms-fontobject": "eot",
  "application/pdf": "pdf", "text/vtt": "vtt", "application/json": "json"
};

function isOriginalMediaResource(resource) {
  const kind = String(resource?.mediaKind || resource?.kind || "").toLowerCase();
  if (ORIGINAL_MEDIA_KINDS.has(kind)) return true;
  return ORIGINAL_MEDIA_EXTENSIONS.test(String(resource?.url || "")) || /^data:(?:video|audio|font)\//i.test(String(resource?.url || ""));
}

function extensionFromOriginalResource(resource, source = "") {
  for (const value of [resource?.originalFilename, resource?.filename, source, resource?.url]) {
    const direct = String(value || "").match(ORIGINAL_MEDIA_EXTENSIONS)?.[1];
    if (direct) return direct.toLowerCase().replace("jpeg", "jpg");
    try {
      const name = filenameWithExtensionFromUrl(value);
      const named = name.match(/\.([a-z0-9]{2,7})$/i)?.[1];
      if (named) return named.toLowerCase();
    } catch (_) { }
  }
  const mime = String(resource?.mimeHint || resource?.mime || "").toLowerCase().split(";")[0].trim();
  if (MIME_EXTENSION[mime]) return MIME_EXTENSION[mime];
  const kind = String(resource?.mediaKind || resource?.kind || "").toLowerCase();
  return ({ video: "mp4", "video-page": "mp4", audio: "mp3", font: "woff2", document: "pdf", animation: "json", caption: "vtt" })[kind] || "bin";
}

function originalSourceFromResource(resource) {
  const rows = Array.isArray(resource?.candidates) ? resource.candidates : [];
  const values = [resource?.url, ...rows.map(row => typeof row === "string" ? row : row?.url)];
  const direct = values.find(value => {
    const url = String(value || "");
    return url.startsWith("blob:") || /^data:(?:video|audio|font|application|text)\//i.test(url) || ORIGINAL_MEDIA_EXTENSIONS.test(url);
  });
  return String(direct || resource?.url || "");
}

function finalOriginalFilename(resource, source) {
  const ext = extensionFromOriginalResource(resource, source);
  const host = (() => {
    try { return new URL(String(resource?.pageUrl || resource?.url || source || "")).hostname; }
    catch (_) { return String(resource?.siteHost || ""); }
  })();
  const exactSource = resource?.originalFilename || source || resource?.url || "";
  const exact = filenameWithExtensionFromUrl(exactSource) || cleanCompleteFilename(exactSource, "");
  if (!semanticFilenameHost(host) && exact) {
    const clean = cleanCompleteFilename(exact, `Media.${ext}`);
    return /\.[a-z0-9]{2,7}$/i.test(clean) ? clean : `${clean}.${ext}`;
  }

  let base = sanitizeBase(resource?.suggestedName || resource?.mediaTitle || resource?.pageTitle || "Media", "Media");
  const originalBase = meaningfulBase(exact, { allowOpaque: true });
  if ((!base || isGenericMediaName(base)) && originalBase) base = originalBase;
  base = stripAccessibilityDescription(stripStockFilenamePrefix(base), 140) || stripStockFilenamePrefix(base);
  base = base.replace(/\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp|mp4|webm|mov|m4v|ogv|avi|mkv|mp3|wav|ogg|oga|m4a|aac|flac|opus|woff2?|ttf|otf|eot|pdf|vtt|srt|json)$/i, "");
  return `${sanitizeBase(base, "Media")}.${ext}`;
}


function decodeEmbeddedMediaUrl(value, baseUrl = "") {
  let raw = String(value || "").trim()
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
  try { raw = decodeURIComponent(raw); } catch (_) { }
  try { return new URL(raw, baseUrl || undefined).href; } catch (_) { return ""; }
}

function directVideoUrlsFromHtml(html, baseUrl) {
  const source = String(html || "");
  const found = [];
  const add = value => {
    const url = decodeEmbeddedMediaUrl(value, baseUrl);
    if (!/^https?:/i.test(url)) return;
    const looksVideo = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/i.test(url) || /(?:mime|type)=video(?:%2F|\/)/i.test(url) || /(?:googlevideo|video-cdn|videodelivery|fbcdn)\./i.test(url);
    if (looksVideo && !found.includes(url)) found.push(url);
  };
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["'][^>]*>/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::secure_url|:url)?|twitter:player:stream)["'][^>]*>/gi,
    /<source[^>]+src=["']([^"']+)["'][^>]*>/gi,
    /["'](?:contentUrl|content_url|video_url|videoUrl|playbackUrl|playback_url|downloadUrl|download_url|src)["']\s*:\s*["']([^"']+)["']/gi,
    /(https?:\\?\/\\?\/[^"'\s<>]+?(?:\.mp4|\.webm|googlevideo\.com\/videoplayback|fbcdn\.net\/[^"'\s<>]+))(?:["'\s<>]|$)/gi
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      add(match[1]);
      if (found.length >= 24) return found;
    }
  }
  return found;
}

async function resolveVideoPageSource(resource) {
  const pages = [...new Set([resource?.url, ...(resource?.detailPageUrls || [])].map(value => String(value || "").trim()).filter(value => /^https?:/i.test(value)))];
  for (const pageUrl of pages.slice(0, 4)) {
    for (const credentials of ["include", "omit"]) {
      try {
        const response = await fetch(pageUrl, { cache: "no-store", credentials, redirect: "follow" });
        const type = String(response.headers.get("content-type") || "").toLowerCase();
        if (!response.ok || (!type.includes("text/html") && !type.includes("application/xhtml") && !type.includes("json"))) continue;
        const text = (await response.text()).slice(0, 12 * 1024 * 1024);
        const urls = directVideoUrlsFromHtml(text, response.url || pageUrl);
        if (urls.length) return urls[0];
      } catch (_) { }
    }
  }
  throw new Error("This page did not expose a direct video file.");
}

// Keep a global reference for compatibility with older service-worker execution
// contexts that may still have queued calls after an extension reload.
globalThis.resolveResourceName = resolveResourceName;

async function resolveOriginalSource(resource, tabId, frameId = 0) {
  if (String(resource?.mediaKind || resource?.kind || "").toLowerCase() === "video-page") return resolveVideoPageSource(resource);
  const source = originalSourceFromResource(resource);
  if (!source) throw new Error("No downloadable media source was exposed by this page.");
  if (!source.startsWith("blob:")) return source;
  const options = Number.isInteger(Number(frameId)) ? { frameId: Number(frameId) } : undefined;
  const response = await chrome.tabs.sendMessage(Number(tabId), { action: "moodboxDownload-resolve-batch-resource", url: source }, options);
  if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "This temporary video stream could not be read.");
  return response.dataUrl;
}

async function startOriginalDownload(resource, tabId = 0, frameId = 0) {
  const named = await resolveResourceName(resource, tabId);
  named.mediaKind = resource?.mediaKind || resource?.kind || named.mediaKind;
  if (Number(resource?.collectionIndex) > 0) named.suggestedName = `${named.suggestedName || "Media"} - ${String(resource.collectionIndex).padStart(2, "0")}`;
  const source = await resolveOriginalSource(resource, tabId, frameId);
  const desiredFilename = finalOriginalFilename(named, source);
  const pending = queueForcedFilename(desiredFilename);
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({ url: source, filename: desiredFilename, saveAs: false, conflictAction: "uniquify" });
  } catch (error) {
    removeForcedFilename(pending);
    throw error;
  }
  if (!Number.isInteger(downloadId)) {
    removeForcedFilename(pending);
    throw new Error("The browser could not start the media download.");
  }
  pending.downloadId = downloadId;
  setTimeout(() => removeForcedFilename(pending), PENDING_FILENAME_TTL_MS);
  return downloadId;
}

function firstUsableResourceUrl(resource) {
  const rows = Array.isArray(resource?.candidates) ? resource.candidates : [];
  const ranked = rows.map(row => typeof row === "string" ? { url: row, rank: 0 } : row)
    .filter(row => row?.url).sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0));
  const values = [resource?.url, ...ranked.map(row => row.url)].map(value => String(value || "").trim());
  return values.find(value => /^(?:https?:|data:image\/|blob:)/i.test(value)) || "";
}

async function startDirectImageFallback(resource, tabId = 0, frameId = 0) {
  let source = firstUsableResourceUrl(resource);
  if (!source) throw new Error("No downloadable image URL was exposed by this page.");
  if (source.startsWith("blob:")) {
    const options = Number.isInteger(Number(frameId)) ? { frameId: Number(frameId) } : undefined;
    const response = await chrome.tabs.sendMessage(Number(tabId), { action: "moodboxDownload-resolve-batch-resource", url: source }, options);
    if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "This temporary image is no longer available.");
    source = response.dataUrl;
  }
  const named = await resolveResourceName(resource, tabId).catch(() => ({ ...resource }));
  if (Number(resource?.collectionIndex) > 0) {
    named.suggestedName = `${named.suggestedName || "Media"} - ${String(resource.collectionIndex).padStart(2, "0")}`;
  }
  const desiredFilename = finalOriginalFilename({ ...named, mimeHint: resource?.mimeHint || resource?.mime || "image/png" }, source)
    .replace(/\.bin$/i, extensionForMime(String(resource?.mimeHint || resource?.mime || "image/png")));
  const pending = queueForcedFilename(desiredFilename);
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({ url: source, filename: desiredFilename, saveAs: false, conflictAction: "uniquify" });
  } catch (error) {
    removeForcedFilename(pending);
    throw error;
  }
  if (!Number.isInteger(downloadId)) {
    removeForcedFilename(pending);
    throw new Error("The browser could not start the fallback download.");
  }
  pending.downloadId = downloadId;
  setTimeout(() => removeForcedFilename(pending), PENDING_FILENAME_TTL_MS);
  return downloadId;
}

async function resourceFromImageContext(info, tab) {
  const tabId = Number(tab?.id || 0);
  const frameId = Number(info?.frameId || 0);
  if (!tabId) throw new Error("The source browser tab is unavailable.");

  const srcUrl = String(info?.srcUrl || "").trim();

  // 1. Direct query to content script for the exact right-clicked image target
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { action: "moodbox-get-context-target", srcUrl },
      { frameId }
    );
    if (response?.ok && response.resource?.url) {
      return { ...response.resource, frameId };
    }
  } catch (_) { }

  // 2. Check cached target, but strictly verify against srcUrl if Chrome provided one!
  let cached = getContextTarget(tabId, frameId);
  if (cached?.resource && cached.contextKind === "image") {
    if (!srcUrl) {
      // Overlay element (Pinterest pin, Stock card, etc.) where Chrome gave no srcUrl
      return { ...cached.resource, frameId };
    }
    // If srcUrl is present, cached MUST match srcUrl
    const matchesSrc = urlsMatch(cached.resource.url, srcUrl) ||
      (Array.isArray(cached.resource.candidates) && cached.resource.candidates.some(c => urlsMatch(c.url, srcUrl)));
    if (matchesSrc) {
      return { ...cached.resource, frameId };
    }
    // If it doesn't match srcUrl, cached is stale from an earlier hover! Discard it!
  }

  // 3. If srcUrl is provided, look up the exact DOM element in the tab
  if (srcUrl) {
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        { action: "moodboxDownload-resource-for-src", srcUrl },
        { frameId }
      );
      if (response?.ok && response.resource?.url) {
        return { ...response.resource, frameId };
      }
    } catch (_) { }

    // 4. Fallback: Build base resource with URL upgrades for Pinterest/Stock/Google/etc.
    const candidateStore = new Map();
    addCandidate(candidateStore, srcUrl, 1_000_000, false, "context-src");
    addUrlUpgrades(candidateStore, srcUrl);

    return {
      url: srcUrl,
      candidates: [...candidateStore.values()].sort((a, b) => b.rank - a.rank),
      pageUrl: String(tab?.url || ""),
      pageTitle: String(tab?.title || ""),
      frameId,
      suggestedName: "image"
    };
  }

  // 5. Final fallback probe for overlay without srcUrl
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "moodbox-context-probe" }, { frameId });
    if (response?.resource?.url) {
      return { ...response.resource, frameId };
    }
  } catch (_) { }

  throw new Error("No image was detected under the cursor.");
}

async function resourceFromContextTarget(info, tab, { thumbnail = false } = {}) {
  const tabId = Number(tab?.id || 0);
  const frameId = Number(info?.frameId || 0);
  if (!tabId) throw new Error("The source browser tab is unavailable.");
  let cached = getContextTarget(tabId, frameId);
  // Always re-probe for still images at click time. Stock/Pinterest cards can
  // replace the preview node or its source URL after the hover cache was made.
  // Using the live DOM target here is much more reliable for Library saves.
  if (!thumbnail) {
    try {
      const cachedPoint = cached?.point || null;
      const point = cachedPoint || { x: Number(info?.x || 0), y: Number(info?.y || 0) };
      const response = await chrome.tabs.sendMessage(tabId, {
        action: "moodbox-context-probe",
        point: { x: Number(point.x || 0), y: Number(point.y || 0) }
      }, { frameId });
      if (response?.resource?.url && response.contextKind === "image") {
        rememberContextTarget(tabId, frameId, {
          contextKind: "image",
          resource: response.resource,
          point: response.point || point,
          pageUrl: String(response.pageUrl || tab?.url || ""),
          pageTitle: String(response.pageTitle || tab?.title || "")
        });
        cached = getContextTarget(tabId, frameId);
      }
    } catch (_) { }
  }
  if (thumbnail) {
    let current = cached;
    const isValid = row => Boolean(
      row &&
      (row.contextKind === "video" || row.resource?.videoThumbnail || row.resource?.youtubeThumbnail) &&
      row.resource?.url
    );

    // Probe again at click time. The native menu can open before the hover
    // listener has finished its first asynchronous target build.
    if (!isValid(current)) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { action: "moodbox-context-probe" }, { frameId });
        if (response?.resource?.url && (response.contextKind === "video" || response.resource.videoThumbnail || response.resource.youtubeThumbnail)) {
          rememberContextTarget(tabId, frameId, {
            contextKind: "video",
            resource: response.resource,
            point: response.point || null,
            pageUrl: String(response.pageUrl || tab?.url || ""),
            pageTitle: String(response.pageTitle || tab?.title || "")
          });
          current = getContextTarget(tabId, frameId);
        }
      } catch (_) { }
    }

    if (!isValid(current)) throw new Error("No video thumbnail was detected.");
    return { ...current.resource, frameId };
  }
  const hasSrcUrl = Boolean(String(info?.srcUrl || "").trim());
  if (hasSrcUrl) {
    const directUrl = String(info.srcUrl).trim();
    // Verify whether cached actually matches this directUrl
    const cachedMatches = cached?.contextKind === "image" && cached?.resource?.url && (
      cached.resource.url === directUrl ||
      (Array.isArray(cached.resource.candidates) && cached.resource.candidates.some(c => c.url === directUrl))
    );
    if (cachedMatches) {
      return { ...cached.resource, frameId };
    }

    // Direct element probe for the clicked image to extract high-res attributes (srcset, google imgurl, etc.)
    try {
      const probe = await chrome.tabs.sendMessage(tabId, {
        action: "moodbox-get-context-target",
        srcUrl: directUrl,
        point: { x: Number(info?.x || 0), y: Number(info?.y || 0) }
      }, { frameId }).catch(() => null);

      if (probe?.resource?.url) {
        return { ...probe.resource, frameId };
      }
    } catch (_) { }

    return {
      url: directUrl,
      candidates: [{ url: directUrl, rank: 1_000_000, authoritative: false, source: "context-menu-src" }],
      pageUrl: String(tab?.url || ""),
      pageTitle: String(tab?.title || ""),
      frameId,
      suggestedName: "image",
      originalFilename: filenameWithExtensionFromUrl(directUrl)
    };
  }

  if (cached?.contextKind === "image" && cached?.resource?.url) {
    return { ...cached.resource, frameId };
  }
  throw new Error("No image was selected.");
}

function originalFilenameForContextDownload(resource, mime, best) {
  const names = [
    filenameFromContentDisposition(best?.contentDisposition),
    filenameWithExtensionFromUrl(best?.resolvedUrl || ""),
    filenameWithExtensionFromUrl(resource?.originalFilename || ""),
    filenameWithExtensionFromUrl(resource?.url || ""),
    cleanCompleteFilename(resource?.originalFilename || "", "")
  ];

  for (const raw of names) {
    const clean = cleanCompleteFilename(raw, "");
    if (!clean) continue;
    return filenameWithMimeExtension(clean, mime, { trustNamedExtension: true });
  }

  const fallbackName = filenameWithExtensionFromUrl(resource?.url || "") || "image";
  return filenameWithMimeExtension(fallbackName, mime);
}

async function startContextImageDownload(info, tab) {
  const resource = await resourceFromImageContext(info, tab);
  const best = await resolveBestImage(resource, Number(tab?.id || 0));
  // Right-click image downloads are intentionally limited to JPG/PNG.
  // WebP/AVIF/GIF/SVG/BMP/etc. are decoded at the original pixel dimensions
  // and converted losslessly to PNG instead of delivering the site's preview
  // container format to the user.
  const normalized = await normalizeDownloadBlob(best.blob);
  const normalizedBest = { ...best, blob: normalized.blob, mime: normalized.mime };
  const mime = normalized.mime;
  const filename = originalFilenameForContextDownload(resource, mime, normalizedBest);

  // Deliberately use only the filename. No MoodBox subfolder is requested.
  // This sends the file to the browser's normal configured download location.
  const downloadUrl = `data:${mime};base64,${await blobToBase64(normalized.blob)}`;
  const pending = queueForcedFilename(filename);
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } catch (error) {
    removeForcedFilename(pending);
    throw error;
  }
  if (!Number.isInteger(downloadId)) {
    removeForcedFilename(pending);
    throw new Error("The browser could not start the image download.");
  }
  pending.downloadId = downloadId;
  setTimeout(() => removeForcedFilename(pending), PENDING_FILENAME_TTL_MS);
  return { downloadId, filename, width: Number(best.width || 0), height: Number(best.height || 0) };
}

async function startContextFontDownload(info, tab) {
  const tabId = Number(tab?.id || 0);
  const frameId = Number(info?.frameId || 0);
  if (!tabId) throw new Error("The source browser tab is unavailable.");

  let fontTarget = null;
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { action: "moodbox-get-selected-font" },
      { frameId }
    );
    if (response?.ok && response.fontTarget) {
      fontTarget = response.fontTarget;
    }
  } catch (_) { }

  if (!fontTarget) {
    const cached = getContextTarget(tabId, frameId);
    if (cached?.contextKind === "font" && cached.fontTarget) {
      fontTarget = cached.fontTarget;
    }
  }

  if (!fontTarget) {
    throw new Error("No text is currently selected.");
  }

  // If fontTarget didn't find direct url, but has stylesheetUrls, scan remote stylesheets!
  if (!fontTarget.url && Array.isArray(fontTarget.stylesheetUrls) && fontTarget.stylesheetUrls.length) {
    try {
      const pageUrl = String(tab?.url || "");
      const pageTitle = String(tab?.title || "");
      const remoteFonts = await collectRemoteFontAssets(fontTarget.stylesheetUrls, pageUrl, pageTitle);
      const targetFamily = String(fontTarget.fontFamily || "").toLowerCase();
      const targetWeight = String(fontTarget.fontWeight || "400");
      const matched = remoteFonts.find(rf =>
        String(rf.fontFamily || "").toLowerCase() === targetFamily &&
        String(rf.fontWeight || "400") === targetWeight
      ) || remoteFonts.find(rf =>
        String(rf.fontFamily || "").toLowerCase() === targetFamily
      ) || remoteFonts.find(rf =>
        targetFamily.length > 2 && String(rf.url || "").toLowerCase().includes(targetFamily)
      );

      if (matched?.url) {
        fontTarget.url = matched.url;
        fontTarget.filename = matched.filename || `${sanitizeBase(fontTarget.fontFamily, "font")}.${matched.type || "woff2"}`;
        fontTarget.isSystemFont = false;
      }
    } catch (_) { }
  }

  // Check Google Fonts API fallback for TrueType (.ttf) font
  if (!fontTarget.url || fontTarget.isSystemFont) {
    const candidateFamilies = [fontTarget.fontFamily, ...(fontTarget.fallbackFamilies || [])].filter(Boolean);
    for (const fam of candidateFamilies) {
      if (/^(sans-serif|serif|monospace|system-ui|-apple-system|blinkmacsystemfont)$/i.test(fam)) continue;
      try {
        const gfUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam)}:wght@${fontTarget.fontWeight || 400}`;
        const resp = await fetch(gfUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; U; Android 2.2; en-us; Nexus One Build/FRF91) AppleWebKit/533.1 (KHTML, like Gecko) Version/4.0 Mobile Safari/533.1'
          }
        });
        if (resp.ok) {
          const css = await resp.text();
          const m = css.match(/url\((https:[^)]+\.ttf)\)/i) || css.match(/url\((https:[^)]+\.[a-z0-9]+)\)/i);
          if (m && m[1]) {
            fontTarget.url = m[1];
            fontTarget.isSystemFont = false;
            const ext = m[1].toLowerCase().endsWith(".ttf") ? "ttf" : "woff2";
            const weightNameMap = { "100": "Thin", "200": "ExtraLight", "300": "Light", "400": "Regular", "500": "Medium", "600": "SemiBold", "700": "Bold", "800": "ExtraBold", "900": "Black" };
            const weightLabel = weightNameMap[String(fontTarget.fontWeight || "400")] || "Regular";
            const cleanFamilyName = fam.replace(/[<>:"/\\|?*]+/g, "").trim();
            fontTarget.filename = `${cleanFamilyName}-${weightLabel}.${ext}`;
            break;
          }
        }
      } catch (_) { }
    }
  }

  if (fontTarget.isSystemFont || !fontTarget.url) {
    throw new Error(fontTarget.message || `Selected text uses local system font: "${fontTarget.fontFamily || "System"}". Pre-installed on Windows.`);
  }

  const fontKey = String(fontTarget.fontFamily || fontTarget.filename || "").trim().toLowerCase();
  if (fontKey && downloadedFonts.has(fontKey)) {
    let confirmed = false;
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        {
          action: "moodbox-confirm-font-download",
          fontFamily: fontTarget.fontFamily || "this font"
        },
        { frameId }
      );
      confirmed = Boolean(response?.confirmed);
    } catch (_) {
      confirmed = true;
    }

    if (!confirmed) {
      return null;
    }
  }

  const url = fontTarget.url;
  let filename = fontTarget.filename || `${sanitizeBase(fontTarget.fontFamily, "font")}.woff2`;

  let downloadUrl = url;
  try {
    const fetched = await fetchBlob(url, tabId);
    if (fetched?.blob) {
      let arrayBuffer = await fetched.blob.arrayBuffer();
      let u8 = new Uint8Array(arrayBuffer);
      const isWoff2 = u8.length >= 4 && u8[0] === 0x77 && u8[1] === 0x4f && u8[2] === 0x46 && u8[3] === 0x32;
      let convertedToTtf = false;
      if (isWoff2 && typeof globalThis.wawoff2 !== "undefined" && typeof globalThis.wawoff2.decompress === "function") {
        try {
          const ttfU8 = await globalThis.wawoff2.decompress(u8);
          if (ttfU8 && ttfU8.length > 0) {
            const ttfBlob = new Blob([ttfU8], { type: "font/ttf" });
            downloadUrl = `data:font/ttf;base64,${await blobToBase64(ttfBlob)}`;
            filename = filename.replace(/\.woff2?$/i, ".ttf");
            if (!filename.toLowerCase().endsWith(".ttf")) filename += ".ttf";
            convertedToTtf = true;
          }
        } catch (_) { }
      }
      if (isWoff2 && !convertedToTtf) {
        try {
          const rawB64 = await blobToBase64(fetched.blob);
          const convResp = await moodboxBridge("/api/convert-woff2", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ woff2_base64: rawB64 })
          });
          if (convResp?.ok && convResp.ttf_base64) {
            downloadUrl = `data:font/ttf;base64,${convResp.ttf_base64}`;
            filename = filename.replace(/\.woff2?$/i, ".ttf");
            if (!filename.toLowerCase().endsWith(".ttf")) filename += ".ttf";
            convertedToTtf = true;
          }
        } catch (_) { }
      }
      if (!convertedToTtf) {
        const mime = fetched.mime || "font/woff2";
        downloadUrl = `data:${mime};base64,${await blobToBase64(fetched.blob)}`;
      }
    }
  } catch (_) { }

  const pending = queueForcedFilename(filename);
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } catch (error) {
    removeForcedFilename(pending);
    throw error;
  }

  if (!Number.isInteger(downloadId)) {
    removeForcedFilename(pending);
    throw new Error("The browser could not start the font download.");
  }

  pending.downloadId = downloadId;
  if (fontKey) downloadedFonts.add(fontKey);
  setTimeout(() => removeForcedFilename(pending), PENDING_FILENAME_TTL_MS);
  return { downloadId, filename };
}

async function startHotkeyImageDownload(resource, tabId = 0) {
  if (!resource?.url && !Array.isArray(resource?.candidates)) {
    throw new Error("No image was detected.");
  }

  const fastResource = { ...resource };
  let best = null;
  try {
    best = await resolveBestImage(fastResource, tabId, { fast: true });
  } catch (primaryError) {
    // One direct candidate fallback keeps the shortcut responsive when a site
    // blocks metadata/detail-page probing.
    const direct = firstUsableResourceUrl(fastResource);
    if (!direct) throw primaryError;
    best = await fetchCandidateImage({ url: direct, rank: 1_000_000, authoritative: false, source: "hotkey-direct" }, tabId);
    if (!best) throw primaryError;
  }

  const dedupeSource = String(best.resolvedUrl || best.candidate?.url || fastResource.url || "").trim();
  const now = Date.now();
  for (const [key, createdAt] of recentHotkeyDownloads) {
    if (now - createdAt > HOTKEY_DEDUP_TTL_MS) recentHotkeyDownloads.delete(key);
  }
  const dedupeKey = dedupeSource || `${String(fastResource.pageUrl || "")}\n${String(fastResource.suggestedName || "")}`;
  if (recentHotkeyDownloads.has(dedupeKey)) return { skipped: true, filename: "" };

  const normalized = await normalizeDownloadBlob(best.blob);
  const normalizedBest = { ...best, blob: normalized.blob, mime: normalized.mime };
  const filename = originalFilenameForContextDownload(fastResource, normalized.mime, normalizedBest);
  const downloadUrl = `data:${normalized.mime};base64,${await blobToBase64(normalized.blob)}`;
  const pending = queueForcedFilename(filename);
  let downloadId = null;
  try {
    downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    });
  } catch (error) {
    removeForcedFilename(pending);
    throw error;
  }
  if (!Number.isInteger(downloadId)) {
    removeForcedFilename(pending);
    throw new Error("The browser could not start the image download.");
  }
  recentHotkeyDownloads.set(dedupeKey, now);
  pending.downloadId = downloadId;
  setTimeout(() => removeForcedFilename(pending), PENDING_FILENAME_TTL_MS);
  return { skipped: false, downloadId, filename, width: Number(best.width || 0), height: Number(best.height || 0) };
}

async function showContextDownloadToast(tabId, message, isError = false, iconFile = "download.png") {
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0) return;
  const iconUrl = iconFile ? chrome.runtime.getURL(iconFile) : "";
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      args: [String(message || ""), Boolean(isError), String(iconUrl || "")],
      func: (text, error, icon) => {
        document.getElementById("moodbox-context-download-toast")?.remove();
        const node = document.createElement("div");
        node.id = "moodbox-context-download-toast";

        if (icon) {
          const img = document.createElement("img");
          img.src = icon;
          img.style.width = "18px";
          img.style.height = "18px";
          img.style.marginRight = "10px";
          img.style.verticalAlign = "middle";
          img.style.display = "inline-block";
          img.style.objectFit = "contain";
          node.appendChild(img);
        }

        const span = document.createElement("span");
        span.textContent = text;
        span.style.verticalAlign = "middle";
        node.appendChild(span);

        Object.assign(node.style, {
          position: "fixed",
          right: "24px",
          bottom: "24px",
          zIndex: "2147483647",
          maxWidth: "460px",
          padding: "10px 16px",
          borderRadius: "10px",
          background: error ? "#2A1416" : "#121A13",
          border: error ? "1px solid #732629" : "1px solid #273D26",
          color: error ? "#F5A3A8" : "#89E653",
          boxShadow: "0 12px 35px rgba(0,0,0,.6)",
          font: "600 12.5px/1.4 Inter,Segoe UI,Arial,sans-serif",
          pointerEvents: "none",
          display: "flex",
          alignItems: "center"
        });
        document.documentElement.appendChild(node);
        setTimeout(() => node.remove(), 2800);
      }
    });
  } catch (_) { }
}

async function startDownload(resource, tabId = 0, frameId = 0) {
  if (isOriginalMediaResource(resource)) return startOriginalDownload(resource, tabId, frameId);
  let primaryError = null;
  try {
    const namedResource = await resolveResourceName(resource, tabId);
    if (Number(resource?.collectionIndex) > 0) namedResource.suggestedName = `${namedResource.suggestedName || "Media"} - ${String(resource.collectionIndex).padStart(2, "0")}`;
    const best = await resolveBestImage(namedResource, tabId);
    const normalized = await normalizeDownloadBlob(best.blob);
    const normalizedBest = { ...best, blob: normalized.blob, mime: normalized.mime };
    const mime = normalized.mime;
    const desiredFilename = finalFilename(namedResource, mime, normalizedBest);
    // MoodBox downloads are always JPG/PNG. JPEG and PNG sources pass through
    // unchanged; other image containers are decoded and converted to PNG at
    // the source pixel dimensions.
    const downloadUrl = `data:${mime};base64,${await blobToBase64(normalized.blob)}`;
    const pending = queueForcedFilename(desiredFilename);
    let downloadId = null;
    try {
      downloadId = await chrome.downloads.download({ url: downloadUrl, filename: desiredFilename, saveAs: false, conflictAction: "uniquify" });
    } catch (error) {
      removeForcedFilename(pending);
      throw error;
    }
    if (!Number.isInteger(downloadId)) {
      removeForcedFilename(pending);
      throw new Error("The browser could not start the verified-image download.");
    }
    pending.downloadId = downloadId;
    setTimeout(() => removeForcedFilename(pending), PENDING_FILENAME_TTL_MS);
    return downloadId;
  } catch (error) {
    primaryError = error;
  }
  try {
    return await startDirectImageFallback(resource, tabId, frameId);
  } catch (fallbackError) {
    const first = String(primaryError?.message || "Verified image download failed.");
    const second = String(fallbackError?.message || "Direct download failed.");
    throw new Error(`${first} Direct fallback: ${second}`);
  }
}

async function startDownloadList(resources, tabId = 0, frameId = 0) {
  const rows = Array.isArray(resources) ? resources.slice(0, 60) : [];
  const outcomes = await mapWithConcurrency(rows, MEDIA_DOWNLOAD_CONCURRENCY, async (resource, index) => {
    try {
      await startDownload(resource || {}, tabId, frameId);
      return { ok: true, index };
    } catch (error) {
      return {
        ok: false,
        index,
        name: String(resource?.collectionName || resource?.suggestedName || resource?.filename || `Carousel item ${index + 1}`),
        error: String(error?.message || "Download failed.")
      };
    }
  });
  const started = outcomes.filter(row => row?.ok).length;
  const failures = outcomes.filter(row => row && !row.ok).map(row => ({ index: row.index + 1, name: row.name, error: row.error }));
  const failed = failures.length;
  if (!started && rows.length) throw new Error(failures[0]?.error || "The carousel files could not be downloaded.");
  return { started, failed, failures };
}


function batchToken() {
  return `${Date.now().toString(36)}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function cleanBatchFilename(value, fallback = "image") {
  const raw = String(value || "").split(/[\\/]/).pop().replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-").replace(/[. ]+$/g, "").trim();
  return (raw || fallback).slice(0, 180);
}

function extensionFromBatchItem(item) {
  const supplied = String(item?.type || "").toLowerCase().replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  if (supplied && supplied !== "image" && supplied !== "asset") return supplied;
  try {
    return new URL(String(item?.url || "")).pathname.match(/\.([a-z0-9]{2,7})$/i)?.[1]?.toLowerCase().replace("jpeg", "jpg") || "asset";
  } catch (_) {
    return "asset";
  }
}

function batchFilename(item, index) {
  const ext = extensionFromBatchItem(item);
  let name = cleanBatchFilename(item?.filename, `image-${index + 1}.${ext}`);
  if (!/\.[a-z0-9]{2,7}$/i.test(name)) name += `.${ext}`;
  return name;
}


function isVideoBatchItem(item) {
  if (String(item?.kind || "").toLowerCase() === "video") return true;
  const type = String(item?.type || extensionFromBatchItem(item) || "").toLowerCase();
  return /^(?:mp4|webm|mov|m4v|ogv|avi|mkv)$/.test(type);
}

async function captureSourceViewport(tabId) {
  try {
    const tab = await chrome.tabs.get(Number(tabId || 0));
    if (!tab?.active || !Number.isInteger(Number(tab.windowId))) return "";
    return await chrome.tabs.captureVisibleTab(Number(tab.windowId), { format: "jpeg", quality: 82 });
  } catch (_) {
    return "";
  }
}

async function enrichVideoPreviewsFromViewport(payload, screenshotDataUrl) {
  if (!screenshotDataUrl || !Array.isArray(payload?.items)) return payload;
  const screenshotBlob = dataUrlToBlob(screenshotDataUrl);
  if (!screenshotBlob) return payload;

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(screenshotBlob);
  } catch (_) {
    return payload;
  }

  const cache = new Map();
  try {
    for (const item of payload.items) {
      if (!isVideoBatchItem(item) || Number(item.frameId || 0) !== 0) continue;
      const rect = item.previewRect;
      const viewportWidth = Number(item.viewportWidth || 0);
      const viewportHeight = Number(item.viewportHeight || 0);
      if (!rect || !viewportWidth || !viewportHeight) continue;

      const left = Number(rect.left || 0), top = Number(rect.top || 0);
      const width = Number(rect.width || 0), height = Number(rect.height || 0);
      if (width < 24 || height < 24) continue;
      if (left >= viewportWidth || top >= viewportHeight || left + width <= 0 || top + height <= 0) continue;

      const cacheKey = [left, top, width, height, viewportWidth, viewportHeight].map(value => Math.round(value)).join(":");
      let preview = cache.get(cacheKey) || "";
      if (!preview) {
        const scaleX = bitmap.width / viewportWidth;
        const scaleY = bitmap.height / viewportHeight;
        const sourceX = Math.max(0, Math.floor(left * scaleX));
        const sourceY = Math.max(0, Math.floor(top * scaleY));
        const sourceWidth = Math.max(1, Math.min(bitmap.width - sourceX, Math.ceil(width * scaleX)));
        const sourceHeight = Math.max(1, Math.min(bitmap.height - sourceY, Math.ceil(height * scaleY)));
        if (sourceWidth < 8 || sourceHeight < 8) continue;

        const maxWidth = 420;
        const outputScale = Math.min(1, maxWidth / sourceWidth);
        const outputWidth = Math.max(1, Math.round(sourceWidth * outputScale));
        const outputHeight = Math.max(1, Math.round(sourceHeight * outputScale));
        const canvas = new OffscreenCanvas(outputWidth, outputHeight);
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) continue;
        context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: .78 });
        if (!blob?.size) continue;
        preview = `data:image/jpeg;base64,${await blobToBase64(blob)}`;
        cache.set(cacheKey, preview);
      }

      item.previewUrl = preview;
      if (!Number(item.width || 0) || !Number(item.height || 0)) {
        item.width = Math.round(width);
        item.height = Math.round(height);
      }
    }
  } finally {
    bitmap.close?.();
  }
  return payload;
}


function cssUnquote(value) {
  return String(value || "").trim().replace(/^["']|["']$/g, "").replace(/\\([()'" ])/g, "$1");
}

function cssAssetUrl(value, baseUrl) {
  const raw = cssUnquote(value);
  if (!raw || /^local\(/i.test(raw)) return "";
  if (/^data:(?:font|application)\//i.test(raw)) return raw;
  try {
    const url = new URL(raw, baseUrl);
    return /^https?:$/i.test(url.protocol) ? url.href : "";
  } catch (_) { return ""; }
}

function fontTypeFromUrl(url, format = "") {
  const direct = String(url || "").match(/\.(woff2?|ttf|otf|eot)(?:$|[?#])/i)?.[1];
  if (direct) return direct.toLowerCase();
  const hint = String(format || "").toLowerCase();
  if (hint.includes("woff2")) return "woff2";
  if (hint.includes("woff")) return "woff";
  if (hint.includes("truetype") || hint === "ttf") return "ttf";
  if (hint.includes("opentype") || hint === "otf") return "otf";
  if (hint.includes("embedded-opentype") || hint === "eot") return "eot";
  const dataMime = String(url || "").match(/^data:([^;,]+)/i)?.[1]?.toLowerCase() || "";
  return ({ "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf", "application/vnd.ms-fontobject": "eot" })[dataMime] || "font";
}

async function fetchStylesheetText(url) {
  for (const credentials of ["include", "omit"]) {
    try {
      const response = await fetch(url, { cache: "default", credentials, redirect: "follow" });
      if (!response.ok) continue;
      const type = String(response.headers.get("content-type") || "").toLowerCase();
      if (type && !/(?:text\/css|text\/plain|application\/css|octet-stream)/i.test(type)) continue;
      const text = await response.text();
      if (text && text.length <= 5_000_000) return { text, url: response.url || url };
    } catch (_) { }
  }
  return null;
}

function parseFontFaceAssets(css, stylesheetUrl, pageUrl, pageTitle) {
  const items = [];
  for (const match of String(css || "").matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)) {
    const body = match[1];
    const family = String(body.match(/font-family\s*:\s*([^;]+)/i)?.[1] || "Web font").replace(/["']/g, "").trim();
    const style = String(body.match(/font-style\s*:\s*([^;]+)/i)?.[1] || "normal").trim();
    const weight = String(body.match(/font-weight\s*:\s*([^;]+)/i)?.[1] || "400").trim();
    const src = String(body.match(/src\s*:\s*((?:(?:url|local|format)\([^)]*\)|[^;])+)/i)?.[1] || "");
    let sourceIndex = 0;
    for (const row of src.matchAll(/url\(\s*([^)]+?)\s*\)\s*(?:format\(\s*([^)]+?)\s*\))?/gi)) {
      const url = cssAssetUrl(row[1], stylesheetUrl);
      if (!url) continue;
      const type = fontTypeFromUrl(url, cssUnquote(row[2] || ""));
      const remoteName = filenameWithExtensionFromUrl(url);
      const filename = cleanCompleteFilename(remoteName, `${sanitizeBase(family, "web-font")}-${sanitizeBase(style, "normal")}-${sanitizeBase(weight, "400")}.${type === "font" ? "woff2" : type}`);
      items.push({
        id: url, url, previewUrl: "", filename, type, kind: "font", width: 0, height: 0, bytes: 0,
        source: "remote-font-face", pageUrl, pageTitle, frameUrl: stylesheetUrl, alt: "",
        familyKey: `font:${family.toLowerCase()}:${style.toLowerCase()}:${weight.toLowerCase()}`,
        fontFamily: family, fontStyle: style, fontWeight: weight, order: sourceIndex++
      });
    }
  }
  return items;
}

async function collectRemoteFontAssets(stylesheetUrls, pageUrl, pageTitle) {
  const pending = [...new Set((stylesheetUrls || []).map(value => {
    try { return new URL(String(value || ""), pageUrl || undefined).href; } catch (_) { return ""; }
  }).filter(value => /^https?:/i.test(value)))].map(url => ({ url, depth: 0 }));
  const seen = new Set();
  const assets = new Map();
  let order = 0;

  while (pending.length && seen.size < 240) {
    const batch = [];
    while (pending.length && batch.length < 24 && seen.size + batch.length < 240) {
      const row = pending.shift();
      if (!row?.url || seen.has(row.url)) continue;
      seen.add(row.url);
      batch.push(row);
    }
    if (!batch.length) continue;
    const loaded = await mapWithConcurrency(batch, FONT_STYLESHEET_CONCURRENCY, async row => ({ row, result: await fetchStylesheetText(row.url) }));
    for (const entry of loaded) {
      const row = entry?.row, result = entry?.result;
      if (!row || !result?.text) continue;
      const base = result.url || row.url;
      for (const item of parseFontFaceAssets(result.text, base, pageUrl, pageTitle)) {
        if (!assets.has(item.url)) assets.set(item.url, { ...item, order: order++ });
      }
      if (row.depth >= 3) continue;
      for (const imported of result.text.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;/gi)) {
        const url = cssAssetUrl(imported[1], base);
        if (url && !seen.has(url)) pending.push({ url, depth: row.depth + 1 });
      }
    }
  }
  return [...assets.values()].slice(0, 4000);
}

async function collectBatchFromTab(tabId, { scanMode = "quick" } = {}) {
  if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("Open a normal website tab first.");

  const scanFrames = async () => {
    let frames = [{ frameId: 0, parentFrameId: -1, url: "" }];
    try {
      const found = await chrome.webNavigation.getAllFrames({ tabId });
      if (Array.isArray(found) && found.length) frames = found.sort((a, b) => Number(a.frameId) - Number(b.frameId));
    } catch (_) { }
    const rows = await Promise.all(frames.map(async frame => {
      try {
        const response = await chrome.tabs.sendMessage(
          tabId,
          { action: "moodboxDownload-collect-batch", scanMode },
          { frameId: Number(frame.frameId || 0) }
        );
        return response?.ok ? { frameId: Number(frame.frameId || 0), response } : null;
      } catch (_) {
        return null;
      }
    }));
    return rows.filter(Boolean);
  };

  let responses = await scanFrames();
  if (!responses.length) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] }).catch(() => { });
    responses = await scanFrames();
  }
  if (!responses.length) throw new Error("Could not scan this page. Reload the page after updating the extension.");

  const top = responses.find(row => row.frameId === 0)?.response || responses[0].response;
  const merged = new Map();
  let sequence = 0;
  for (const { frameId, response } of responses) {
    for (const raw of Array.isArray(response.items) ? response.items : []) {
      const item = { ...raw, frameId, order: sequence++ };
      const key = String(item.url || item.id || "");
      if (!key) continue;
      const existing = merged.get(key);
      if (!existing) merged.set(key, item);
      else {
        const itemArea = Number(item.width || 0) * Number(item.height || 0);
        const existingArea = Number(existing.width || 0) * Number(existing.height || 0);
        const existingPreview = String(existing.previewUrl || "");
        const itemPreview = String(item.previewUrl || "");
        const bestPreview = existingPreview && existingPreview !== existing.url
          ? existingPreview
          : itemPreview && itemPreview !== item.url ? itemPreview : existingPreview || itemPreview;
        const betterPosition = Number.isFinite(Number(item.pageTop)) && (
          !Number.isFinite(Number(existing.pageTop)) || Number(item.pageTop) < Number(existing.pageTop) ||
          (Number(item.pageTop) === Number(existing.pageTop) && Number(item.pageLeft || 0) < Number(existing.pageLeft || 0))
        );
        const combined = {
          ...existing,
          previewUrl: bestPreview,
          familyKey: existing.familyKey || item.familyKey,
          alt: existing.alt || item.alt,
          bytes: Math.max(Number(existing.bytes || 0), Number(item.bytes || 0)),
          pageTop: betterPosition ? item.pageTop : existing.pageTop,
          pageLeft: betterPosition ? item.pageLeft : existing.pageLeft,
          previewRect: existing.previewRect || item.previewRect || null,
          viewportWidth: Number(existing.viewportWidth || item.viewportWidth || 0),
          viewportHeight: Number(existing.viewportHeight || item.viewportHeight || 0)
        };
        if (itemArea > existingArea) {
          combined.width = item.width; combined.height = item.height;
        }
        merged.set(key, combined);
      }
    }
  }
  if (scanMode === "fonts") {
    const stylesheets = [...new Set(responses.flatMap(row => Array.isArray(row.response?.stylesheets) ? row.response.stylesheets : []))];
    const remoteFonts = await collectRemoteFontAssets(stylesheets, String(top.pageUrl || ""), String(top.pageTitle || ""));
    for (const raw of remoteFonts) {
      const key = String(raw.url || raw.id || "");
      if (!key || merged.has(key)) continue;
      merged.set(key, { ...raw, frameId: 0, order: sequence++ });
    }
  }

  const videoTypes = new Set(["mp4", "webm", "mov", "m4v", "ogv", "avi", "mkv"]);
  const items = [...merged.values()]
    .filter(item => {
      const kind = String(item.kind || "").toLowerCase();
      const type = String(item.type || "").toLowerCase();
      if (kind === "video" || videoTypes.has(type)) return false;
      return scanMode !== "fonts" || kind === "font";
    })
    .sort((a, b) => Number(a.order) - Number(b.order));
  return {
    tabId,
    pageUrl: String(top.pageUrl || ""),
    pageTitle: String(top.pageTitle || ""),
    createdAt: Date.now(),
    frameCount: responses.length,
    scanMode,
    assetMode: scanMode === "fonts" ? "fonts" : "all",
    items
  };
}


async function storeBatchPayload(token, payload) {
  const key = `moodboxDownloadBatch:${token}`;
  try {
    await chrome.storage.session.set({ [key]: payload });
  } catch (_) {
    await chrome.storage.local.set({ [key]: payload });
  }
}

async function createAssetSession(tabId, { screenshotDataUrl = "", scanMode = "quick" } = {}) {
  const mode = scanMode === "fonts" ? "fonts" : (scanMode === "deep" ? "deep" : "quick");
  const payload = await collectBatchFromTab(tabId, { scanMode: mode });
  // Video assets are intentionally excluded. The board now handles still
  // images, vectors, fonts and other non-video web assets only.
  const token = batchToken();
  await storeBatchPayload(token, payload);
  return { token, payload };
}

async function openBatchDownload(tabId, { scanMode = "quick" } = {}) {
  const mode = scanMode === "fonts" ? "fonts" : (scanMode === "deep" ? "deep" : "quick");
  const screenshotDataUrl = mode === "fonts" ? "" : await captureSourceViewport(tabId);
  const loadingUrl = chrome.runtime.getURL(`batch.html?loading=1${mode === "fonts" ? "&mode=fonts" : ""}`);
  const loadingTab = await chrome.tabs.create({ url: loadingUrl });
  try {
    const result = await createAssetSession(tabId, { screenshotDataUrl, scanMode: mode });
    await chrome.tabs.update(loadingTab.id, { url: chrome.runtime.getURL(`batch.html?token=${encodeURIComponent(result.token)}`) });
    return result;
  } catch (error) {
    const message = error?.message || (mode === "fonts" ? "Could not fetch page fonts." : "Could not scan this page.");
    await chrome.tabs.update(loadingTab.id, { url: chrome.runtime.getURL(`batch.html?error=${encodeURIComponent(message)}`) }).catch(() => { });
    throw error;
  }
}

async function resolveBatchDownloadUrl(item, tabId) {
  const url = String(item?.url || "");
  if (!url) throw new Error("Asset URL is missing.");
  if (!url.startsWith("blob:")) return url;
  const options = Number.isInteger(Number(item?.frameId)) ? { frameId: Number(item.frameId) } : undefined;
  const response = await chrome.tabs.sendMessage(tabId, { action: "moodboxDownload-resolve-batch-resource", url }, options);
  if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "Could not read this page asset.");
  return response.dataUrl;
}

async function downloadBatch(items, tabId) {
  const rows = Array.isArray(items) ? items.slice(0, 2000) : [];
  let started = 0;
  let failed = 0;
  const seen = new Set();
  const work = async (item, index) => {
    try {
      const url = await resolveBatchDownloadUrl(item, Number(tabId || 0));
      const key = String(url || "").trim();
      if (key && seen.has(key)) return { duplicate: true, started: 0, failed: 0 };
      if (key) seen.add(key);
      const id = await chrome.downloads.download({
        url,
        filename: batchFilename(item, index),
        saveAs: false,
        conflictAction: "uniquify"
      });
      if (!Number.isInteger(id)) throw new Error("Download did not start.");
      return { duplicate: false, started: 1, failed: 0 };
    } catch (_) {
      return { duplicate: false, started: 0, failed: 1 };
    }
  };
  const CONCURRENCY = 5;
  let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) break;
      const result = await work(rows[index], index);
      started += result.started;
      failed += result.failed;
    }
  }));
  return { started, failed };
}



async function showMoodboxAddedToast(tabId, projectName) {
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      func: name => {
        document.getElementById("moodbox-added-toast")?.remove();
        const toast = document.createElement("div");
        toast.id = "moodbox-added-toast";
        toast.textContent = `✓ Added to MoodBox${name && name !== "MoodBox" ? ` · ${name}` : ""}`;
        Object.assign(toast.style, { position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483647", padding: "9px 14px", borderRadius: "9px", background: "#111713", border: "1px solid #71d13c", color: "#EEF6EE", boxShadow: "0 10px 28px rgba(0,0,0,.42)", font: "600 12px/1.35 Inter,Segoe UI,Arial,sans-serif", pointerEvents: "none" });
        document.documentElement.appendChild(toast);
        setTimeout(() => toast.remove(), 2400);
      },
      args: [String(projectName || "MoodBox")]
    });
  } catch (_) { }
}


async function injectContentIntoTab(tabId) {
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId: Number(tabId), allFrames: true }, files: ["content.js"] });
    return true;
  } catch (_) {
    return false;
  }
}

async function injectContentIntoOpenTabs() {
  if (!chrome.tabs?.query || !chrome.scripting?.executeScript) return;
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.allSettled((tabs || []).filter(tab => /^https?:/i.test(String(tab.url || ""))).map(tab => injectContentIntoTab(tab.id)));
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const now = Date.now();
  while (pendingFilenameRequests.length && now - pendingFilenameRequests[0].createdAt > PENDING_FILENAME_TTL_MS) {
    pendingFilenameRequests.shift();
  }
  const owned = !item.byExtensionId || item.byExtensionId === chrome.runtime.id;
  // Every MoodBox download reserves its exact filename immediately before the
  // browser download starts with the browser default download location.
  // This applies to remote URLs, blob URLs, and PNG/JPG conversions.
  if (!owned || !pendingFilenameRequests.length) return;
  const index = pendingFilenameRequests.findIndex(row => Number.isInteger(row.downloadId) && row.downloadId === item.id);
  // Never consume another download's reservation. With parallel jobs, the old
  // "first pending" fallback could swap filenames between unrelated assets.
  // The filename passed directly to chrome.downloads.download remains active
  // when the download id has not been attached to the reservation yet.
  if (index < 0) return;
  const pending = pendingFilenameRequests.splice(index, 1)[0];
  if (!pending?.filename) return;
  suggest({ filename: pending.filename, conflictAction: "uniquify" });
});

chrome.runtime.onInstalled.addListener(() => {
  buildMenus().catch(() => { });
  injectContentIntoOpenTabs().catch(() => { });
});
chrome.runtime.onStartup.addListener(() => {
  buildMenus().catch(() => { });
});

chrome.action.onClicked.addListener(async tab => {
  let tabId = Number(tab?.id || 0);
  if (!tabId) {
    const rows = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    tabId = Number(rows?.[0]?.id || 0);
  }
  try {
    await openBatchDownload(tabId);
  } catch (error) {
    console.error("MoodBox Asset Board failed", error);
  }
});

async function updatePageContextMenus(info, tab) {
  await ensurePageContextMenusReady();

  const tabId = Number(tab?.id || 0);
  const frameId = Number(info?.frameId || 0);
  const hasSelection = Boolean(String(info?.selectionText || "").trim());
  const hasSrcUrl = Boolean(String(info?.srcUrl || "").trim());

  // 1. Direct selectionText -> definitively selected text!
  if (hasSelection) {
    let fontName = "";
    const cached = getContextTarget(tabId, frameId);
    if (cached?.contextKind === "font" && cached.fontTarget?.fontFamily) {
      fontName = String(cached.fontTarget.fontFamily).replace(/[<>:"/\\|?*]+/g, "").trim();
    }
    if (tabId > 0) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { action: "moodbox-get-selected-font" }, { frameId }).catch(() => null);
        if (res?.ok && res.fontTarget?.fontFamily) {
          fontName = String(res.fontTarget.fontFamily).replace(/[<>:"/\\|?*]+/g, "").trim();
          rememberContextTarget(tabId, frameId, {
            contextKind: "font",
            fontTarget: res.fontTarget,
            pageUrl: String(tab?.url || ""),
            pageTitle: String(tab?.title || "")
          });
        }
      } catch (_) { }
    }
    await setContextMenuState({ isFont: true, fontName });
    return;
  }

  // 2. Direct srcUrl -> definitively an image!
  if (hasSrcUrl) {
    await setContextMenuState({ hasImage: true });
    return;
  }

  // 3. Probe tab to check if media or font is under pointer
  if (tabId > 0) {
    try {
      const probe = await chrome.tabs.sendMessage(tabId, {
        action: "moodbox-get-context-target",
        srcUrl: String(info?.srcUrl || "").trim()
      }, { frameId }).catch(() => null);

      if (probe?.contextKind === "font" && probe?.fontTarget) {
        const fn = String(probe.fontTarget.fontFamily || "").replace(/[<>:"/\\|?*]+/g, "").trim();
        rememberContextTarget(tabId, frameId, {
          contextKind: "font",
          fontTarget: probe.fontTarget,
          point: probe.point || null,
          pageUrl: String(probe.pageUrl || tab?.url || ""),
          pageTitle: String(probe.pageTitle || tab?.title || "")
        });
        await setContextMenuState({ isFont: true, fontName: fn });
        return;
      } else if (probe?.resource?.url) {
        rememberContextTarget(tabId, frameId, {
          contextKind: String(probe.contextKind || "image"),
          resource: probe.resource,
          point: probe.point || null,
          srcUrl: String(info?.srcUrl || probe.resource.url || ""),
          pageUrl: String(probe.pageUrl || tab?.url || ""),
          pageTitle: String(probe.pageTitle || tab?.title || "")
        });
        await setContextMenuState({ hasImage: true });
        return;
      }
    } catch (_) { }
  }

  // 4. Check cached target
  const cached = getContextTarget(tabId, frameId);
  if (cached?.contextKind === "font" && cached.fontTarget) {
    const fn = String(cached.fontTarget.fontFamily || "").replace(/[<>:"/\\|?*]+/g, "").trim();
    await setContextMenuState({ isFont: true, fontName: fn });
    return;
  } else if ((cached?.contextKind === "image" || cached?.contextKind === "video") && cached?.resource?.url) {
    await setContextMenuState({ hasImage: true });
    return;
  }

  // 5. Neither image nor selected text -> HIDE the menu completely!
  await setContextMenuState({});
}

if (chrome.contextMenus?.onShown?.addListener) chrome.contextMenus.onShown.addListener((info, tab) => {
  refreshPageMenuFromCachedTarget(Number(tab?.id || 0), Number(info?.frameId || 0)).catch(() => { });
  updatePageContextMenus(info, tab).catch(() => { });
});

if (chrome.contextMenus?.onClicked?.addListener) chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "moodbox-download-library") {
    chrome.runtime.openOptionsPage().catch(() => { });
    return;
  }
  if (info.menuItemId === "moodbox-context-send" || String(info.menuItemId || "").startsWith("moodbox-context-send-project:")) {
    const tabId = Number(tab?.id || 0);
    const preferredProjectId = String(info.menuItemId || "").startsWith("moodbox-context-send-project:")
      ? String(info.menuItemId).slice("moodbox-context-send-project:".length)
      : "";
    prepareMoodboxNoteCapture(info, tab, preferredProjectId)
      .catch(error => {
        showContextDownloadToast(tabId, String(error?.message || "Could not open note dialog."), true, "logo.png");
      });
    return;
  }
  if (info.menuItemId === "moodbox-context-download" || info.menuItemId === "moodbox-context-download-direct") {
    const tabId = Number(tab?.id || 0);
    const frameId = Number(info?.frameId || 0);
    const cached = getContextTarget(tabId, frameId);
    const hasSelection = Boolean(String(info?.selectionText || "").trim());
    const hasSrcUrl = Boolean(String(info?.srcUrl || "").trim());

    // 1. If user right-clicked on selected text (Chrome info.selectionText) or target is font (without direct image srcUrl)
    const isFont = (hasSelection || cached?.contextKind === "font") && !hasSrcUrl;
    if (isFont) {
      startContextFontDownload(info, tab)
        .then(result => {
          if (result?.filename) {
            showContextDownloadToast(tabId, `✓ Downloaded font · ${result.filename}`, false, "fontdownload.png");
          }
        })
        .catch(error => {
          showContextDownloadToast(tabId, String(error?.message || "Could not download this font."), true, "fontdownload.png");
        });
      return;
    }

    // 2. Direct or probed image download
    startContextImageDownload(info, tab)
      .then(result => {
        const dimensions = result.width && result.height ? ` · ${result.width}×${result.height}` : "";
        showContextDownloadToast(tabId, `✓ Downloaded · ${result.filename}${dimensions}`, false, "download.png");
      })
      .catch(error => {
        showContextDownloadToast(tabId, String(error?.message || "Could not download this image."), true, "download.png");
      });
    return;
  }
});


async function extractSocialVideoFromMainWorld(tabId, frameId = 0, request = {}) {
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0) return { items: [], title: "" };
  const target = { tabId: Number(tabId), frameIds: [Number.isInteger(Number(frameId)) ? Number(frameId) : 0] };
  const args = [{
    platform: String(request?.platform || "").toLowerCase(),
    collectAll: Boolean(request?.collectAll),
    point: { x: Number(request?.point?.x || 0), y: Number(request?.point?.y || 0) },
    pageUrl: String(request?.pageUrl || ""),
    suggestedName: String(request?.suggestedName || ""),
    previewUrl: String(request?.previewUrl || "")
  }];
  const results = await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    args,
    func: request => {
      const platform = String(request?.platform || "").toLowerCase();
      const collectAll = Boolean(request?.collectAll);
      const maxItems = collectAll ? 80 : 18;
      const cleanText = (value, limit = 220) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
      const cleanUrl = value => {
        let raw = String(value || "").trim().replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=").replace(/\\u002f/gi, "/").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
        if (!raw) return "";
        try { raw = decodeURIComponent(raw); } catch (_) { }
        try { const url = new URL(raw, location.href); return /^https?:$/i.test(url.protocol) ? url.href : ""; } catch (_) { return ""; }
      };
      const isManifest = value => /(?:\.m3u8|\.mpd)(?:$|[?#])|(?:manifest|dash|hls)(?:\.json)?(?:$|[?#])/i.test(String(value || ""));
      const isImageLike = value => /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:$|[?#])/i.test(String(value || ""));
      const isDirectVideo = (value, key = "", path = "") => {
        const url = cleanUrl(value);
        if (!url || isManifest(url)) return false;
        if (/\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/i.test(url)) return true;
        let parsed = null;
        try { parsed = new URL(url); } catch (_) { return false; }
        const host = parsed.hostname.toLowerCase();
        const pathname = parsed.pathname.toLowerCase();
        const query = parsed.search.toLowerCase();
        if (platform === "pinterest" && /(?:^|\.)pinimg\.com$/.test(host) && /\/videos?\//.test(pathname)) return true;
        if (platform === "instagram" && /(?:cdninstagram|fbcdn|instagram)\./.test(host) && (/(?:mime|type)=video(?:%2f|\/)/.test(query) || /(?:bytestart|byteend|video_dashinit|oe=|oh=)/.test(query))) return !isImageLike(url);
        if (platform === "facebook" && /(?:fbcdn\.net|fbsbx\.com|facebook\.com)$/.test(host) && (/(?:mime|type)=video(?:%2f|\/)/.test(query) || /(?:bytestart|byteend|video|oe=|oh=)/.test(`${pathname}${query}`))) return !isImageLike(url);
        const semantic = `${key} ${path}`.toLowerCase();
        if (/video|playback|contenturl|downloadurl|video_url|video_versions|video_list/.test(semantic) && !/poster|thumbnail|preview|image_versions|display_url/.test(semantic)) {
          if (/pinimg\.com|cdninstagram\.com|fbcdn\.net|instagram\.com/.test(host) && !isImageLike(url)) return true;
        }
        return false;
      };
      const previewUrl = value => {
        const url = cleanUrl(value);
        return url && isImageLike(url) ? url : "";
      };
      const candidates = new Map();
      const previewByOwner = new Map();
      const addPreview = (owner, value) => { const url = previewUrl(value); if (url && !previewByOwner.has(owner)) previewByOwner.set(owner, url); };
      const add = (value, meta = {}) => {
        const url = cleanUrl(value);
        if (!url || !isDirectVideo(url, meta.key || "", meta.path || "")) return;
        const ownerKey = cleanText(meta.ownerKey || meta.owner || "video", 120) || "video";
        const width = Math.max(0, Number(meta.width || 0)), height = Math.max(0, Number(meta.height || 0));
        const bitrate = Math.max(0, Number(meta.bitrate || meta.bandwidth || 0));
        const source = String(meta.source || "page-data");
        let score = Number(meta.score || 0) + width * height + Math.min(bitrate, 50_000_000) / 20;
        if (/current-src|video-current/i.test(source)) score += 12_000_000;
        else if (/react|page-data|video-list|video-versions/i.test(source)) score += 8_000_000;
        else if (/dom|source/i.test(source)) score += 5_000_000;
        else if (/performance|network/i.test(source)) score += 1_000_000;
        if (/\.mp4(?:$|[?#])/i.test(url)) score += 2_000_000;
        const old = candidates.get(url);
        const row = { url, width, height, bitrate, source, ownerKey, score, previewUrl: previewByOwner.get(ownerKey) || cleanUrl(meta.previewUrl || "") };
        if (!old || row.score > old.score) candidates.set(url, row);
      };
      const rootFor = node => {
        if (!(node instanceof Element)) return document.body;
        if (platform === "instagram") return node.closest("article,[role='dialog']") || document.body;
        if (platform === "facebook") return node.closest("[role='article'],div[data-pagelet*='FeedUnit'],article,[role='dialog']") || document.body;
        if (platform === "pinterest") return node.closest("[data-test-id='pin'],[data-test-id='pinWrapper'],[data-test-id='closeup-body'],[data-test-id*='pin'],article,[role='dialog']") || document.body;
        return node.closest("article,[role='dialog']") || document.body;
      };
      let hit = null;
      try { hit = document.elementsFromPoint(Number(request?.point?.x || 0), Number(request?.point?.y || 0)).find(node => node instanceof Element); } catch (_) { }
      const primaryRoot = collectAll ? document.body : rootFor(hit || document.elementFromPoint?.(Number(request?.point?.x || 0), Number(request?.point?.y || 0)) || document.body);
      const roots = [];
      const addRoot = node => { if (node instanceof Element && !roots.includes(node)) roots.push(node); };
      addRoot(primaryRoot);
      if (collectAll) {
        for (const video of [...document.querySelectorAll("video")].slice(0, 120)) addRoot(rootFor(video));
        const cardSelector = platform === "pinterest" ? "[data-test-id='pin'],[data-test-id='pinWrapper'],[data-test-id*='pin']" : platform === "facebook" ? "[role='article'],div[data-pagelet*='FeedUnit'],article,[role='dialog']" : "article,[role='dialog']";
        for (const card of [...document.querySelectorAll(cardSelector)].slice(0, 180)) {
          if (card.querySelector("video,[data-test-id*='video'],[aria-label*='Play' i]")) addRoot(card);
        }
      }
      let ownerSeq = 0;
      for (const root of roots) {
        const link = root.querySelector?.("a[href*='/reel/'],a[href*='/p/'],a[href*='/pin/'],a[href]")?.href || location.href;
        const ownerKey = cleanText(root.getAttribute?.("data-test-id") || root.getAttribute?.("data-id") || link || `video-${++ownerSeq}`, 120);
        const nearbyImage = root.querySelector?.("img");
        addPreview(ownerKey, nearbyImage?.currentSrc || nearbyImage?.src || nearbyImage?.getAttribute?.("data-src"));
        for (const video of [...root.querySelectorAll?.("video") || []]) {
          const rect = video.getBoundingClientRect?.();
          addPreview(ownerKey, video.poster || video.getAttribute?.("poster"));
          add(video.currentSrc, { ownerKey, width: video.videoWidth || rect?.width, height: video.videoHeight || rect?.height, source: "video-current-src", key: "currentSrc", previewUrl: video.poster });
          add(video.src, { ownerKey, width: video.videoWidth || rect?.width, height: video.videoHeight || rect?.height, source: "video-src", key: "src", previewUrl: video.poster });
          for (const source of video.querySelectorAll?.("source[src]") || []) add(source.src || source.getAttribute("src"), { ownerKey, width: video.videoWidth, height: video.videoHeight, source: "video-source", key: "source", previewUrl: video.poster });
          for (const name of ["data-src", "data-video-src", "data-video-url", "data-mp4", "data-playback-url", "data-media-url", "data-download-url"]) add(video.getAttribute?.(name), { ownerKey, width: video.videoWidth, height: video.videoHeight, source: `dom-${name}`, key: name, previewUrl: video.poster });
        }
      }
      try {
        for (const entry of performance.getEntriesByType("resource")) {
          const name = String(entry?.name || "");
          if (!isDirectVideo(name, "performance", "performance")) continue;
          add(name, { ownerKey: "network-video", source: "performance-resource", score: Number(entry?.transferSize || entry?.encodedBodySize || 0) });
        }
      } catch (_) { }
      const queue = [];
      const push = (value, path = "", ownerKey = "") => { if (value && typeof value === "object" && !(value instanceof Node) && !(value instanceof Window)) queue.push({ value, path, ownerKey }); };
      for (const root of roots) {
        const ownerKey = cleanText(root.querySelector?.("a[href]")?.href || root.getAttribute?.("data-test-id") || `root-${roots.indexOf(root)}`, 120);
        const nodes = [root, ...root.querySelectorAll?.("*") || []].slice(0, collectAll ? 1800 : 4200);
        for (const node of nodes) {
          for (const key of Object.getOwnPropertyNames(node)) {
            if (!key.startsWith("__reactProps$") && !key.startsWith("__reactContainer$") && !key.startsWith("__reactFiber$")) continue;
            try {
              const value = node[key];
              if (key.startsWith("__reactFiber$")) {
                push(value?.memoizedProps, `react.${key}.memoizedProps`, ownerKey);
                push(value?.pendingProps, `react.${key}.pendingProps`, ownerKey);
                push(value?.alternate?.memoizedProps, `react.${key}.alternate`, ownerKey);
              } else push(value, `react.${key}`, ownerKey);
            } catch (_) { }
          }
        }
      }
      for (const key of ["_sharedData", "__initialData", "__additionalData", "__NEXT_DATA__", "__PWS_DATA__", "__PRELOADED_STATE__"]) {
        try { push(window[key], `window.${key}`, "page-data"); } catch (_) { }
      }
      for (const script of [...document.scripts].slice(0, 80)) {
        const text = String(script.textContent || "");
        if (!text || text.length > 12 * 1024 * 1024 || !/(?:video_url|video_versions|video_list|contentUrl|playbackUrl|pinimg\.com\/videos)/i.test(text)) continue;
        try { push(JSON.parse(text), "script-json", "script-data"); } catch (_) { }
      }
      const visited = new WeakSet();
      let inspected = 0;
      while (queue.length && inspected < (collectAll ? 100000 : 75000)) {
        const { value, path, ownerKey } = queue.shift();
        if (!value || typeof value !== "object" || visited.has(value)) continue;
        visited.add(value); inspected += 1;
        const localOwner = cleanText(value?.id || value?.pk || value?.pin_id || value?.pinId || value?.shortcode || value?.code || ownerKey || "page-data", 120);
        const width = Number(value?.width || value?.original_width || value?.dimensions?.width || value?.video_width || 0);
        const height = Number(value?.height || value?.original_height || value?.dimensions?.height || value?.video_height || 0);
        const bitrate = Number(value?.bitrate || value?.bandwidth || value?.bit_rate || 0);
        for (const [key, row] of Object.entries(value)) {
          const nextPath = `${path}.${key}`;
          if (typeof row === "string") {
            if (/poster|thumbnail|preview|image|display_url/i.test(key)) addPreview(localOwner, row);
            add(row, { ownerKey: localOwner, width, height, bitrate, source: /react/i.test(path) ? "react-data" : "page-data", key, path: nextPath, previewUrl: previewByOwner.get(localOwner) });
          } else if (row && typeof row === "object") {
            if (/video_versions|videoVersions|video_list|videoList|videos|video/i.test(key)) {
              const values = Array.isArray(row) ? row : Object.values(row);
              for (const entry of values) {
                if (!entry || typeof entry !== "object") continue;
                add(entry.url || entry.src || entry.video_url || entry.videoUrl || entry.contentUrl || entry.playbackUrl || entry.downloadUrl, {
                  ownerKey: localOwner, width: entry.width || width, height: entry.height || height, bitrate: entry.bitrate || entry.bandwidth || bitrate, source: `${key}-data`, key, path: nextPath, previewUrl: previewByOwner.get(localOwner)
                });
              }
            }
            push(row, nextPath, localOwner);
          }
        }
      }
      const title = cleanText(
        primaryRoot?.querySelector?.("h1,h2,h3,[data-test-id*='title'],[class*='title'],[class*='Title']")?.textContent ||
        document.querySelector('meta[property="og:title"],meta[name="twitter:title"]')?.getAttribute("content") ||
        request?.suggestedName || document.title || `${platform} video`, 220
      );
      const fallbackPreview = cleanUrl(request?.previewUrl || "") || cleanUrl(primaryRoot?.querySelector?.("img")?.currentSrc || primaryRoot?.querySelector?.("img")?.src || "");
      const items = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, maxItems).map((row, index) => ({
        ...row,
        title,
        previewUrl: row.previewUrl || previewByOwner.get(row.ownerKey) || fallbackPreview,
        index: index + 1
      }));
      return { items, title, platform };
    }
  });
  return results?.[0]?.result || { items: [], title: "" };
}

async function resolveSocialVideoResource(message, sender) {
  const tabId = Number(sender?.tab?.id || message?.tabId || 0);
  const frameId = Number(sender?.frameId || message?.frameId || 0);
  const platform = String(message?.platform || "").toLowerCase();
  const extracted = await extractSocialVideoFromMainWorld(tabId, frameId, message || {});
  const items = Array.isArray(extracted?.items) ? extracted.items : [];
  if (!items.length) {
    const label = platform === "pinterest" ? "Pinterest" : platform === "facebook" ? "Facebook" : "Instagram";
    throw new Error(`${label} did not expose a direct MP4/WebM video source on this page.`);
  }
  const best = items[0];
  const candidates = items.map((row, index) => ({ url: String(row.url || ""), rank: Number(row.score || 0) - index, authoritative: true, source: String(row.source || `${platform}-video`) })).filter(row => row.url);
  const suggestedName = sanitizeBase(message?.suggestedName || extracted?.title || `${platform} video`, `${platform} video`);
  const originalFilename = filenameWithExtensionFromUrl(best.url) || `${platform}-video.mp4`;
  return {
    url: String(best.url || ""),
    candidates,
    previewUrl: String(best.previewUrl || message?.previewUrl || ""),
    mediaKind: "video",
    kind: "video",
    mimeHint: /\.webm(?:$|[?#])/i.test(String(best.url || "")) ? "video/webm" : "video/mp4",
    pageUrl: String(message?.pageUrl || sender?.tab?.url || ""),
    pageTitle: String(sender?.tab?.title || extracted?.title || ""),
    detailPageUrls: Array.isArray(message?.detailPageUrls) ? message.detailPageUrls : [String(message?.pageUrl || sender?.tab?.url || "")],
    suggestedName,
    originalFilename,
    width: Number(best.width || 0),
    height: Number(best.height || 0),
    viewportRect: message?.viewportRect || null,
    viewportWidth: Number(message?.viewportWidth || 0),
    viewportHeight: Number(message?.viewportHeight || 0),
    devicePixelRatio: Number(message?.devicePixelRatio || 1),
    socialPlatform: platform
  };
}

async function enrichSocialVideoAssets(payload, tabId) {
  const pageUrl = String(payload?.pageUrl || "");
  let platform = "";
  try {
    const host = new URL(pageUrl).hostname.replace(/^www\./, "").toLowerCase();
    if (host === "instagram.com" || host.endsWith(".instagram.com")) platform = "instagram";
    else if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com") || host === "fb.watch") platform = "facebook";
    else if (host === "pinterest.com" || host.endsWith(".pinterest.com") || host === "pin.it" || host.endsWith(".pin.it")) platform = "pinterest";
  } catch (_) { }
  if (!platform) return payload;
  let extracted = { items: [] };
  try { extracted = await extractSocialVideoFromMainWorld(Number(tabId || 0), 0, { platform, collectAll: true, pageUrl, suggestedName: payload?.pageTitle || `${platform} video` }); }
  catch (_) { return payload; }
  const existing = new Set((payload.items || []).map(item => String(item.url || "")));
  let order = (payload.items || []).length;
  for (const row of Array.isArray(extracted?.items) ? extracted.items : []) {
    const url = String(row?.url || "");
    if (!url || existing.has(url)) continue;
    existing.add(url);
    const ext = /\.webm(?:$|[?#])/i.test(url) ? "webm" : /\.mov(?:$|[?#])/i.test(url) ? "mov" : "mp4";
    const base = sanitizeBase(row?.title || payload?.pageTitle || `${platform} video`, `${platform} video`);
    payload.items.push({
      id: `social-video:${url}`,
      url,
      previewUrl: String(row?.previewUrl || ""),
      filename: `${base}.${ext}`,
      type: ext,
      kind: "video",
      width: Number(row?.width || 0),
      height: Number(row?.height || 0),
      bytes: 0,
      source: String(row?.source || `${platform}-video-data`),
      pageUrl,
      pageTitle: String(payload?.pageTitle || ""),
      frameUrl: pageUrl,
      alt: String(row?.title || ""),
      familyKey: `${platform}:${row?.ownerKey || base}`,
      frameId: 0,
      order: order++
    });
  }
  return payload;
}



async function extractCurrentSocialImageFromMainWorld(tabId, frameId = 0, request = {}) {
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0) return { items: [], title: "" };
  const target = { tabId: Number(tabId), frameIds: [Number.isInteger(Number(frameId)) ? Number(frameId) : 0] };
  const args = [{
    platform: String(request?.platform || "").toLowerCase(),
    point: { x: Number(request?.point?.x || 0), y: Number(request?.point?.y || 0) },
    currentUrl: String(request?.currentUrl || ""),
    postId: String(request?.postId || ""),
    suggestedName: String(request?.suggestedName || "")
  }];
  const results = await chrome.scripting.executeScript({
    target, world: "MAIN", args,
    func: request => {
      const platform = String(request?.platform || "").toLowerCase();
      const cleanText = (value, limit = 220) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
      const cleanUrl = value => {
        let raw = String(value || "").trim().replace(/\\u0026/gi, "&").replace(/\\u003d/gi, "=").replace(/\\u002f/gi, "/").replace(/\\\//g, "/").replace(/&amp;/gi, "&");
        if (!raw) return "";
        try { const url = new URL(raw, location.href); return /^https?:$/i.test(url.protocol) ? url.href : "" } catch (_) { return "" }
      };
      const imageLike = value => /\.(?:avif|bmp|gif|jpe?g|png|webp)(?:$|[?#])/i.test(String(value || "")) || /(?:fbcdn\.net|cdninstagram\.com|pinimg\.com)/i.test(String(value || ""));
      const identityParts = value => {
        const url = cleanUrl(value); if (!url) return { key: "", tokens: [], base: "" };
        try {
          const parsed = new URL(url); const base = decodeURIComponent(parsed.pathname.split("/").pop() || "").replace(/\.(?:avif|bmp|gif|jpe?g|png|webp)$/i, "").toLowerCase();
          const tokens = base.match(/\d{8,}/g) || [];
          return { key: tokens.length ? tokens.join("-") : base, tokens, base };
        } catch (_) { return { key: "", tokens: [], base: "" } }
      };
      const identity = value => identityParts(value).key;
      const currentUrl = cleanUrl(request?.currentUrl || "");
      const currentParts = identityParts(currentUrl);
      const currentIdentity = currentParts.key;
      const matchesCurrent = value => {
        if (!currentIdentity) return false;
        const parts = identityParts(value);
        if (parts.key && parts.key === currentIdentity) return true;
        if (!currentParts.tokens.length || !parts.tokens.length) return false;
        if (currentParts.tokens[0] === parts.tokens[0]) return true;
        const currentSet = new Set(currentParts.tokens); let overlap = 0;
        for (const token of parts.tokens) if (currentSet.has(token)) overlap += 1;
        return overlap >= Math.min(2, currentParts.tokens.length, parts.tokens.length);
      };
      const candidates = new Map();
      const add = (value, meta = {}) => {
        const url = cleanUrl(value); if (!url || !imageLike(url) || /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i.test(url)) return;
        const id = identity(url); const exact = Boolean(currentIdentity && matchesCurrent(url));
        if (currentIdentity && !exact && !meta.trustedCurrent) return;
        const width = Math.max(0, Number(meta.width || 0)), height = Math.max(0, Number(meta.height || 0));
        let score = width * height + Number(meta.score || 0);
        if (exact) score += 30_000_000;
        if (/react|page-data|original|full/i.test(String(meta.source || ""))) score += 12_000_000;
        if (/current-src|srcset|picture/i.test(String(meta.source || ""))) score += 7_000_000;
        const old = candidates.get(url); const row = { url, width, height, score, source: String(meta.source || "page") };
        if (!old || row.score > old.score) candidates.set(url, row);

        try {
          const parsed = new URL(url); const host = parsed.hostname.toLowerCase();
          if (/(?:^|\.)(?:fbcdn\.net|cdninstagram\.com)$/.test(host)) {
            const original = new URL(parsed.href); let changed = false;
            for (const key of [...original.searchParams.keys()]) if (/^(?:stp|w|h|width|height|size|crop|fit|dpr|quality|q)$/i.test(key)) { original.searchParams.delete(key); changed = true }
            if (changed) { const clean = original.href; const oldOriginal = candidates.get(clean); const originalRow = { url: clean, width, height, score: score + 5_000_000, source: "meta-transform-free" }; if (!oldOriginal || originalRow.score > oldOriginal.score) candidates.set(clean, originalRow) }
            const stp = parsed.searchParams.get("stp");
            if (stp) { for (const [value, boost] of [["dst-jpg_p2048x2048_tt6", 4_900_000], ["dst-jpg_s2048x2048_tt6", 4_800_000], ["dst-jpg_p1440x1440_tt6", 4_700_000]]) { const larger = new URL(parsed.href); larger.searchParams.set("stp", value); const clean = larger.href; const oldLarge = candidates.get(clean); const largeRow = { url: clean, width, height, score: score + boost, source: "meta-large-transform" }; if (!oldLarge || largeRow.score > oldLarge.score) candidates.set(clean, largeRow) } }
          }
          if (/(?:^|\.)pinimg\.com$/.test(host)) {
            const original = new URL(parsed.href); original.pathname = parsed.pathname.replace(/\/(?:60x60|75x75_RS|136x136|170x|236x|280x280_RS|474x|564x|736x|1000x|1200x|\d{2,5}x(?:\d{2,5})?(?:_RS)?|originals)\//i, "/originals/");
            const clean = original.href; const oldOriginal = candidates.get(clean); const originalRow = { url: clean, width, height, score: score + 6_000_000, source: "pinterest-original" }; if (!oldOriginal || originalRow.score > oldOriginal.score) candidates.set(clean, originalRow)
          }
        } catch (_) { }
      };
      const parseSrcset = value => {
        const rows = []; for (const part of String(value || "").split(/,(?=\s*(?:https?:|\/|\.\/|\.\.\/))/i)) { const bits = part.trim().split(/\s+/); if (bits[0]) rows.push({ url: bits[0], descriptor: bits[1] || "" }) } return rows
      };
      const rootFor = node => {
        if (!(node instanceof Element)) return document.body;
        if (platform === "instagram") return node.closest("article,[role='dialog']") || document.body;
        if (platform === "facebook") return node.closest("[role='article'],div[data-pagelet*='FeedUnit'],article,[role='dialog']") || document.body;
        if (platform === "pinterest") return node.closest("[data-test-id='pin'],[data-test-id='pinWrapper'],[data-test-id='closeup-body'],[data-test-id*='pin'],article,[role='dialog']") || document.body;
        return node.closest("article,[role='dialog']") || document.body;
      };
      let hit = null; try { hit = document.elementsFromPoint(Number(request?.point?.x || 0), Number(request?.point?.y || 0)).find(node => node instanceof Element) } catch (_) { }
      const root = rootFor(hit || document.body);
      const pointX = Number(request?.point?.x || 0), pointY = Number(request?.point?.y || 0);
      const media = [...root.querySelectorAll("img,picture source")].slice(0, 500);
      for (const node of media) {
        if (node instanceof HTMLImageElement) {
          const rect = node.getBoundingClientRect?.(); const contains = rect && pointX >= rect.left && pointX <= rect.right && pointY >= rect.top && pointY <= rect.bottom;
          const idMatch = currentIdentity && [node.currentSrc, node.src].some(value => matchesCurrent(value));
          if (!contains && !idMatch) continue;
          add(node.currentSrc, { width: node.naturalWidth, height: node.naturalHeight, source: "current-src" });
          add(node.src, { width: node.naturalWidth, height: node.naturalHeight, source: "src" });
          for (const row of parseSrcset(node.srcset || "")) add(row.url, { width: /\d+w$/i.test(row.descriptor) ? parseInt(row.descriptor, 10) : node.naturalWidth, height: node.naturalHeight, source: "srcset" });
          for (const name of ["data-src", "data-original", "data-original-src", "data-full", "data-full-src", "data-zoom-image", "data-hi-res-src", "data-high-res-src", "data-large-image", "data-visualcompletion"]) add(node.getAttribute(name), { width: node.naturalWidth, height: node.naturalHeight, source: `dom-${name}` });
          for (const source of node.closest("picture")?.querySelectorAll?.("source[srcset]") || []) for (const row of parseSrcset(source.getAttribute("srcset") || "")) add(row.url, { width: /\d+w$/i.test(row.descriptor) ? parseInt(row.descriptor, 10) : 0, height: 0, source: "picture-srcset" });
        } else {
          for (const row of parseSrcset(node.getAttribute?.("srcset") || "")) add(row.url, { source: "picture-srcset" });
        }
      }
      add(currentUrl, { source: "request-current", score: 1_000_000, trustedCurrent: true });

      // The full rendition may be preloaded or already requested even when the
      // visible <img> still points at a feed-size URL.
      for (const link of document.querySelectorAll('link[rel="preload"][as="image"],link[rel="prefetch"][as="image"]')) {
        add(link.href || link.getAttribute("href"), { source: "image-preload", score: 9_000_000 });
        for (const row of parseSrcset(link.getAttribute("imagesrcset") || "")) add(row.url, { source: "image-preload-srcset", score: 9_500_000 });
      }
      try { for (const entry of performance.getEntriesByType("resource")) { if (matchesCurrent(entry.name)) add(entry.name, { source: "performance-image", score: 10_000_000 }) } } catch (_) { }

      const queue = []; const push = (value, path = "") => { if (value && typeof value === "object" && !(value instanceof Node) && !(value instanceof Window)) queue.push({ value, path }) };
      const nodeSet = new Set([root, ...root.querySelectorAll("*")].slice(0, 4500));
      let ancestor = hit; for (let depth = 0; ancestor && depth < 24; depth += 1, ancestor = ancestor.parentElement)nodeSet.add(ancestor);
      const nodes = [...nodeSet];
      for (const node of nodes) { for (const key of Object.getOwnPropertyNames(node)) { if (!key.startsWith("__reactProps$") && !key.startsWith("__reactContainer$") && !key.startsWith("__reactFiber$")) continue; try { const value = node[key]; if (key.startsWith("__reactFiber$")) { let fiber = value; for (let depth = 0; fiber && depth < 36; depth += 1, fiber = fiber.return) { push(fiber?.memoizedProps, `react.${key}.return${depth}.memoizedProps`); push(fiber?.pendingProps, `react.${key}.return${depth}.pendingProps`); push(fiber?.alternate?.memoizedProps, `react.${key}.return${depth}.alternate`) } } else push(value, `react.${key}`) } catch (_) { } } }
      for (const key of ["_sharedData", "__initialData", "__additionalData", "__NEXT_DATA__", "__PWS_DATA__", "__PRELOADED_STATE__"]) { try { push(window[key], `window.${key}`) } catch (_) { } }
      const visited = new WeakSet(); let inspected = 0;
      while (queue.length && inspected < 90000) {
        const { value, path } = queue.shift(); if (!value || typeof value !== "object" || visited.has(value)) continue; visited.add(value); inspected += 1;
        const width = Number(value?.width || value?.original_width || value?.originalWidth || value?.dimensions?.width || value?.image_width || 0);
        const height = Number(value?.height || value?.original_height || value?.originalHeight || value?.dimensions?.height || value?.image_height || 0);
        for (const [key, row] of Object.entries(value)) {
          const nextPath = `${path}.${key}`;
          if (typeof row === "string") {
            if (/image|display|thumbnail|preview|uri|url|src|photo|original|full/i.test(`${key} ${path}`)) add(row, { width, height, source: /react/i.test(path) ? "react-data" : "page-data" });
          } else if (row && typeof row === "object") {
            if (/image_versions|imageVersions|images|photo|display_resources|displayResources|resolutions/i.test(key)) {
              const values = Array.isArray(row) ? row : Object.values(row); for (const entry of values) { if (!entry || typeof entry !== "object") continue; add(entry.url || entry.src || entry.uri || entry.display_url || entry.displayUrl, { width: entry.width || entry.config_width || width, height: entry.height || entry.config_height || height, source: `${key}-data` }) }
            }
            push(row, nextPath)
          }
        }
      }
      const title = cleanText(root.querySelector?.("h1,h2,h3,[data-test-id*='title'],[class*='title'],[class*='Title'],[data-ad-preview='message']")?.textContent || request?.suggestedName || document.title || `${platform} image`, 220);
      return { items: [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 24), title };
    }
  });
  return results?.[0]?.result || { items: [], title: "" };
}


function comparablePageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:__cft__|__tn__|ref|refid|mibextid|tracking|utm_|fbclid)/i.test(key)) url.searchParams.delete(key);
    }
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/+$/, "")}?${url.searchParams.toString()}`;
  } catch (_) { return ""; }
}

function socialDetailPage(message) {
  const current = comparablePageUrl(message?.pageUrl || "");
  for (const value of Array.isArray(message?.detailPageUrls) ? message.detailPageUrls : []) {
    const raw = String(value || "").trim();
    if (!/^https?:/i.test(raw)) continue;
    if (/\/(?:reel|watch|videos?|tv)\b/i.test(raw)) continue;
    const comparable = comparablePageUrl(raw);
    if (comparable && comparable !== current) return raw;
  }
  return "";
}

async function waitForTabDocument(tabId, timeoutMs = 6500) {
  try {
    const current = await chrome.tabs.get(tabId);
    if (current?.status === "complete") return;
  } catch (_) { }
  await new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) { }
      resolve();
    };
    const listener = (changedId, changeInfo) => {
      if (changedId === tabId && changeInfo.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function extractSocialImageFromDetailTab(message) {
  const detailUrl = socialDetailPage(message);
  if (!detailUrl) return { items: [], title: "" };
  let tabId = 0;
  try {
    const tab = await chrome.tabs.create({ url: detailUrl, active: false });
    tabId = Number(tab?.id || 0);
    if (!tabId) return { items: [], title: "" };
    await waitForTabDocument(tabId, 7000);
    await new Promise(resolve => setTimeout(resolve, 900));
    const extracted = await extractCurrentSocialImageFromMainWorld(tabId, 0, {
      ...message,
      pageUrl: detailUrl,
      point: { x: 0, y: 0 }
    });
    return {
      items: (Array.isArray(extracted?.items) ? extracted.items : []).map(row => ({
        ...row,
        score: Number(row?.score || 0) + 55_000_000,
        source: `detail-page-${String(row?.source || "image")}`
      })),
      title: String(extracted?.title || "")
    };
  } catch (_) {
    return { items: [], title: "" };
  } finally {
    if (tabId) await chrome.tabs.remove(tabId).catch(() => { });
  }
}

async function resolveCurrentSocialImageResource(message, sender) {
  const tabId = Number(sender?.tab?.id || message?.tabId || 0);
  const frameId = Number(sender?.frameId || message?.frameId || 0);
  const platform = String(message?.platform || "").toLowerCase();
  const extracted = await extractCurrentSocialImageFromMainWorld(tabId, frameId, message || {});
  const detailExtracted = await extractSocialImageFromDetailTab(message || {});
  const merged = new Map();
  for (const row of [...(Array.isArray(extracted?.items) ? extracted.items : []), ...(Array.isArray(detailExtracted?.items) ? detailExtracted.items : [])]) {
    const url = String(row?.url || ""); if (!url) continue;
    const old = merged.get(url); if (!old || Number(row?.score || 0) > Number(old?.score || 0)) merged.set(url, row);
  }
  const items = [...merged.values()].sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
  if (!items.length) throw new Error("The page did not expose a higher-resolution source for this image.");
  const best = items[0];
  const candidates = items.map((row, index) => ({ url: String(row.url || ""), rank: Number(row.score || 0) - index, authoritative: false, source: String(row.source || `${platform}-image`) })).filter(row => row.url);
  return {
    url: String(best.url || ""), candidates, mediaKind: "image", kind: "image",
    pageUrl: String(message?.pageUrl || sender?.tab?.url || ""), pageTitle: String(sender?.tab?.title || detailExtracted?.title || extracted?.title || ""),
    detailPageUrls: Array.isArray(message?.detailPageUrls) ? message.detailPageUrls : [String(message?.pageUrl || sender?.tab?.url || "")],
    suggestedName: sanitizeBase(message?.suggestedName || detailExtracted?.title || extracted?.title || `${platform} image`, `${platform} image`),
    originalFilename: filenameWithExtensionFromUrl(best.url) || filenameWithExtensionFromUrl(message?.currentUrl || ""),
    viewportRect: message?.viewportRect || null, viewportWidth: Number(message?.viewportWidth || 0), viewportHeight: Number(message?.viewportHeight || 0), devicePixelRatio: Number(message?.devicePixelRatio || 1), socialPlatform: platform
  };
}

async function extractInstagramCarouselFromMainWorld(tabId, frameId = 0, point = {}, shortcode = "") {
  if (!Number.isInteger(Number(tabId)) || Number(tabId) <= 0) return { items: [], totalHint: 0 };
  const target = { tabId: Number(tabId), frameIds: [Number.isInteger(Number(frameId)) ? Number(frameId) : 0] };
  const results = await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    args: [{
      x: Number(point?.x || 0), y: Number(point?.y || 0),
      width: Number(point?.width || 0), height: Number(point?.height || 0)
    }, String(shortcode || "")],
    func: (point, wantedShortcode) => {
      const cleanUrl = value => {
        try {
          const url = new URL(String(value || "").replace(/\\u0026/gi, "&").replace(/\\\//g, "/"), location.href);
          return /^https?:$/i.test(url.protocol) ? url.href : "";
        } catch (_) { return ""; }
      };
      const norm = value => {
        const raw = cleanUrl(value);
        if (!raw) return "";
        try { const u = new URL(raw); return `${u.origin}${u.pathname}`.toLowerCase(); }
        catch (_) { return raw.replace(/[?#].*$/, "").toLowerCase(); }
      };
      const text = value => String(value || "").replace(/\s+/g, " ").trim().slice(0, 260);
      const isObject = value => Boolean(value && typeof value === "object" && !(value instanceof Node) && !(value instanceof Window));

      const hit = Number.isFinite(point?.x) && Number.isFinite(point?.y)
        ? document.elementsFromPoint(point.x, point.y).find(node => node instanceof Element && node.closest?.("article,[role='dialog']"))
        : null;
      let root = hit?.closest?.("article") || hit?.closest?.("[role='dialog']") || null;
      if (!root && wantedShortcode) {
        const escaped = String(wantedShortcode).replace(/["\\]/g, "\\$&");
        const selector = `a[href*="/p/${escaped}/"],a[href*="/reel/${escaped}/"],a[href*="/tv/${escaped}/"]`;
        const link = document.querySelector(selector);
        root = link?.closest?.("article") || link?.closest?.("[role='dialog']") || null;
      }
      root ||= document.querySelector("article,[role='dialog']") || document.body;

      const visibleMedia = [...root.querySelectorAll("img,video")].map(node => {
        const rect = node.getBoundingClientRect();
        const url = node instanceof HTMLImageElement ? (node.currentSrc || node.src) : (node.currentSrc || node.src || node.poster);
        const overlap = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
        return { url: norm(url), overlap, area: Math.max(0, rect.width * rect.height) };
      }).filter(row => row.url && row.overlap > 0).sort((a, b) => b.overlap - a.overlap || b.area - a.area);
      const visibleUrl = visibleMedia[0]?.url || "";

      const simplify = media => {
        if (!isObject(media)) return null;
        const candidates = [];
        const seen = new Set();
        const add = (value, width = 0, height = 0, source = "instagram-data") => {
          const url = cleanUrl(value);
          if (!url || seen.has(url)) return;
          seen.add(url);
          candidates.push({ url, width: Number(width || 0), height: Number(height || 0), rank: Math.max(1, Number(width || 0) * Number(height || 0)), source });
        };
        for (const row of media?.image_versions2?.candidates || media?.image_versions?.candidates || []) add(row?.url, row?.width, row?.height, "instagram-image-data");
        for (const row of media?.display_resources || media?.thumbnail_resources || []) add(row?.src || row?.url, row?.config_width || row?.width, row?.config_height || row?.height, "instagram-display-data");
        add(media?.display_url || media?.displayUrl || media?.thumbnail_src || media?.thumbnail_url || media?.image_url, media?.dimensions?.width || media?.original_width, media?.dimensions?.height || media?.original_height, "instagram-display-url");
        const videos = media?.video_versions || media?.videoVersions || [];
        for (const row of videos) add(row?.url, row?.width, row?.height, "instagram-video-data");
        add(media?.video_url || media?.videoUrl, media?.dimensions?.width || media?.original_width, media?.dimensions?.height || media?.original_height, "instagram-video-url");
        candidates.sort((a, b) => b.rank - a.rank);
        if (!candidates.length) return null;
        const isVideo = Boolean(videos.length || media?.video_url || media?.videoUrl || Number(media?.media_type) === 2 || media?.is_video);
        const preferred = isVideo ? candidates.find(row => /video/.test(row.source)) || candidates[0] : candidates[0];
        return {
          id: String(media?.id || media?.pk || media?.shortcode || media?.code || ""),
          shortcode: String(media?.shortcode || media?.code || ""),
          media_type: isVideo ? 2 : 1,
          display_url: preferred.url,
          image_versions2: { candidates: candidates.filter(row => !/video/.test(row.source)).map(row => ({ url: row.url, width: row.width, height: row.height })) },
          video_versions: candidates.filter(row => /video/.test(row.source)).map(row => ({ url: row.url, width: row.width, height: row.height })),
          original_width: Number(media?.original_width || media?.dimensions?.width || preferred.width || 0),
          original_height: Number(media?.original_height || media?.dimensions?.height || preferred.height || 0),
          caption: { text: text(media?.caption?.text || media?.accessibility_caption || media?.accessibilityCaption || media?.title || "") }
        };
      };

      const groups = [];
      const groupSignatures = new Set();
      const register = (rows, owner = {}) => {
        if (!Array.isArray(rows) || rows.length < 2) return;
        const items = rows.map(row => simplify(row?.node || row?.media || row)).filter(Boolean);
        if (items.length < 2) return;
        const signature = items.map(item => norm(item.display_url)).filter(Boolean).join("|");
        if (!signature || groupSignatures.has(signature)) return;
        groupSignatures.add(signature);
        const ownerCode = String(owner?.shortcode || owner?.code || owner?.media?.code || owner?.xdt_shortcode_media?.shortcode || "");
        let score = items.length * 10;
        if (wantedShortcode && ownerCode === wantedShortcode) score += 10000;
        if (visibleUrl && items.some(item => norm(item.display_url) === visibleUrl || item.image_versions2?.candidates?.some(row => norm(row.url) === visibleUrl))) score += 5000;
        groups.push({ items, score, ownerCode });
      };

      const queue = [];
      const pushValue = (value, depth = 0) => { if (isObject(value)) queue.push({ value, depth }); };
      const nodes = [root, ...root.querySelectorAll("*")].slice(0, 5000);
      for (const node of nodes) {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (key.startsWith("__reactProps$") || key.startsWith("__reactContainer$") || key.startsWith("__reactFiber$")) {
            try {
              const value = node[key];
              if (key.startsWith("__reactFiber$")) {
                pushValue(value?.memoizedProps, 0);
                pushValue(value?.pendingProps, 0);
                pushValue(value?.alternate?.memoizedProps, 0);
              } else pushValue(value, 0);
            } catch (_) { }
          }
        }
      }
      for (const key of ["_sharedData", "__initialData", "__additionalData", "__NEXT_DATA__"]) {
        try { pushValue(window[key], 0); } catch (_) { }
      }

      const visited = new WeakSet();
      let inspected = 0;
      while (queue.length && inspected < 120000 && groups.length < 80) {
        const { value, depth } = queue.shift();
        if (!isObject(value) || visited.has(value) || depth > 16) continue;
        visited.add(value); inspected += 1;
        try {
          register(value?.carousel_media, value);
          register(value?.carouselMedia, value);
          register(value?.edge_sidecar_to_children?.edges, value);
          register(value?.xdt_shortcode_media?.edge_sidecar_to_children?.edges, value?.xdt_shortcode_media || value);
          register(value?.graphql?.shortcode_media?.edge_sidecar_to_children?.edges, value?.graphql?.shortcode_media || value);
          if (Array.isArray(value?.items)) {
            for (const row of value.items.slice(0, 60)) {
              register(row?.carousel_media, row);
              register(row?.edge_sidecar_to_children?.edges, row);
            }
          }
        } catch (_) { }
        if (depth >= 16) continue;
        if (Array.isArray(value)) {
          for (const child of value.slice(0, 500)) pushValue(child, depth + 1);
        } else {
          let entries = [];
          try { entries = Object.entries(value); } catch (_) { entries = []; }
          let count = 0;
          for (const [key, child] of entries) {
            if (++count > 500) break;
            if (/^(?:return|child|sibling|stateNode|_owner|parentNode|ownerDocument)$/i.test(key)) continue;
            pushValue(child, depth + 1);
          }
        }
      }

      groups.sort((a, b) => b.score - a.score || b.items.length - a.items.length);
      const best = groups[0]?.items || [];

      let totalHint = best.length;
      const labels = [...root.querySelectorAll("[aria-label],[aria-valuetext]")].map(node => `${node.getAttribute("aria-label") || ""} ${node.getAttribute("aria-valuetext") || ""}`);
      for (const label of labels) {
        const match = label.match(/(?:slide|photo|image)?\s*(\d+)\s*(?:of|\/|out of)\s*(\d+)/i);
        if (match) totalHint = Math.max(totalHint, Number(match[2] || 0));
      }
      return { items: best.slice(0, 60), totalHint, visibleUrl, groupsFound: groups.length };
    }
  });
  return results?.[0]?.result || { items: [], totalHint: 0 };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;
  if (action === "moodbox-context-target") {
    const tabId = Number(sender?.tab?.id || message?.tabId || 0);
    const frameId = Number(sender?.frameId || message?.frameId || 0);
    if (tabId > 0) {
      rememberContextTarget(tabId, frameId, {
        contextKind: String(message?.contextKind || "page"),
        resource: message?.resource || null,
        fontTarget: message?.fontTarget || null,
        point: message?.point || null,
        pageUrl: String(message?.pageUrl || sender?.tab?.url || ""),
        pageTitle: String(message?.pageTitle || sender?.tab?.title || "")
      });
      refreshPageMenuFromCachedTarget(tabId, frameId).catch(() => { });
    }
    return false;
  }
  if (action === "moodboxDownload-instagram-carousel-data") {
    extractInstagramCarouselFromMainWorld(
      Number(sender.tab?.id || message.tabId || 0),
      Number(sender.frameId || 0),
      message.point || {},
      String(message.shortcode || "")
    ).then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, items: [], totalHint: 0, error: error?.message || "Instagram carousel data was unavailable." }));
    return true;
  }
  if (action === "moodbox-capture-state") {
    loadMoodboxState({ fresh: Boolean(message.fresh) })
      .then(state => sendResponse({ ok: true, active: Boolean(state.active), project: state.project ? { id: state.project.id, name: state.project.name || "MoodBox" } : null, projects: state.projects, lastUsedProjectId: state.lastUsedProjectId }))
      .catch(() => sendResponse({ ok: true, active: false, project: null, projects: [], lastUsedProjectId: "" }));
    return true;
  }
  if (action === "moodbox-direct-send") {
    sendDirectToMoodbox(message.resource || {}, Number(sender.tab?.id || 0), String(message.projectId || ""))
      .then(project => sendResponse({ ok: true, projectName: project.name || "MoodBox", projectId: project.id }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Could not send this image to MoodBox." }));
    return true;
  }
  if (action === "moodbox-get-pending-capture") {
    const captureId = String(message.captureId || "");
    const pending = pendingMoodboxCaptures.get(captureId);
    if (pending) {
      sendResponse({ ok: true, capture: pending });
    } else {
      chrome.storage.local.get("moodboxPendingCapture")
        .then(stored => sendResponse({ ok: Boolean(stored.moodboxPendingCapture), capture: stored.moodboxPendingCapture || null }))
        .catch(() => sendResponse({ ok: false, capture: null }));
      return true;
    }
    return true;
  }
  if (action === "moodbox-clear-pending-capture") {
    const captureId = String(message.captureId || "");
    if (captureId) pendingMoodboxCaptures.delete(captureId);
    chrome.storage.local.remove("moodboxPendingCapture").catch(() => { });
    sendResponse({ ok: true });
    return true;
  }
  if (action === "moodbox-get-projects") {
    loadMoodboxState({ fresh: true })
      .then(state => sendResponse({ ok: Boolean(state.active), projects: state.projects, lastUsedProjectId: state.lastUsedProjectId }))
      .catch(error => sendResponse({ ok: false, projects: [], lastUsedProjectId: "", error: error?.message || "MoodBox is unavailable." }));
    return true;
  }
  if (action === "moodbox-resolve-capture-image") {
    resolveMoodboxCaptureImage(message.resource || {}, Number(message.tabId || sender.tab?.id || 0), Number(message.frameId || sender.frameId || 0))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error?.message || "Could not resolve the selected image." }));
    return true;
  }
  if (action === "moodbox-show-toast") {
    showMoodboxAddedToast(Number(message.tabId || 0), String(message.projectName || "MoodBox"))
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (["moodboxDownload-create-asset-session", "moodbox-create-asset-session", "collecta-create-asset-session"].includes(action)) {
    const tabId = Number(message.tabId || sender.tab?.id || 0);
    const scanMode = message.scanMode === "fonts" ? "fonts" : (message.scanMode === "deep" ? "deep" : "quick");
    createAssetSession(tabId, { scanMode })
      .then(({ token, payload }) => sendResponse({ ok: true, token, count: payload.items.length, assetMode: payload.assetMode || "all" }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Could not scan this page." }));
    return true;
  }
  if (["moodboxDownload-open-batch", "moodbox-open-batch", "collecta-open-batch"].includes(action)) {
    const tabId = Number(message.tabId || sender.tab?.id || 0);
    const scanMode = message.scanMode === "fonts" ? "fonts" : (message.scanMode === "deep" ? "deep" : "quick");
    openBatchDownload(tabId, { scanMode })
      .then(({ payload }) => sendResponse({ ok: true, count: payload.items.length, assetMode: payload.assetMode || "all" }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Could not scan this page." }));
    return true;
  }
  if (action === "moodboxDownload-refresh-batch") {
    const token = String(message.token || "");
    const key = `moodboxDownloadBatch:${token}`;
    Promise.all([chrome.storage.session.get(key).catch(() => ({})), chrome.storage.local.get(key)])
      .then(async ([session, local]) => {
        const old = session[key] || local[key];
        if (!old?.tabId) throw new Error("The source page is no longer available.");
        const payload = await collectBatchFromTab(Number(old.tabId), { scanMode: old.assetMode === "fonts" ? "fonts" : "quick" });
        await storeBatchPayload(token, payload);
        sendResponse({ ok: true, payload });
      })
      .catch(error => sendResponse({ ok: false, error: error.message || "Could not refresh this page." }));
    return true;
  }
  if (action === "moodboxDownload-hotkey-image") {
    const tabId = Number(message.tabId || sender.tab?.id || 0);
    startHotkeyImageDownload(message.resource || {}, tabId)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error?.message || "Could not download this image." }));
    return true;
  }
  if (action === "moodboxDownload-reserve-filename") {
    const pending = queueForcedFilename(String(message.filename || "image.png"));
    sendResponse({ ok: true, token: pending.id });
    return false;
  }
  if (action === "moodboxDownload-cancel-reserved-filename") {
    const wanted = String(message.token || "");
    const pending = pendingFilenameRequests.find(row => row.id === wanted);
    if (pending) removeForcedFilename(pending);
    sendResponse({ ok: true });
    return false;
  }
  if (action === "moodboxDownload-resolve-social-image") {
    resolveCurrentSocialImageResource(message || {}, sender)
      .then(resource => sendResponse({ ok: true, resource }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Could not resolve this social image." }));
    return true;
  }
  if (action === "moodboxDownload-resolve-social-video") {
    sendResponse({ ok: false, error: "Video download is disabled." });
    return false;
  }
  if (action === "moodboxDownload-resolve-batch-url") {
    const item = { url: String(message.url || ""), frameId: Number(message.frameId || 0) };
    resolveBatchDownloadUrl(item, Number(message.tabId || 0))
      .then(url => sendResponse({ ok: true, url }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Could not resolve this image." }));
    return true;
  }
  if (action === "moodboxDownload-batch-download") {
    downloadBatch(message.items, Number(message.tabId || 0))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Batch download failed." }));
    return true;
  }
  if (["moodboxDownload-download-media", "moodbox-download-media", "collecta-download-media"].includes(action)) {
    startDownload(message.resource || {}, Number(sender.tab?.id || 0), Number(sender.frameId || 0))
      .then(downloadId => sendResponse({ ok: true, downloadId, started: 1 }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Download failed." }));
    return true;
  }
  if (["moodboxDownload-download-media-list", "moodbox-download-media-list", "collecta-download-media-list"].includes(action)) {
    startDownloadList(message.resources, Number(sender.tab?.id || 0), Number(sender.frameId || 0))
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Media downloads failed." }));
    return true;
  }
  return false;
});

buildMenus().catch(() => { });
