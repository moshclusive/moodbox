"use strict";

const el = id => document.getElementById(id);
const L = globalThis.MoodBoxLibrary;
let state = {folders: [], items: [], counts: new Map(), bytes: new Map()};
let currentView = "all";
let editingFolderId = "";
let contextFolderId = "";
let dialogMode = "create";
let movingItemIds = [];
let messageTimer = 0;
const previewUrls = new Set();
const fontFaces = new Map();
const downloadWaiters = new Map();

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function setMessage(text = "", error = false, hold = false) {
  clearTimeout(messageTimer);
  el("libraryMessage").textContent = text;
  el("libraryMessage").className = `message${error ? " error" : ""}`;
  if (text && !hold) messageTimer = setTimeout(() => setMessage(""), 3000);
}

function folderName(folderId) {
  if (String(folderId || "") === String(L.NO_FOLDER_ID)) return "No Folder";
  return state.folders.find(folder => folder.id === folderId)?.name || "No Folder";
}

function safePath(value) {
  return L.cleanFolderName(value) || "No Folder";
}

function currentItems() {
  const query = el("librarySearch").value.trim().toLowerCase();
  const savedItems = state.items.filter(item => item.folderId !== L.TRAY_ID);
  let rows = currentView === "all" ? savedItems : savedItems.filter(item => item.folderId === currentView);
  if (query) {
    rows = rows.filter(item => `${item.filename} ${item.type} ${item.kind} ${item.sourceHost} ${item.pageTitle} ${folderName(item.folderId)}`.toLowerCase().includes(query));
  }
  return rows;
}

function disposePreviews() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls.clear();
}

function makePreviewUrl(blob) {
  const url = URL.createObjectURL(blob);
  previewUrls.add(url);
  return url;
}

async function loadFont(item, node) {
  if (!(item.blob instanceof Blob)) return;
  let promise = fontFaces.get(item.id);
  if (!promise) {
    promise = (async () => {
      const url = makePreviewUrl(item.blob);
      const family = `MoodBoxSaved-${item.id.replace(/[^a-z0-9]/gi, "")}`;
      const face = new FontFace(family, `url(${url})`, {
        style: item.fontStyle || "normal",
        weight: String(item.fontWeight || "400")
      });
      await face.load();
      document.fonts.add(face);
      return family;
    })();
    fontFaces.set(item.id, promise);
  }
  try { node.style.fontFamily = `"${await promise}", sans-serif`; } catch (_) {}
}

function closeViewMenu() {
  el("viewMenu").hidden = true;
  el("moreActions").setAttribute("aria-expanded", "false");
}

function closeFolderContextMenu() {
  el("folderContextMenu").hidden = true;
  contextFolderId = "";
}

function showFolderContextMenu(folderId, event) {
  const folder = state.folders.find(row => row.id === folderId);
  if (!folder) return;
  event.preventDefault();
  event.stopPropagation();
  closeViewMenu();
  contextFolderId = folderId;
  const menu = el("folderContextMenu");
  menu.hidden = false;
  const width = 170;
  const height = 80;
  const left = Math.min(event.clientX, window.innerWidth - width - 8);
  const top = Math.min(event.clientY, window.innerHeight - height - 8);
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
}

function renderSidebar() {
  const nav = el("folderNav");
  nav.replaceChildren();
  const savedCount = state.items.filter(item => item.folderId !== L.TRAY_ID).length;
  const entries = [
    {id: "all", name: "ALL", icon: "ALL", count: savedCount, custom: false},
    ...state.folders.map(folder => ({
      id: folder.id,
      name: folder.name,
      icon: "▱",
      count: state.counts.get(folder.id) || 0,
      custom: true
    }))
  ];

  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.customFolder = String(entry.custom);
    button.classList.toggle("all-entry", !entry.custom);
    button.classList.toggle("active", currentView === entry.id);
    button.title = entry.custom ? `${entry.name} — right-click for folder actions` : entry.name;

    const icon = document.createElement("i");
    icon.textContent = entry.icon;
    const label = document.createElement("span");
    label.textContent = entry.name;
    const count = document.createElement("small");
    count.textContent = String(entry.count);
    button.append(icon, label, count);

    button.onclick = () => {
      currentView = entry.id;
      closeFolderContextMenu();
      render();
      if (window.innerWidth <= 760) setSidebar(false);
    };
    if (entry.custom) button.oncontextmenu = event => showFolderContextMenu(entry.id, event);
    nav.append(button);
  }
}

