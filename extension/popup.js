const BRIDGE = "http://127.0.0.1:57684";

const message = document.getElementById("message");
const statusDot = document.getElementById("statusDot");
const connectionText = document.getElementById("connectionText");
const moodboxProjectStatus = document.getElementById("moodboxProjectStatus");
let messageTimer = 0;

function setMessage(text = "", state = "") {
  message.textContent = text;
  message.className = `message ${state}`;
  clearTimeout(messageTimer);
  if (text) messageTimer = setTimeout(() => setMessage(""), 1200);
}

document.getElementById("batchDownload").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
    setMessage("Open a website to scan images", "error");
    return;
  }
  const button = document.getElementById("batchDownload");
  button.disabled = true;
  setMessage("Fetching page images…", "working");
  try {
    const response = await chrome.runtime.sendMessage({action: "moodboxDownload-open-batch", tabId: tab.id});
    if (!response?.ok) throw new Error(response?.error || "Could not scan this page.");
    window.close();
  } catch (error) {
    setMessage(error?.message || "Could not scan this page.", "error");
    button.disabled = false;
  }
});

document.getElementById("openLibrary").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

async function refreshMoodboxProjectStatus() {
  try {
    const response = await chrome.runtime.sendMessage({action: "moodbox-capture-state", fresh: true});
    if (response?.ok && response.active && response.projects?.length) {
      const count = response.projects.length;
      const names = response.projects.slice(0, 2).map(row => row.name || "MoodBox").join(" · ");
      moodboxProjectStatus.textContent = `Active: ${count} MoodBox${count === 1 ? "" : "es"}${names ? ` (${names})` : ""}`;
      moodboxProjectStatus.classList.add("active");
      return;
    }
  } catch (_) {}
  moodboxProjectStatus.textContent = "No project active in MoodBox desktop";
  moodboxProjectStatus.classList.remove("active");
}

(async () => {
  refreshMoodboxProjectStatus();

  try {
    const response = await fetch(`${BRIDGE}/health`, {cache: "no-store"});
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error();
    statusDot.classList.add("connected");
    connectionText.textContent = `${data.app || "MoodBox"} connected`;
  } catch (_) {
    statusDot.classList.remove("connected");
    connectionText.textContent = "Desktop app ready";
  }
})();
