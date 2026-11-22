const BRIDGE = "http://127.0.0.1:57684";
const BRIDGE_ENDPOINTS = [BRIDGE, "http://localhost:57684"];
const el = id => document.getElementById(id);
const target = el("targetProject");
const targetChooser = el("targetChooser");
const targetSelect = el("targetSelect");
const message = el("message");
const send = el("send");
const noteEditor = el("noteEditor");
const mentionPanel = el("mentionPanel");
const mentionList = el("mentionList");
const mentionStatus = el("mentionStatus");
const selectionSummary = el("selectionSummary");
const preview = el("capturePreview");

let capture = null;
let targetProject = null;
let targetProjects = [];
let lastUsedProjectId = "";
let mentionRange = null;
let suggestions = [];
let activeSuggestion = 0;
let suggestionTimer = 0;
let requestSerial = 0;
const selectedCategories = new Map();
const selectedTerms = new Map();

function setMessage(text = "", state = "") {
  message.textContent = text;
  message.className = `message picker-message ${state}`;
}

async function request(path, options = {}) {
  let lastError = null;
  for (const endpoint of BRIDGE_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2600);
    try {
      const response = await fetch(`${endpoint}${path}`, {cache: "no-store", ...options, signal: controller.signal});
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || "MoodBox connection failed.");
      return data;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  const text = String(lastError?.message || "");
  if (text && !/fetch|network|abort/i.test(text)) throw lastError;
  throw new Error("MoodBox background service is not running. Open MoodBox once or run Repair MoodBox.");
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function filenameFor(url, mime) {
  const supplied = cleanText(capture?.filename);
  if (supplied) return supplied;
  const name = String(url || "").split("?")[0].split("/").pop() || "";
  if (/\.(jpe?g|png)$/i.test(name)) return name;
  return `browser-reference${String(mime).toLowerCase() === "image/jpeg" ? ".jpg" : ".png"}`;
}

async function imageAsBase64(url) {
  if (capture?.imageBase64) return {base64: capture.imageBase64, mime: capture.imageMime || "image/png"};
  if (String(url || "").startsWith("data:image/")) {
    const [meta, data] = String(url).split(",", 2);
    return {base64: data || "", mime: (meta.match(/^data:([^;,]+)/) || [])[1] || "image/png"};
  }
  try {
    const response = await fetch(url, {credentials: "omit", cache: "no-store"});
    if (!response.ok) throw new Error(`Browser could not read this image (${response.status}).`);
    const blob = await response.blob();
    if (!blob.type.startsWith("image/")) throw new Error("The selected browser resource is not an image.");
    if (blob.size > 64 * 1024 * 1024) throw new Error("This image is larger than the 64 MB capture limit.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
    }
    return {base64: btoa(binary), mime: blob.type};
  } catch (directError) {
    if (!capture?.resource) throw directError;
    const resolved = await chrome.runtime.sendMessage({
      action:"moodbox-resolve-capture-image",
      resource:capture.resource,
      tabId:Number(capture.tabId || 0)
    });
    if (!resolved?.ok || !resolved.base64) throw new Error(resolved?.error || directError?.message || "Could not read this image.");
    capture.imageBase64 = resolved.base64;
    capture.imageMime = resolved.mime || "image/png";
    capture.imageUrl = resolved.resolvedUrl || capture.imageUrl;
    capture.filename = resolved.filename || capture.filename;
    return {base64:capture.imageBase64, mime:capture.imageMime};
  }
}

function previewSource() {
  if (capture?.imageBase64) return `data:${capture.imageMime || "image/png"};base64,${capture.imageBase64}`;
  return String(capture?.imageUrl || "");
}

function currentMention() {
  const caret = noteEditor.selectionStart;
  const before = noteEditor.value.slice(0, caret);
  const match = before.match(/(?:^|[\s(\[{,;])@([^@\n]*)$/);
  if (!match) return null;
  const query = String(match[1] || "");
  if (query.length > 80 || /[.!?]$/.test(query)) return null;
  const at = before.lastIndexOf("@", caret - 1);
  return at >= 0 ? {start: at, end: caret, query: query.trim()} : null;
}

function closeMentions() {
  mentionPanel.hidden = true;
  mentionRange = null;
  suggestions = [];
  activeSuggestion = 0;
  mentionList.replaceChildren();
}

function suggestionKey(item) {
  return `${item.kind}:${item.id || item.label}`;
}

function updateSummary() {
  if (!selectionSummary) return;
  const parts = [];
  if (selectedCategories.size) parts.push(`${selectedCategories.size} board item${selectedCategories.size === 1 ? "" : "s"}`);
  if (selectedTerms.size) parts.push(`${selectedTerms.size} vocabulary term${selectedTerms.size === 1 ? "" : "s"}`);
  selectionSummary.textContent = parts.length ? parts.join(" · ") : "No structured selections yet";
}

function syncSelectionsWithText() {
  const text = noteEditor.value.toLocaleLowerCase();
  for (const [key, item] of selectedCategories) {
    if (!text.includes(String(item.label || "").toLocaleLowerCase())) selectedCategories.delete(key);
  }
  for (const [key, item] of selectedTerms) {
    if (!text.includes(String(item.label || "").toLocaleLowerCase())) selectedTerms.delete(key);
  }
  updateSummary();
}

function renderSuggestions() {
  mentionList.replaceChildren();
  if (!suggestions.length) {
    const empty = document.createElement("div");
    empty.className = "mention-empty";
    empty.textContent = "No matching board item or vocabulary term.";
    mentionList.appendChild(empty);
    return;
  }
  suggestions.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mention-row";
    button.classList.toggle("active", index === activeSuggestion);
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", index === activeSuggestion ? "true" : "false");

    const label = document.createElement("strong");
    label.textContent = item.label;
    const meta = document.createElement("span");
    meta.textContent = item.kind === "category" ? "Board item" : (item.lens || item.group || "Design vocabulary");
    const description = document.createElement("small");
    description.textContent = item.description || (item.kind === "category" ? "Save this reference under this board item." : "");
    button.append(label, meta, description);
    button.addEventListener("pointerdown", event => event.preventDefault());
    button.addEventListener("click", () => insertSuggestion(index));
    mentionList.appendChild(button);
  });
  const active = mentionList.querySelector(".mention-row.active");
  active?.scrollIntoView?.({block: "nearest"});
}

function insertSuggestion(index) {
  const item = suggestions[index];
  if (!item || !mentionRange) return;
  const before = noteEditor.value.slice(0, mentionRange.start);
  const after = noteEditor.value.slice(mentionRange.end);
  const token = `${item.label}`;
  noteEditor.value = `${before}${token} ${after}`;
  const caret = before.length + token.length + 1;
  noteEditor.focus();
  noteEditor.setSelectionRange(caret, caret);

  const key = suggestionKey(item);
  if (item.kind === "category") selectedCategories.set(key, item);
  else selectedTerms.set(key, item);
  updateSummary();
  closeMentions();
}

async function loadSuggestions() {
  if (!targetProject?.id || !mentionRange) return;
  const serial = ++requestSerial;
  const query = mentionRange.query;
  mentionStatus.textContent = query ? `Suggestions for “${query}”` : "Board items and common design terms";

  const categoryRows = (targetProject.categories || [])
    .filter(category => !query || String(category.name || "").toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .map(category => ({
      kind: "category",
      id: category.id,
      label: category.name || "Board item",
      description: ""
    }));

  try {
    const selected = [...selectedTerms.values()].map(row => row.label).filter(Boolean).join("|");
    const data = await request(
      `/api/vocabulary?project_id=${encodeURIComponent(targetProject.id)}` +
      `&q=${encodeURIComponent(query)}&selected=${encodeURIComponent(selected)}&limit=60`
    );
    if (serial !== requestSerial || !mentionRange) return;
    const termRows = (Array.isArray(data.terms) ? data.terms : []).map(term => ({...term, kind: "term"}));
    suggestions = [...categoryRows, ...termRows].slice(0, 70);
    activeSuggestion = 0;
    renderSuggestions();
  } catch (error) {
    if (serial !== requestSerial) return;
    suggestions = categoryRows;
    activeSuggestion = 0;
    mentionStatus.textContent = categoryRows.length ? "Board items" : (error.message || "Vocabulary is unavailable.");
    renderSuggestions();
  }
}

function refreshMentionState() {
  syncSelectionsWithText();
  const range = currentMention();
  if (!range) {
    closeMentions();
    return;
  }
  mentionRange = range;
  mentionPanel.hidden = false;
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(loadSuggestions, 120);
}

function renderTargets() {
  targetSelect.replaceChildren();
  const rows = Array.isArray(targetProjects) ? targetProjects.filter(row => row?.id) : [];
  if (rows.length <= 1) {
    targetChooser.hidden = true;
    targetProject = rows[0] || null;
    target.textContent = targetProject?.name ? `Saving to: ${targetProject.name}` : "";
    return;
  }
  targetChooser.hidden = false;
  for (const project of rows) {
    const option = document.createElement("option");
    option.value = String(project.id);
    option.textContent = project.name || "MoodBox";
    targetSelect.appendChild(option);
  }
  const preferredId = String(capture?.projectId || lastUsedProjectId || "");
  const preferred = rows.find(row => String(row.id) === preferredId) || rows[0];
  targetSelect.value = String(preferred.id);
  targetProject = preferred;
  target.textContent = `Saving to: ${targetProject.name || "MoodBox"}`;
}

function selectTarget() {
  const id = String(targetSelect.value || "");
  targetProject = targetProjects.find(row => String(row.id) === id) || targetProjects[0] || null;
  if (targetProject?.id) target.textContent = `Saving to: ${targetProject.name || "MoodBox"}`;
}

async function initialise() {
  const captureId = new URLSearchParams(location.search).get("capture_id") || "";
  if (captureId) {
    try {
      const pending = await chrome.runtime.sendMessage({action:"moodbox-get-pending-capture", captureId});
      capture = pending?.capture || null;
    } catch (_) {}
  }
  if (!capture) {
    const stored = await chrome.storage.local.get("moodboxPendingCapture");
    capture = stored.moodboxPendingCapture || null;
  }
  if (!capture?.imageUrl) {
    setMessage("No image is waiting to be sent.", "error");
    send.disabled = true;
    return;
  }
  const src = previewSource();
  if (src) preview.src = src;
  try {
    const mode = await request("/api/capture-mode");
    targetProjects = Array.isArray(mode.projects) ? mode.projects.filter(row => row?.id) : [];
    lastUsedProjectId = String(mode.last_used_project_id || "");
    if (!targetProjects.length && mode.project?.id) targetProjects = [mode.project];
    if (!targetProjects.length) throw new Error("Activate MoodBox and create at least one MoodBox first.");
    renderTargets();
    const focusEditor = () => {
      try {
        window.focus();
        noteEditor.focus({preventScroll:true});
        noteEditor.setSelectionRange(noteEditor.value.length, noteEditor.value.length);
      } catch (_) {}
    };
    focusEditor();
    setTimeout(focusEditor, 0);
    setTimeout(focusEditor, 40);
  } catch (error) {
    setMessage(error.message || "Open MoodBox to connect.", "error");
    send.disabled = true;
  }
}

function taggedLine(label) {
  const token = `${String(label || "")}`.toLocaleLowerCase();
  const lines = noteEditor.value.split(/\n+/).map(line => cleanText(line)).filter(Boolean);
  return lines.find(line => line.toLocaleLowerCase().includes(token)) || "";
}

function structuredFocusNotes() {
  const grouped = new Map();
  for (const term of selectedTerms.values()) {
    const focus = cleanText(term.lens || term.group || "Visual Elements");
    const line = taggedLine(term.label);
    if (!focus || !line) continue;
    const previous = grouped.get(focus) || [];
    if (!previous.some(value => value.toLocaleLowerCase() === line.toLocaleLowerCase())) previous.push(line);
    grouped.set(focus, previous);
  }
  return [...grouped.entries()].map(([focus, lines]) => ({focus, note: lines.join("\n")}));
}

async function save() {
  if (!capture || !targetProject) return;
  closeMentions();
  send.disabled = true;
  setMessage("Sending…", "working");
  try {
    const image = await imageAsBase64(capture.imageUrl);
    const assignments = [...selectedCategories.values()].map(item => ({
      category_id: item.id,
      note: taggedLine(item.label)
    }));
    const insights = [...selectedTerms.values()].map(term => ({
      id: term.id,
      label: term.label,
      lens: term.lens || "",
      group: term.group || "",
      description: term.description || "",
      aliases: Array.isArray(term.aliases) ? term.aliases : [],
      source: term.source || "csv"
    }));
    await request("/api/add-image", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        project_id: targetProject.id,
        image_base64: image.base64,
        filename: filenameFor(capture.imageUrl, image.mime),
        source_url: capture.imageUrl,
        source_page_url: capture.pageUrl || "",
        source_title: "",
        source_caption: "",
        assignments,
        insights,
        focus_notes: structuredFocusNotes(),
        general_note: noteEditor.value.trim()
      })
    });
    await chrome.storage.local.remove("moodboxPendingCapture").catch(() => {});
    await chrome.runtime.sendMessage({action:"moodbox-clear-pending-capture", captureId:new URLSearchParams(location.search).get("capture_id") || ""}).catch(() => {});
    await chrome.runtime.sendMessage({
      action: "moodbox-show-toast",
      tabId: Number(capture.tabId || 0),
      projectName: targetProject.name || "MoodBox"
    });
    window.close();
  } catch (error) {
    setMessage(error.message || "Could not send this image.", "error");
    send.disabled = false;
  }
}

function closeWindow() { window.close(); }

noteEditor.addEventListener("input", refreshMentionState);
noteEditor.addEventListener("click", refreshMentionState);
noteEditor.addEventListener("keyup", event => {
  if (["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
  refreshMentionState();
});
noteEditor.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    save();
    return;
  }
  if (!mentionPanel.hidden && suggestions.length) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeSuggestion = (activeSuggestion + 1) % suggestions.length;
      renderSuggestions();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      activeSuggestion = (activeSuggestion - 1 + suggestions.length) % suggestions.length;
      renderSuggestions();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      insertSuggestion(activeSuggestion);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeMentions();
      return;
    }
  }
});

document.addEventListener("pointerdown", event => {
  if (!mentionPanel.hidden && !mentionPanel.contains(event.target) && event.target !== noteEditor) closeMentions();
});
send.addEventListener("click", save);
targetSelect.addEventListener("change", selectTarget);
el("cancel").addEventListener("click", closeWindow);
el("cancelTop").addEventListener("click", closeWindow);
initialise();