function renderToolbar(rows) {
  const isFolder = currentView !== "all";
  const label = currentView === "all" ? "Download all" : "Download folder";
  el("downloadLabel").textContent = label;
  el("downloadCount").textContent = String(rows.length);
  el("downloadView").disabled = rows.length === 0;
  el("downloadView").title = `${label} (${rows.length})`;

  const canMove = currentView !== "all" && rows.length > 0 && state.folders.some(folder => folder.id !== currentView);
  el("moveView").hidden = !canMove;
  el("deleteView").hidden = isFolder;
  el("deleteView").textContent = "Clear library";

  const hasMoreActions = canMove || !isFolder;
  el("moreActions").hidden = !hasMoreActions;
  if (!hasMoreActions) closeViewMenu();
}

function renderCard(item) {
  const node = el("libraryCardTemplate").content.firstElementChild.cloneNode(true);
  const preview = node.querySelector(".asset-preview");
  const image = preview.querySelector("img");

  if ((item.kind === "image" || item.kind === "vector") && item.blob instanceof Blob) {
    image.src = makePreviewUrl(item.blob);
    image.alt = item.alt || item.filename;
    image.onerror = () => preview.classList.add("file-mode");
  } else if (item.kind === "font") {
    preview.classList.add("font-mode");
    loadFont(item, preview.querySelector(".font-preview"));
  } else {
    preview.classList.add("file-mode");
    preview.querySelector(".file-preview strong").textContent = String(item.type || "FILE").toUpperCase();
    preview.querySelector(".file-preview span").textContent = item.kind || "Saved asset";
  }

  node.querySelector(".asset-name").textContent = item.fontFamily || item.filename;
  node.querySelector(".asset-name").title = item.filename;
  node.querySelector(".asset-facts").textContent = [
    String(item.type || "asset").toUpperCase(),
    item.width && item.height ? `${item.width}×${item.height}` : "",
    formatBytes(item.bytes || item.blob?.size)
  ].filter(Boolean).join(" · ");

  const sourceText = currentView === "all"
    ? `${folderName(item.folderId)}${item.sourceHost ? ` · ${item.sourceHost}` : ""}`
    : (item.sourceHost || item.pageTitle || "");
  const source = node.querySelector(".asset-source");
  source.textContent = sourceText;
  source.hidden = !sourceText;

  node.querySelector(".remove-item").onclick = async () => {
    if (!confirm(`Remove “${item.filename}” from MoodBox?`)) return;
    await L.deleteItems([item.id]);
    await refresh();
  };
  return node;
}

function renderGrid(rows) {
  disposePreviews();
  const grid = el("libraryGrid");
  grid.replaceChildren();
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No saved assets.";
    grid.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const item of rows) fragment.append(renderCard(item));
  grid.append(fragment);
}

function render() {
  const rows = currentItems();
  renderSidebar();
  renderToolbar(rows);
  renderGrid(rows);
}

async function refresh() {
  state = await L.summary();
  if (currentView !== "all" && !state.folders.some(folder => folder.id === currentView)) {
    currentView = "all";
  }
  render();
}

function openFolderDialog(folder = null) {
  dialogMode = folder ? "rename" : "create";
  editingFolderId = folder?.id || "";
  movingItemIds = [];
  el("folderDialogTitle").textContent = folder ? "Rename folder" : "Create folder";
  el("folderNameField").hidden = false;
  el("moveFolderField").hidden = true;
  el("saveFolder").textContent = folder ? "Rename" : "Create folder";
  el("folderName").value = folder?.name || "";
  el("folderDialog").showModal();
  setTimeout(() => el("folderName").focus(), 30);
}

function openMoveDialog(rows) {
  const choices = [{id:L.NO_FOLDER_ID, name:"No Folder"}, ...state.folders.filter(folder => folder.id !== currentView)];
  if (!choices.length) {
    setMessage("Create another folder first.", true);
    return;
  }
  dialogMode = "move";
  editingFolderId = "";
  movingItemIds = rows.map(item => item.id);
  el("folderDialogTitle").textContent = `Move ${movingItemIds.length} item${movingItemIds.length === 1 ? "" : "s"}`;
  el("folderNameField").hidden = true;
  el("moveFolderField").hidden = false;
  el("saveFolder").textContent = "Move";
  const select = el("moveFolderSelect");
  select.replaceChildren();
  for (const folder of choices) {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = folder.name;
    select.append(option);
  }
  el("folderDialog").showModal();
  setTimeout(() => select.focus(), 30);
}



function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function dataUrlFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read library image."));
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(blob, filename, mime = "application/octet-stream") {
  return new Promise(async (resolve, reject) => {
    try {
      const url = URL.createObjectURL(blob);
      const id = await chrome.downloads.download({url, filename, saveAs:false, conflictAction:"uniquify"});
      if (!Number.isInteger(id)) throw new Error("Download did not start.");
      downloadWaiters.set(id, {resolve, reject});
      const rows = await chrome.downloads.search({id}).catch(() => []);
      const stateValue = rows?.[0]?.state;
      if (stateValue === "complete") { downloadWaiters.delete(id); URL.revokeObjectURL(url); resolve(id); }
      else if (stateValue === "interrupted") { downloadWaiters.delete(id); URL.revokeObjectURL(url); reject(new Error("Download was interrupted.")); }
      else setTimeout(() => { URL.revokeObjectURL(url); }, 60_000);
    } catch (error) { reject(error); }
  });
}

async function imageItemsForMoodboard() {
  const saved = state.items.filter(item => item.folderId !== L.TRAY_ID);
  const base = currentView === "all" ? saved : saved.filter(item => item.folderId === currentView);
  return base.filter(item => (item.kind === "image" || item.kind === "vector") && item.blob instanceof Blob);
}

async function createMoodboardExports() {
  const items = await imageItemsForMoodboard();
  if (!items.length) throw new Error("No saved images are available in this view.");
  const maxItems = items.slice(0, 80);
  setMessage(`Preparing Moodboard with ${maxItems.length} image${maxItems.length === 1 ? "" : "s"}…`, false, true);

  const title = currentView === "all" ? "ALL" : folderName(currentView);
  const safeTitle = L.cleanFolderName(title) || "ALL";
  const dataRows = [];
  for (const item of maxItems) {
    const dataUrl = await dataUrlFromBlob(item.blob);
    let width = Number(item.width || 0), height = Number(item.height || 0);
    if (!width || !height) {
      try {
        const bitmap = await createImageBitmap(item.blob);
        width = Number(bitmap.width || 0); height = Number(bitmap.height || 0); bitmap.close?.();
      } catch (_) {}
    }
    dataRows.push({
      dataUrl, width:Math.max(1,width), height:Math.max(1,height),
      name:item.filename || "Saved image", host:item.sourceHost || ""
    });
  }

  const PAGE_W = 3200;
  const GUTTER = 42;
  const COLS = 4;
  const CARD_W = Math.floor((PAGE_W - GUTTER * (COLS + 1)) / COLS);
  const HEADER_H = 250;
  const IMAGE_MAX_H = 980;
  const TEXT_H = 82;
  const heights = new Array(COLS).fill(HEADER_H + GUTTER);
  const placed = [];

  for (const row of dataRows) {
    let column = 0;
    for (let i = 1; i < COLS; i++) if (heights[i] < heights[column]) column = i;
    const ratio = row.width / row.height;
    const imageH = Math.max(160, Math.min(IMAGE_MAX_H, Math.round(CARD_W / Math.max(0.2, ratio))));
    const cardH = imageH + TEXT_H;
    const x = GUTTER + column * (CARD_W + GUTTER);
    const y = heights[column];
    placed.push({...row, x, y, imageH, cardH});
    heights[column] += cardH + GUTTER;
  }

  const PAGE_H = Math.min(12000, Math.max(HEADER_H + GUTTER * 2, Math.max(...heights) + GUTTER));
  const bg = "#F5F5F2";
  const card = "#FFFFFF";
  const line = "#E0E3E7";
  const textColor = "#15191E";
  const muted = "#6B7480";

  const svgParts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">`,
    `<rect width="100%" height="100%" fill="${bg}"/>`,
    `<rect x="${GUTTER}" y="${GUTTER}" width="10" height="142" rx="5" fill="#EB7222"/>`,
    `<text x="${GUTTER + 48}" y="${GUTTER + 68}" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="54" font-weight="700" fill="${textColor}">MoodBox — ${escapeHtml(safeTitle)}</text>`,
    `<text x="${GUTTER + 48}" y="${GUTTER + 126}" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="25" fill="${muted}">${dataRows.length} image${dataRows.length === 1 ? "" : "s"} · exported from MoodBox Library</text>`
  ];

  for (const row of placed) {
    const clipId = `clip${placed.indexOf(row)}`;
    svgParts.push(`<defs><clipPath id="${clipId}"><rect x="${row.x}" y="${row.y}" width="${CARD_W}" height="${row.imageH}" rx="18"/></clipPath></defs>`);
    svgParts.push(`<rect x="${row.x}" y="${row.y}" width="${CARD_W}" height="${row.cardH}" rx="18" fill="${card}" stroke="${line}"/>`);
    svgParts.push(`<rect x="${row.x}" y="${row.y}" width="${CARD_W}" height="${row.imageH}" fill="#EEF0F2" clip-path="url(#${clipId})"/>`);
    const drawW = CARD_W;
    const drawH = row.imageH;
    const src = row.dataUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    svgParts.push(`<image href="${src}" x="${row.x}" y="${row.y}" width="${drawW}" height="${drawH}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clipId})"/>`);
    const name = escapeHtml(row.name).slice(0, 150);
    const host = escapeHtml(row.host).slice(0, 100);
    svgParts.push(`<text x="${row.x + 22}" y="${row.y + row.imageH + 34}" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="22" font-weight="650" fill="${textColor}">${name}</text>`);
    if (host) svgParts.push(`<text x="${row.x + 22}" y="${row.y + row.imageH + 62}" font-family="Inter,Segoe UI,Arial,sans-serif" font-size="17" fill="${muted}">${host}</text>`);
  }
  svgParts.push(`</svg>`);
  const svgText = svgParts.join("");
  const svgBlob = new Blob([svgText], {type:"image/svg+xml;charset=utf-8"});
  const svgUrl = URL.createObjectURL(svgBlob);

  try {
    // Self-contained HTML export, matching the software's visual-card/masonry philosophy.
    const cards = dataRows.map(row => `<article class="card"><div class="image"><img src="${row.dataUrl}" alt=""></div><div class="name">${escapeHtml(row.name)}</div>${row.host ? `<div class="host">${escapeHtml(row.host)}</div>` : ""}</article>`).join("");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MoodBox — ${escapeHtml(safeTitle)}</title><style>body{margin:0;background:#f5f5f2;color:#15191e;font:16px/1.4 Inter,"Segoe UI",Arial,sans-serif}main{padding:56px;max-width:1800px;margin:auto}header{border-left:8px solid #EB7222;padding-left:20px;margin-bottom:28px}h1{margin:0 0 6px;font-size:42px}.sub{margin:0;color:#6b7480}.masonry{columns:4 320px;column-gap:22px}.card{display:inline-block;vertical-align:top;width:100%;margin:0 0 22px;background:#fff;border:1px solid #e0e3e7;border-radius:16px;overflow:hidden;break-inside:avoid}.image{background:#eef0f2;line-height:0}.image img{display:block;width:100%;height:auto;max-height:1050px;object-fit:contain}.name{padding:12px 14px 3px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.host{padding:0 14px 14px;color:#6b7480;font-size:13px}</style></head><body><main><header><h1>MoodBox — ${escapeHtml(safeTitle)}</h1><p class="sub">${dataRows.length} image${dataRows.length === 1 ? "" : "s"} · exported from MoodBox Library</p></header><section class="masonry">${cards}</section></main></body></html>`;
    const exportBase = `MoodBox_${safeTitle.replace(/[^a-z0-9_-]+/gi,"_")}_Moodboard`;
    await downloadBlob(new Blob([html], {type:"text/html;charset=utf-8"}), `${exportBase}.html`, "text/html");

    const image = new Image();
    image.src = svgUrl;
    await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("PNG export could not be rendered.")); });
    const canvas = document.createElement("canvas");
    canvas.width = PAGE_W; canvas.height = PAGE_H;
    const context = canvas.getContext("2d", {alpha:false});
    if (!context) throw new Error("PNG export canvas is unavailable.");
    context.fillStyle = bg; context.fillRect(0, 0, PAGE_W, PAGE_H);
    context.drawImage(image, 0, 0, PAGE_W, PAGE_H);
    const pngBlob = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG export failed.")), "image/png", 1));
    await downloadBlob(pngBlob, `${exportBase}.png`, "image/png");
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
  await refresh();
  setMessage("Moodboard HTML and maximum-quality PNG exported.");
}

async function reserveFilename(filename) {
  const response = await chrome.runtime.sendMessage({action: "moodboxDownload-reserve-filename", filename});
  return response?.token || "";
}

async function cancelReserve(token) {
  if (token) await chrome.runtime.sendMessage({action: "moodboxDownload-cancel-reserved-filename", token}).catch(() => {});
}

function finishDownloadWaiter(downloadId, stateValue) {
  const waiter = downloadWaiters.get(downloadId);
  if (!waiter) return;
  downloadWaiters.delete(downloadId);
  if (typeof waiter === "function") waiter(stateValue); else if (stateValue === "complete") waiter.resolve?.(downloadId); else waiter.reject?.(new Error("Download was interrupted."));
}

function waitForDownload(downloadId) {
  return new Promise(resolve => {
    downloadWaiters.set(downloadId, resolve);
    chrome.downloads.search({id: downloadId}).then(rows => {
      const stateValue = rows?.[0]?.state;
      if (stateValue === "complete" || stateValue === "interrupted") finishDownloadWaiter(downloadId, stateValue);
    }).catch(() => {});
  });
}

chrome.downloads.onChanged.addListener(delta => {
  if (delta.state?.current === "complete" || delta.state?.current === "interrupted") {
    finishDownloadWaiter(delta.id, delta.state.current);
  }
});

async function downloadItem(item, index) {
  if (!(item.blob instanceof Blob)) throw new Error("Saved bytes are unavailable.");
  const folder = safePath(folderName(item.folderId));
  const filename = L.cleanFilename(item.filename, `asset-${index + 1}.${item.type || "bin"}`);
  const path = `MoodBox Downloads/${folder}/${filename}`;
  const url = URL.createObjectURL(item.blob);
  const reservation = await reserveFilename(path);
  try {
    const id = await chrome.downloads.download({url, filename: path, saveAs: false, conflictAction: "uniquify"});
    if (!Number.isInteger(id)) throw new Error("Download did not start.");
    const stateValue = await waitForDownload(id);
    if (stateValue !== "complete") throw new Error("Download was interrupted.");
    await L.deleteItems([item.id]);
    return true;
  } catch (error) {
    await cancelReserve(reservation);
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function downloadRows(rows) {
  if (!rows.length) return;
  closeViewMenu();
  el("downloadView").disabled = true;
  setMessage(`Downloading ${rows.length} item${rows.length === 1 ? "" : "s"}…`, false, true);
  let cursor = 0;
  let complete = 0;
  let failed = 0;
  const concurrency = Math.max(1, Math.min(3, rows.length));
  await Promise.all(Array.from({length:concurrency}, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      try { await downloadItem(rows[index], index); complete += 1; }
      catch (_) { failed += 1; }
      setMessage(`${complete} complete${failed ? ` · ${failed} kept` : ""} · ${rows.length - complete - failed} remaining`, Boolean(failed), true);
    }
  }));
  await refresh();
  setMessage(failed ? `${complete} downloaded · ${failed} kept` : `${complete} downloaded and removed`, Boolean(failed));
}

function setSidebar(open) {
  el("appShell").classList.toggle("sidebar-hidden", !open);
  el("sidebarToggle").setAttribute("aria-expanded", open ? "true" : "false");
}

el("librarySearch").addEventListener("input", render);
el("librarySearch").addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.currentTarget.value = "";
    render();
  }
});
window.addEventListener("keydown", event => {
  if (event.key === "/" && document.activeElement !== el("librarySearch")) {
    event.preventDefault();
    el("librarySearch").focus();
  }
  if (event.key === "Escape") {
    closeViewMenu();
    closeFolderContextMenu();
    el("downloadMenu").hidden = true;
    el("downloadOptions").setAttribute("aria-expanded", "false");
  }
});

el("sidebarToggle").onclick = () => setSidebar(el("appShell").classList.contains("sidebar-hidden"));
el("refreshLibrary").onclick = refresh;
el("newFolder").onclick = () => openFolderDialog();
el("downloadView").onclick = () => downloadRows(currentItems());
el("downloadOptions").onclick = event => {
  event.stopPropagation();
  const menu = el("downloadMenu");
  menu.hidden = !menu.hidden;
  el("downloadOptions").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
};
el("downloadAllOption").onclick = () => {
  el("downloadMenu").hidden = true; el("downloadOptions").setAttribute("aria-expanded", "false");
  downloadRows(currentItems().filter(item => item.kind === "image" || item.kind === "vector"));
};
el("createMoodboardOption").onclick = async () => {
  el("downloadMenu").hidden = true; el("downloadOptions").setAttribute("aria-expanded", "false");
  try { await createMoodboardExports(); } catch (error) { setMessage(error.message || "Could not create the Moodboard.", true); }
};
el("moreActions").onclick = event => {
  event.stopPropagation();
  closeFolderContextMenu();
  const menu = el("viewMenu");
  menu.hidden = !menu.hidden;
  el("moreActions").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
};
el("viewMenu").onclick = event => event.stopPropagation();
el("moveView").onclick = () => {
  closeViewMenu();
  openMoveDialog(currentItems());
};
el("deleteView").onclick = async () => {
  closeViewMenu();
  if (currentView === "all") {
    if (!confirm("Clear every saved folder and item from MoodBox?")) return;
    for (const folder of state.folders) await L.deleteFolder(folder.id, {deleteContents: true});
  }
  await refresh();
};

document.addEventListener("click", () => {
  closeViewMenu();
  closeFolderContextMenu();
});
window.addEventListener("blur", () => {
  closeViewMenu();
  closeFolderContextMenu();
});
window.addEventListener("scroll", closeFolderContextMenu, true);

el("contextRename").onclick = event => {
  event.stopPropagation();
  const folder = state.folders.find(row => row.id === contextFolderId);
  closeFolderContextMenu();
  if (folder) openFolderDialog(folder);
};
el("contextDelete").onclick = async event => {
  event.stopPropagation();
  const folder = state.folders.find(row => row.id === contextFolderId);
  closeFolderContextMenu();
  if (!folder) return;
  if (!confirm(`Delete “${folder.name}” and every saved item inside it?`)) return;
  await L.deleteFolder(folder.id, {deleteContents: true});
  if (currentView === folder.id) currentView = "all";
  await refresh();
};

el("folderForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") {
    el("folderDialog").close();
    return;
  }
  try {
    if (dialogMode === "move") {
      const targetId = el("moveFolderSelect").value;
      const result = await L.moveItemsToFolder(movingItemIds, targetId);
      currentView = targetId;
      el("folderDialog").close();
      await refresh();
      setMessage(`${result.moved + result.merged} item${result.moved + result.merged === 1 ? "" : "s"} moved`);
      return;
    }
    const folder = dialogMode === "rename"
      ? await L.renameFolder(editingFolderId, el("folderName").value)
      : await L.createFolder(el("folderName").value);
    currentView = folder.id;
    el("folderDialog").close();
    await refresh();
  } catch (error) {
    setMessage(error.message || "Could not save folder.", true);
  }
});

window.addEventListener("unload", disposePreviews);
if (window.innerWidth <= 760) setSidebar(false);
refresh().catch(error => setMessage(error.message || "Could not open MoodBox Library.", true, true));
