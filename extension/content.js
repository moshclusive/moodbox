(() => {
  "use strict";
  try { document.getElementById("moodbox-unified-hover-actions-host")?.remove(); } catch (_) {}
  if (globalThis.__moodboxUnifiedContentV920) return;
  globalThis.__moodboxUnifiedContentV920 = true;

  const MIN_EDGE = 72;
  const MAX_CANDIDATES = 32;

  let currentTarget = null;
  let currentResource = null;
  let currentSignature = "";
  let lastTargetRect = null;
  let hideTimer = 0;
  let pointerFrame = 0;
  let lastPointer = {x: -1, y: -1};
  let overlayHovered = false;
  let currentPlacement = "";
  const inFlightActionKeys = new Set();
  let lastNativeContextTargetSignature = "";
  let lastRightClickTarget = null;

  const overlayHost = document.createElement("div");
  overlayHost.id = "moodbox-unified-hover-actions-host";
  overlayHost.setAttribute("aria-hidden", "true");
  overlayHost.style.cssText = [
    "all:initial",
    "position:fixed",
    "display:none",
    "z-index:2147483647",
    "pointer-events:auto",
    "margin:0",
    "padding:2px",
    "border:0",
    "background:transparent",
    "box-shadow:none"
  ].join(";");
  const shadow = overlayHost.attachShadow({mode: "open"});
  const style = document.createElement("style");
  style.textContent = `
    :host{all:initial}
    .overlay-inner{position:relative;display:inline-block}
    .actions{display:flex;align-items:center;gap:4px;margin:0;padding:3px;border:1px solid rgba(113,209,60,.38);border-radius:14px;background:rgba(14,18,15,.86);box-shadow:0 4px 16px rgba(0,0,0,.38);backdrop-filter:blur(8px)}
    button{all:unset;position:relative;display:grid;place-items:center;width:20px;height:20px;border-radius:10px;cursor:pointer;opacity:.92;transition:opacity .12s ease,background-color .12s ease,transform .12s ease}
    button:hover,button:focus-visible{opacity:1;background:rgba(113,209,60,.24);transform:scale(1.06)}
    button:disabled{cursor:wait;opacity:.38}
    img{display:block;width:15px;height:15px;object-fit:contain;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.48))}
    .tip{position:absolute;display:none;left:50%;top:26px;transform:translateX(-50%);white-space:nowrap;padding:4px 8px;border-radius:6px;background:rgba(14,18,15,.96);border:1px solid rgba(113,209,60,.3);color:#F2F7F2;font:600 11px/1.2 Inter,"Segoe UI",Arial,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.35);pointer-events:none}
    .target-menu{position:absolute;left:0;top:calc(100% + 6px);min-width:176px;max-width:240px;padding:5px;border:1px solid #2A3A2D;border-radius:10px;background:#121714;box-shadow:0 14px 34px rgba(0,0,0,.52);font:600 12px/1.25 Inter,"Segoe UI",Arial,sans-serif;color:#E8F1E8}
    .target-menu[hidden]{display:none}
    .target-row{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:6px 9px;border:0;border-radius:7px;background:transparent;color:#DCE8DC;cursor:pointer;box-sizing:border-box;text-align:left;opacity:1;transition:background .12s ease,color .12s ease}
    .target-row:hover,.target-row:focus-visible{background:#213224;color:#8DF05C;outline:none}
    .target-row img{width:17px;height:17px;object-fit:contain;filter:none;flex-shrink:0}
    .target-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    button:hover .tip,button:focus-visible .tip{display:block}
  `;
  const inner = document.createElement("div");
  inner.className = "overlay-inner";
  const actions = document.createElement("div");
  actions.className = "actions";
  const targetMenu = document.createElement("div");
  targetMenu.className = "target-menu";
  targetMenu.hidden = true;
  inner.append(actions, targetMenu);
  shadow.append(style, inner);
  const attachOverlayHost = () => {
    if (document.documentElement && !overlayHost.isConnected) {
      document.documentElement.appendChild(overlayHost);
    }
  };
  if (document.documentElement) attachOverlayHost();
  else document.addEventListener("DOMContentLoaded", attachOverlayHost, {once:true});

  function normalizeHost(value) {
    return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  }



  const DOWNLOAD_DEFAULTS = {
    downloadHoverEnabled: false,
    downloadAll: true,
    downloadSites: ["instagram.com", "youtube.com", "youtu.be"]
  };
  let downloadSettingsReady = false;
  let downloadHoverEnabled = true;
  let downloadAllEnabled = false;
  let downloadSites = [];

  let moodboxProjectActive = false;
  let moodboxProjectName = "MoodBox";
  let moodboxProjects = [];
  let moodboxStateCheckedAt = 0;
  let moodboxStateRequest = null;

  function normalizedSites(value) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[,;\s]+/);
    return [...new Set(source.map(normalizeHost).filter(host => host && /^[a-z0-9.-]+$/i.test(host) && host.includes(".")))];
  }

  function hostMatches(list, host) {
    const clean = normalizeHost(host);
    if (!clean) return false;
    return normalizedSites(list).some(value => clean === value || clean.endsWith(`.${value}`));
  }

  function downloadEnabledForPage() {
    if (!downloadSettingsReady || !downloadHoverEnabled) return false;
    if (downloadAllEnabled) return true;
    return hostMatches(downloadSites, location.hostname);
  }

  async function loadDownloadSettings() {
    try {
      const stored = await chrome.storage.local.get(DOWNLOAD_DEFAULTS);
      downloadHoverEnabled = stored.downloadHoverEnabled !== false;
      downloadAllEnabled = Boolean(stored.downloadAll);
      downloadSites = normalizedSites(stored.downloadSites ?? DOWNLOAD_DEFAULTS.downloadSites);
    } catch (_) {
      downloadHoverEnabled = Boolean(DOWNLOAD_DEFAULTS.downloadHoverEnabled);
      downloadAllEnabled = Boolean(DOWNLOAD_DEFAULTS.downloadAll);
      downloadSites = [...DOWNLOAD_DEFAULTS.downloadSites];
    } finally {
      downloadSettingsReady = true;
      if (currentTarget) renderOverlay();
    }
  }

  function isPlayingVideo(video) {
    return Boolean(
      video instanceof HTMLVideoElement &&
      video.isConnected &&
      !video.paused &&
      !video.ended &&
      Number(video.readyState || 0) >= 2
    );
  }

  function targetRelatedToVideo(target, video) {
    if (!(target instanceof Element) || !(video instanceof HTMLVideoElement)) return false;
    if (target === video || target.contains?.(video) || video.contains?.(target)) return true;
    const targetRect = target.getBoundingClientRect?.();
    const videoRect = video.getBoundingClientRect?.();
    if (targetRect && videoRect && overlapRatio(targetRect, videoRect) > .35) return true;
    const commonRoot = target.closest?.(
      "figure,article,li,[role='article'],[role='dialog']," +
      "[data-testid*='video'],[data-automation*='video'],[class*='video'],[class*='Video']"
    );
    return Boolean(commonRoot && commonRoot.contains(video));
  }

  function playingVideoForTarget(target) {
    if (!(target instanceof Element)) return null;
    if (isPlayingVideo(target)) return target;

    const associated = associatedVideoElement(target);
    if (isPlayingVideo(associated)) return associated;

    const roots = [
      target.closest?.("figure,article,li,[role='article'],[role='dialog'],[data-testid*='video'],[data-automation*='video'],[class*='video'],[class*='Video']"),
      target.parentElement,
      target.parentElement?.parentElement
    ].filter(Boolean);
    const seen = new Set();
    for (const root of roots) {
      for (const video of [...(root.querySelectorAll?.("video") || [])]) {
        if (seen.has(video)) continue;
        seen.add(video);
        if (isPlayingVideo(video) && targetRelatedToVideo(target, video)) return video;
      }
    }
    return null;
  }

  function targetBlockedByPlayingVideo(target = currentTarget) {
    return Boolean(playingVideoForTarget(target));
  }

  function moodboxCompatibleTarget(target) {
    return Boolean(target && !(target instanceof HTMLVideoElement) && !targetBlockedByPlayingVideo(target));
  }

  function videoResource(resource = currentResource) {
    const kind = String(resource?.mediaKind || resource?.kind || "").toLowerCase();
    return kind === "video" || kind === "video-page" || kind === "reel" || kind === "short";
  }

  function downloadCompatibleTarget(target, resource = currentResource) {
    if (!target || target instanceof HTMLVideoElement || videoResource(resource) || targetBlockedByPlayingVideo(target)) return false;
    try { if (targetLikelySocialVideo(target)) return false; } catch (_) {}
    return true;
  }

  function actionState() {
    const videoTarget = Boolean(
      currentTarget instanceof HTMLVideoElement ||
      videoResource(currentResource) ||
      currentResource?.videoThumbnail ||
      targetLikelySocialVideo(currentTarget)
    );
    if (videoTarget) {
      return {download:false, thumbnail:false, moodbox:false};
    }
    if (targetBlockedByPlayingVideo(currentTarget)) return {download:false, thumbnail:false, moodbox:false};
    return {
      download: Boolean(downloadEnabledForPage() && downloadCompatibleTarget(currentTarget, currentResource)),
      thumbnail:false,
      moodbox: Boolean(moodboxProjectActive && moodboxCompatibleTarget(currentTarget, currentResource))
    };
  }

  async function refreshMoodboxState(force = false) {
    const now = Date.now();
    if (!force && now - moodboxStateCheckedAt < 2500) return moodboxProjectActive;
    if (moodboxStateRequest) return moodboxStateRequest;
    moodboxStateRequest = chrome.runtime.sendMessage({action:"moodbox-capture-state", fresh:force})
      .then(response => {
        const previous = moodboxProjectActive;
        moodboxProjectActive = Boolean(response?.ok && response?.active);
        moodboxProjects = Array.isArray(response?.projects) ? response.projects.filter(row => row?.id) : [];
        moodboxProjectName = String(response?.project?.name || moodboxProjects[0]?.name || "MoodBox");
        moodboxStateCheckedAt = Date.now();
        if (currentTarget && (previous !== moodboxProjectActive || overlayHost.style.display === "none")) renderOverlay();
        return moodboxProjectActive;
      })
      .catch(() => {moodboxProjectActive=false;moodboxProjects=[];moodboxStateCheckedAt=Date.now();return false;})
      .finally(() => {
        moodboxStateRequest=null;
        if (currentTarget && overlayHost.style.display === "none") renderOverlay();
      });
    return moodboxStateRequest;
  }

  function absoluteUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw === "none") return "";
    if (/^(?:data:(?:image|font|application|audio|video|text)\/|blob:)/i.test(raw)) return raw;
    try {
      const url = new URL(raw, document.baseURI);
      return /^https?:$/i.test(url.protocol) ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function imageHref(value) {
    const url = absoluteUrl(value);
    if (!url) return "";
    if (/^(?:data:image\/|blob:)/i.test(url)) return url;
    try {
      const parsed = new URL(url);
      return /\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)(?:$|[?#])/i.test(parsed.pathname + parsed.search) ? url : "";
    } catch (_) {
      return "";
    }
  }

  function parseSrcset(value) {
    const rows = [];
    for (const part of String(value || "").split(/,(?=\s*(?:https?:|\/|\.\/|\.\.\/))/i)) {
      const bits = part.trim().split(/\s+/);
      const url = absoluteUrl(bits[0]);
      if (!url) continue;
      const descriptor = bits[1] || "";
      let score = 1;
      if (/\d+w$/i.test(descriptor)) score = Number.parseInt(descriptor, 10) || 1;
      else if (/\d+(?:\.\d+)?x$/i.test(descriptor)) score = (Number.parseFloat(descriptor) || 1) * 10000;
      rows.push({url, score});
    }
    return rows.sort((a, b) => b.score - a.score);
  }

  function backgroundUrls(element) {
    try {
      const value = String(getComputedStyle(element).backgroundImage || "");
      return [...value.matchAll(/url\(["']?(.*?)["']?\)/gi)].map(match => absoluteUrl(match[1])).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function addCandidate(store, value, rank = 1, authoritative = false, source = "page") {
    const url = absoluteUrl(value);
    if (!url || url.startsWith("chrome-extension:")) return;
    const old = store.get(url);
    const candidate = {url, rank: Number(rank) || 1, authoritative: Boolean(authoritative), source: String(source || "page")};
    if (!old || candidate.rank > old.rank || (candidate.authoritative && !old.authoritative)) store.set(url, candidate);
  }

  function addPinterestCandidates(store, sourceUrl) {
    const url = absoluteUrl(sourceUrl);
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (!/(?:^|\.)pinimg\.com$/i.test(parsed.hostname)) return;
      for (const [token, rank, auth] of [
        ["originals", 2_500_000, true],
        ["1200x", 2_300_000, false],
        ["736x", 2_100_000, false],
        ["564x", 1_900_000, false]
      ]) {
        const upgraded = new URL(parsed.href);
        upgraded.pathname = parsed.pathname.replace(
          /\/(?:60x60|75x75_RS|136x136|170x|236x|280x280_RS|474x|564x|736x|1000x|1200x|originals)\//i,
          `/${token}/`
        );
        addCandidate(store, upgraded.href, rank, auth, `pinterest-${token}`);
      }
    } catch (_) {}
  }

  function addStockCandidates(store, sourceUrl) {
    const url = absoluteUrl(sourceUrl);
    if (!url) return;
    try {
      const parsed = new URL(url);
      const host = normalizeHost(parsed.hostname);

      if (host.endsWith("shutterstock.com") || host.endsWith("shutterstockcdn.com")) {
        const sourcePath = parsed.pathname;
        for (const [from, to, rank] of [
          [/-(?:260nw|300w|400w|500w|600w|750w)-/i, "-2000w-", 2_480_000],
          [/-(?:260nw|300w|400w|500w|600w|750w)-/i, "-1500w-", 2_450_000],
          [/\/(?:260nw|300w|400w|500w|600w|750w)\//i, "/2000w/", 2_400_000],
          [/\/(?:260nw|300w|400w|500w|600w|750w)\//i, "/1500w/", 2_350_000]
        ]) {
          if (!from.test(sourcePath)) continue;
          const upgraded = new URL(parsed.href);
          upgraded.pathname = sourcePath.replace(from, to);
          addCandidate(store, upgraded.href, rank, false, "shutterstock-large-preview");
        }
      }

      if (host.endsWith("ftcdn.net") || host.endsWith("stock.adobe.com")) {
        const path = parsed.pathname;
        for (const [size, rank] of [["2000_F_", 2_480_000], ["1000_F_", 2_400_000], ["500_F_", 2_200_000]]) {
          if (!/(?:240_F_|500_F_|1000_F_|2000_F_)/i.test(path)) continue;
          const upgraded = new URL(parsed.href);
          upgraded.pathname = path.replace(/(?:240_F_|500_F_|1000_F_|2000_F_)/i, size);
          addCandidate(store, upgraded.href, rank, false, "adobestock-large-preview");
        }
      }

      if (host.endsWith("istockphoto.com") || host.endsWith("gettyimages.com")) {
        if (parsed.searchParams.has("s")) {
          const u2048 = new URL(parsed.href);
          u2048.searchParams.set("s", "2048x2048");
          u2048.searchParams.delete("w");
          addCandidate(store, u2048.href, 2_480_000, false, "istock-2048");

          const u1024 = new URL(parsed.href);
          u1024.searchParams.set("s", "1024x1024");
          u1024.searchParams.delete("w");
          addCandidate(store, u1024.href, 2_400_000, false, "istock-1024");
        }
      }

      if (host.endsWith("googleusercontent.com")) {
        const s0Url = parsed.href.replace(/=(?:s\d+|w\d+-h\d+.*|w\d+|h\d+)(?:-no|-rw|-p)?$/i, "=s0");
        if (s0Url !== parsed.href) {
          addCandidate(store, s0Url, 2_800_000, false, "googleusercontent-s0");
        }
      }

      if (host.endsWith("images.unsplash.com")) {
        const unsp = new URL(parsed.href);
        unsp.searchParams.set("q", "100");
        unsp.searchParams.set("w", "3840");
        unsp.searchParams.delete("fit");
        unsp.searchParams.delete("crop");
        addCandidate(store, unsp.href, 2_500_000, false, "unsplash-max");
      }
    } catch (_) {}
  }

  function addGenericCdnCandidates(store, sourceUrl) {
    const raw = String(sourceUrl || "").trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return;
    try {
      const url = new URL(raw);
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
        ["w","width","maxwidth","h","height","maxheight","crop","rect","fit","resize","size"].forEach(p => uNoCrop.searchParams.delete(p));
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
    } catch (_) {}
  }

  function addBehanceCandidates(store, sourceUrl) {
    const url = absoluteUrl(sourceUrl);
    if (!url) return;
    try {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/\/project_modules\/([^/]+)\//i);
      if (!match) return;
      for (const [variant, rank, authoritative] of [
        ["source", 2_300_000, true],
        ["max_3840", 2_200_000, false],
        ["max_1920", 2_100_000, false],
        ["1400", 2_000_000, false],
        ["max_1200", 1_900_000, false],
        ["fs", 1_800_000, false]
      ]) {
        const candidate = new URL(parsed.href);
        candidate.pathname = parsed.pathname.replace(/\/project_modules\/[^/]+\//i, `/project_modules/${variant}/`);
        addCandidate(store, candidate.href, rank, authoritative, `behance-${variant}`);
      }
    } catch (_) {}
  }


  function mediaUrlIdentity(value) {
    const url = absoluteUrl(value);
    if (!url) return "";
    try {
      const parsed = new URL(url);
      const basename = decodeURIComponent(parsed.pathname.split("/").pop() || "")
        .replace(/\.(?:avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i, "")
        .replace(/^(?:p|s|c)\d+(?:x\d+)?[-_]/i, "")
        .toLowerCase();
      const longIds = basename.match(/\d{8,}/g) || [];
      if (longIds.length) return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}:${longIds.join("-")}`;
      return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}:${basename}`;
    } catch (_) {
      return "";
    }
  }

  function urlsMatch(u1, u2) {
    if (!u1 || !u2) return false;
    if (u1 === u2) return true;
    try {
      if (decodeURIComponent(u1) === decodeURIComponent(u2)) return true;
    } catch (_) {}
    try {
      const p1 = new URL(u1, document.baseURI);
      const p2 = new URL(u2, document.baseURI);
      if (p1.origin !== p2.origin) return false;
      const path1 = decodeURIComponent(p1.pathname).replace(/\/+$/, "");
      const path2 = decodeURIComponent(p2.pathname).replace(/\/+$/, "");
      if (path1 && path1 === path2) return true;
    } catch (_) {}
    const id1 = mediaUrlIdentity(u1);
    const id2 = mediaUrlIdentity(u2);
    if (id1 && id2 && id1 === id2) return true;
    return false;
  }

  function addMetaCdnCandidates(store, sourceUrl) {
    const url = absoluteUrl(sourceUrl);
    if (!url) return;
    try {
      const parsed = new URL(url);
      const host = normalizeHost(parsed.hostname);
      if (!/(?:^|\.)(?:fbcdn\.net|cdninstagram\.com|fbsbx\.com)$/i.test(host)) return;

      // Meta commonly serves the feed-sized rendition through the `stp`
      // transform while keeping the same signed source URL. Removing only the
      // resize/crop transform preserves authentication parameters and lets the
      // CDN return the largest available bytes for this exact media item.
      const original = new URL(parsed.href);
      let changed = false;
      for (const key of [...original.searchParams.keys()]) {
        if (/^(?:stp|w|h|width|height|size|crop|fit|dpr|quality|q)$/i.test(key)) {
          original.searchParams.delete(key);
          changed = true;
        }
      }
      const rewrittenPath = original.pathname
        .replace(/\/(?:p|s|c)\d+(?:x\d+)?(?:_[^/]+)?\//gi, "/")
        .replace(/_(?:p|s|c)\d+(?:x\d+)?(?=_[a-z0-9]+\.(?:jpe?g|png|webp|avif)$)/i, "");
      if (rewrittenPath !== original.pathname) {
        original.pathname = rewrittenPath;
        changed = true;
      }
      if (changed) addCandidate(store, original.href, 3_150_000, false, "meta-original-transform-free");

      // Some feed URLs keep the same signed media path but expose only a small
      // `stp` rendition. Probe larger transforms as fallbacks; the background
      // resolver measures the returned pixels and keeps only the largest valid
      // bytes for this exact image.
      const stp = parsed.searchParams.get("stp");
      if (stp) {
        for (const [value, rank] of [
          ["dst-jpg_p2048x2048_tt6", 3_145_000],
          ["dst-jpg_s2048x2048_tt6", 3_140_000],
          ["dst-jpg_p1440x1440_tt6", 3_135_000],
          ["dst-jpg_s1440x1440_tt6", 3_130_000]
        ]) {
          const larger = new URL(parsed.href);
          larger.searchParams.set("stp", value);
          addCandidate(store, larger.href, rank, false, "meta-large-transform");
        }
      }
      if (/\/(?:p|s|c)\d+(?:x\d+)?(?:_[^/]+)?\//i.test(parsed.pathname)) {
        for (const [size, rank] of [["p2048x2048", 3_125_000], ["s2048x2048", 3_120_000], ["p1440x1440", 3_115_000]]) {
          const larger = new URL(parsed.href);
          larger.pathname = parsed.pathname.replace(/\/(?:p|s|c)\d+(?:x\d+)?(?:_[^/]+)?\//i, `/${size}/`);
          addCandidate(store, larger.href, rank, false, "meta-large-path");
        }
      }
    } catch (_) {}
  }

  function addMatchingContainerCandidates(store, element) {
    if (!(element instanceof Element)) return;
    const existingIds = new Set([...store.values()].map(row => mediaUrlIdentity(row.url)).filter(Boolean));
    if (!existingIds.size) return;
    const root = nearestContainer(element);
    const targetRect = element.getBoundingClientRect?.();
    const rows = [...(root?.querySelectorAll?.("img,picture source") || [])].slice(0, 120);
    for (const node of rows) {
      const urls = [];
      if (node instanceof HTMLImageElement) {
        urls.push(node.currentSrc, node.src);
        for (const row of parseSrcset(node.srcset || "")) urls.push(row.url);
        for (const name of ["data-src","data-original","data-original-src","data-full","data-full-src","data-zoom-image","data-hi-res-src","data-high-res-src","data-large-image"]) urls.push(node.getAttribute(name));
      } else {
        for (const row of parseSrcset(node.getAttribute?.("srcset") || "")) urls.push(row.url);
      }
      const rect = node.getBoundingClientRect?.();
      const overlaps = targetRect && rect ? overlapRatio(targetRect, rect) > .55 : false;
      for (const value of urls) {
        const id = mediaUrlIdentity(value);
        if (!id || (!existingIds.has(id) && !overlaps)) continue;
        addCandidate(store, value, 2_750_000 + Number(node.naturalWidth || 0) * Number(node.naturalHeight || 0), false, "matching-container-media");
        addMetaCdnCandidates(store, value);
      }
    }
  }

  function videoIdFromUrl(value) {
    try {
      const url = new URL(value, location.href);
      const host = normalizeHost(url.hostname);
      if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || "";
      if (host.endsWith("youtube.com")) {
        const queryId = url.searchParams.get("v");
        if (queryId) return queryId;
        return url.pathname.match(/\/(?:embed|shorts|live)\/([^/?#]+)/i)?.[1] || "";
      }
    } catch (_) {}
    return "";
  }

  function videoIdFromThumbnail(value) {
    const source = String(value || "");
    return source.match(/\/(?:vi|vi_webp)\/([^/]+)\//i)?.[1] || "";
  }

  function youtubeContext(element) {
    const cleanTitle = value => String(value || "")
      .replace(/\s+/g, " ")
      .replace(/\s*-\s*YouTube\s*$/i, "")
      .trim();
    const containers = [
      element.closest("ytd-rich-item-renderer"),
      element.closest("ytd-video-renderer"),
      element.closest("ytd-grid-video-renderer"),
      element.closest("ytd-compact-video-renderer"),
      element.closest("ytd-playlist-video-renderer"),
      element.closest("ytd-reel-item-renderer"),
      element.closest("yt-lockup-view-model"),
      element.closest("ytm-shorts-lockup-view-model"),
      element.closest("#dismissible"),
      element.closest("article")
    ].filter(Boolean);
    const container = containers[0] || element.parentElement;
    const selectors = ["a#thumbnail[href]", "a[href*='/watch?v=']", "a[href*='/shorts/']", "a[href*='youtu.be/']"];
    let link = null;
    for (const selector of selectors) {
      link = element.closest(selector) || container?.querySelector?.(selector);
      if (link) break;
    }
    const imageSource = element instanceof HTMLImageElement ? (element.currentSrc || element.src) : "";
    const id = videoIdFromUrl(link?.href || "") || videoIdFromThumbnail(imageSource) || videoIdFromUrl(location.href);
    if (!id) return null;

    const cardTitleNode = container?.querySelector?.(
      "#video-title, #video-title-link, a#video-title-link, h3 a, " +
      "yt-formatted-string#video-title, [data-title-no-tooltip]"
    );
    const watchTitleNode = document.querySelector(
      "ytd-watch-metadata h1 yt-formatted-string, ytd-watch-metadata h1, " +
      "#title h1 yt-formatted-string, #title h1"
    );
    const pageTitleMeta = document.querySelector(
      'meta[property="og:title"], meta[name="title"], meta[name="twitter:title"]'
    );
    const onCurrentVideo = videoIdFromUrl(location.href) === id;
    let title = cleanTitle(
      cardTitleNode?.getAttribute?.("title") ||
      cardTitleNode?.getAttribute?.("aria-label") ||
      cardTitleNode?.textContent ||
      (onCurrentVideo ? watchTitleNode?.textContent : "") ||
      (onCurrentVideo ? pageTitleMeta?.getAttribute?.("content") : "") ||
      element.getAttribute?.("alt") ||
      ""
    );
    if ((!title || /^(?:download|youtube|youtube video)$/i.test(title)) && onCurrentVideo) {
      title = cleanTitle(document.title);
    }
    return {id, title: title || `YouTube-${id}`};
  }

  function addYouTubeCandidates(store, context) {
    if (!context?.id) return;
    const base = `https://i.ytimg.com/vi/${encodeURIComponent(context.id)}`;
    addCandidate(store, `${base}/maxresdefault.jpg`, 3_500_000, true, "youtube-maxres");
    addCandidate(store, `${base}/sddefault.jpg`, 3_000_000, false, "youtube-sd");
    addCandidate(store, `${base}/hq720.jpg`, 2_800_000, false, "youtube-hq720");
    addCandidate(store, `${base}/hqdefault.jpg`, 2_500_000, false, "youtube-hq");
    addCandidate(store, `${base}/mqdefault.jpg`, 2_000_000, false, "youtube-mq");
  }

  function visibleRect(element) {
    if (!(element instanceof Element) || !element.isConnected) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width < MIN_EDGE || rect.height < MIN_EDGE) return null;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return null;
    try {
      const computed = getComputedStyle(element);
      if (computed.visibility === "hidden" || computed.display === "none" || Number(computed.opacity) === 0) return null;
    } catch (_) {}
    return rect;
  }

  function rectContains(rect, x, y, pad = 0) {
    return Boolean(rect) && x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
  }

  function mediaElementAtPoint(x, y, preferredTarget = null) {
    if (preferredTarget instanceof Element && preferredTarget.isConnected) {
      if (preferredTarget.matches("img, video, canvas") || (preferredTarget.localName === "image" && preferredTarget.namespaceURI?.includes("svg"))) {
        return preferredTarget;
      }
      const picImg = preferredTarget.closest("picture")?.querySelector("img");
      if (picImg) return picImg;
      const childImg = preferredTarget.querySelector("img, video, canvas");
      if (childImg && visibleRect(childImg) && rectContains(visibleRect(childImg), x, y)) return childImg;
      if (backgroundUrls(preferredTarget).length) return preferredTarget;
    }

    const stack = document.elementsFromPoint(x, y);
    if (!stack || !stack.length) return null;

    // 1. Direct media element in the hit-test stack containing (x, y)
    for (let i = 0; i < stack.length; i++) {
      const node = stack[i];
      if (!(node instanceof Element) || node === overlayHost || node.closest?.("#moodbox-unified-hover-actions-host")) continue;

      if (node.matches("video, img, canvas") || (node.localName === "image" && node.namespaceURI?.includes("svg"))) {
        const rect = visibleRect(node);
        if (rect && rectContains(rect, x, y)) {
          return node;
        }
      }

      if (node.matches("picture")) {
        const img = node.querySelector("img");
        if (img) {
          const rect = visibleRect(img);
          if (rect && rectContains(rect, x, y)) return img;
        }
      }
    }

    // 2. Direct child media of elements in the stack containing (x, y)
    for (let i = 0; i < stack.length; i++) {
      const node = stack[i];
      if (!(node instanceof Element) || node === overlayHost || node.closest?.("#moodbox-unified-hover-actions-host")) continue;

      const directImg = node.querySelector("img, video, canvas");
      if (directImg) {
        const rect = visibleRect(directImg);
        if (rect && rectContains(rect, x, y)) return directImg;
      }
    }

    // 3. CSS background-image on elements directly under the point
    for (let i = 0; i < stack.length; i++) {
      const node = stack[i];
      if (!(node instanceof Element) || node === overlayHost || node.closest?.("#moodbox-unified-hover-actions-host")) continue;
      if (backgroundUrls(node).length) {
        const rect = visibleRect(node);
        if (rect && rectContains(rect, x, y)) return node;
      }
    }

    // 4. Overlays on specific platforms (Pinterest pin, Stock card, Google image)
    for (let i = 0; i < stack.length; i++) {
      const node = stack[i];
      if (!(node instanceof Element) || node === overlayHost || node.closest?.("#moodbox-unified-hover-actions-host")) continue;

      const card = node.closest?.(
        "[data-test-id='pin'], [data-test-id='pinWrapper'], [data-test-id='closeup-body'], " +
        "[data-testid*='asset'], [data-automation*='asset'], " +
        "figure, [role='dialog'], .islib"
      );
      if (card) {
        const medias = [...card.querySelectorAll("img, video, canvas")];
        for (const media of medias) {
          const rect = visibleRect(media);
          if (rect && rectContains(rect, x, y, 12)) return media;
        }
        if (!card.matches("article, [role='article'], body, main, section")) {
          const cardRect = visibleRect(card);
          if (cardRect && rectContains(cardRect, x, y, 4) && medias.length === 1) {
            const rect = visibleRect(medias[0]);
            if (rect) return medias[0];
          }
        }
      }
    }

    return null;
  }

  function cleanText(value, limit = 180) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim()
      .slice(0, limit);
  }

  function stripAccessibilityDescription(value, limit = 180) {
    let text = cleanText(value, 600);
    if (!text) return "";

    // Instagram and several social sites expose machine-generated accessibility
    // descriptions inside image alt text. They are useful for screen readers but
    // produce unusable filenames such as "Photo by ... May be a graphic of ...".
    text = text
      .replace(/^(?:this|the)\s+(?:image\s+)?may\s+contain\s*[-:–—]?\s*/i, "")
      .replace(/^photo by\s+.+?\s+on\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\.?\s*/i, "")
      .replace(/^photo by\s+.+?\.?\s*(?=may be|might be|image may|the image may)/i, "")
      .replace(/(?:^|[.!?]\s+)(?:may be|might be|image may contain|the image may contain|this image may contain|possibly)\b[\s\S]*$/i, "")
      .replace(/(?:^|[.!?]\s+)no photo description available\.?$/i, "")
      .replace(/(?:^|[.!?]\s+)photo shared by\s+[\s\S]*$/i, "")
      .trim();

    if (/^(?:may be|might be|image may|the image may|this image may|no photo description)/i.test(text)) return "";
    return cleanText(text, limit);
  }

  function usefulSocialCaption(value, limit = 92) {
    const text = stripAccessibilityDescription(value, 320);
    if (!text) return "";
    if (/^(?:photo|image|picture|post|reel|video)\s+by\b/i.test(text)) return "";
    if (/^(?:liked by|view all|follow|sponsored|suggested for you)\b/i.test(text)) return "";
    return cleanText(text, limit);
  }

  function basenameFromUrl(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      return decodeURIComponent(url.pathname.split("/").pop() || "").trim();
    } catch (_) {
      return "";
    }
  }

  function firstUsefulText(nodes, limit = 180) {
    for (const node of nodes || []) {
      const value = cleanText(
        node?.getAttribute?.("content") ||
        node?.getAttribute?.("title") ||
        node?.getAttribute?.("aria-label") ||
        node?.textContent ||
        "",
        limit
      );
      if (value && !/^(?:image|photo|picture|download|open|view)$/i.test(value)) return value;
    }
    return "";
  }

  function overlapRatio(first, second) {
    if (!first || !second) return 0;
    const left = Math.max(first.left, second.left);
    const top = Math.max(first.top, second.top);
    const right = Math.min(first.right, second.right);
    const bottom = Math.min(first.bottom, second.bottom);
    if (right <= left || bottom <= top) return 0;
    const intersection = (right - left) * (bottom - top);
    const smaller = Math.max(1, Math.min(first.width * first.height, second.width * second.height));
    return intersection / smaller;
  }

  function detailSelectorsForHost(host = normalizeHost(location.hostname)) {
    const selectors = [];
    if (host.endsWith("shutterstock.com")) {
      selectors.push(
        "a[href*='/image-photo/']", "a[href*='/image-vector/']",
        "a[href*='/image-illustration/']", "a[href*='/image-3d/']"
      );
    } else if (host.endsWith("stock.adobe.com")) {
      selectors.push("a[href*='/images/']");
    } else if (host.endsWith("gettyimages.com") || host.endsWith("istockphoto.com")) {
      selectors.push("a[href*='/detail/']", "a[href*='/photo/']", "a[href*='/illustration/']", "a[href*='/vector/']", "a[href*='-id']");
    } else if (host.endsWith("pinterest.com") || host === "pin.it") {
      selectors.push("a[href*='/pin/']");
    } else if (host.endsWith("behance.net")) {
      selectors.push("a[href*='/gallery/']");
    } else if (host.endsWith("instagram.com")) {
      selectors.push("a[href*='/p/']", "a[href*='/reel/']", "a[href*='/tv/']");
    } else if (host.endsWith("facebook.com") || host === "fb.com") {
      selectors.push("a[href*='/photo/?fbid=']", "a[href*='/photos/']", "a[href*='/reel/']", "a[href*='/watch/']", "a[href*='/videos/']");
    } else if (host.endsWith("youtube.com") || host === "youtu.be") {
      selectors.push("a[href*='/watch?v=']", "a[href*='/shorts/']");
    }
    selectors.push(
      "a[href*='dribbble.com/shots/']",
      "a[href*='freepik.com/'][href*='_']"
    );
    return selectors;
  }

  function relevantLinkForElement(element, selector) {
    const direct = element.closest?.(selector);
    if (direct) return direct;
    const targetRect = element.getBoundingClientRect?.();
    let ancestor = element.parentElement;
    for (let depth = 0; depth < 9 && ancestor; depth += 1, ancestor = ancestor.parentElement) {
      const links = [...(ancestor.querySelectorAll?.(selector) || [])];
      let best = null;
      let bestScore = 0;
      for (const link of links) {
        if (link.contains(element)) return link;
        const rect = link.getBoundingClientRect?.();
        const overlap = overlapRatio(targetRect, rect);
        const centerX = targetRect ? (targetRect.left + targetRect.right) / 2 : -1;
        const centerY = targetRect ? (targetRect.top + targetRect.bottom) / 2 : -1;
        const containsCenter = rect && centerX >= rect.left && centerX <= rect.right && centerY >= rect.top && centerY <= rect.bottom;
        const score = overlap * 1000 + (containsCenter ? 500 : 0) - depth;
        if (score > bestScore) {
          best = link;
          bestScore = score;
        }
      }
      if (best && bestScore >= 120) return best;
      if (targetRect) {
        const ancestorRect = ancestor.getBoundingClientRect?.();
        const targetArea = Math.max(1, targetRect.width * targetRect.height);
        const ancestorArea = Math.max(1, Number(ancestorRect?.width || 0) * Number(ancestorRect?.height || 0));
        if (depth >= 4 && ancestorArea > targetArea * 24) break;
      }
    }
    return null;
  }

  function nearestContainer(element) {
    const host = normalizeHost(location.hostname);
    for (const selector of detailSelectorsForHost(host)) {
      const link = relevantLinkForElement(element, selector);
      if (!link) continue;
      const card = link.closest?.(
        "figure,article,li,[role='article'],[data-testid*='asset'],[data-automation*='asset']," +
        "[data-testid*='Asset'],[data-automation*='Asset']"
      );
      return card || link.parentElement || link;
    }
    const selectors = [];
    if (host.endsWith("instagram.com")) selectors.push("article", "div[role='presentation']");
    if (host.endsWith("pinterest.com") || host === "pin.it") selectors.push("[data-test-id='pin']", "[data-test-id='pinWrapper']", "article");
    if (host.endsWith("behance.net")) selectors.push("[class*='Project-module']", "[class*='ProjectModule']", "[class*='Project-cover']", "article", "figure");
    selectors.push("figure", "article", "li", "[role='article']");
    for (const selector of selectors) {
      const container = element.closest?.(selector);
      if (container) return container;
    }
    return element.parentElement || element;
  }

  function detailPageUrls(element) {
    const urls = [];
    const host = normalizeHost(location.hostname);
    const current = absoluteUrl(location.href);
    const currentPath = (() => { try { return new URL(current).pathname; } catch (_) { return ""; } })();
    const currentIsDetail =
      (host.endsWith("shutterstock.com") && /\/(?:image-photo|image-vector|image-illustration|image-3d)\//i.test(currentPath)) ||
      (host.endsWith("stock.adobe.com") && /\/images\//i.test(currentPath)) ||
      ((host.endsWith("gettyimages.com") || host.endsWith("istockphoto.com")) && /\/(?:detail|photo|vector|illustration)\//i.test(currentPath)) ||
      (host.endsWith("behance.net") && /\/gallery\//i.test(currentPath)) ||
      (host.endsWith("instagram.com") && /\/(?:p|reel|tv)\//i.test(currentPath)) ||
      (host.endsWith("facebook.com") && /\/(?:photo|photos|reel|watch|videos?)\b/i.test(currentPath)) ||
      ((host.endsWith("pinterest.com") || host === "pin.it") && /\/pin\//i.test(currentPath));
    if (current && currentIsDetail) urls.push(current);

    for (const selector of detailSelectorsForHost(host)) {
      const link = relevantLinkForElement(element, selector);
      const url = absoluteUrl(link?.href || link?.getAttribute?.("href"));
      if (url && !urls.includes(url)) urls.push(url);
    }

    // Stock-search cards often place the detail link on a sibling/overlay rather
    // than directly around the <img>. Collect every matching asset link from the
    // nearest card as an additional source so the full-resolution detail page can
    // be resolved without opening the image first.
    const container = nearestContainer(element);
    const selectorText = detailSelectorsForHost(host).join(",");
    if (container && selectorText) {
      for (const link of container.querySelectorAll?.(selectorText) || []) {
        const url = absoluteUrl(link?.href || link?.getAttribute?.("href"));
        if (url && !urls.includes(url)) urls.push(url);
        if (urls.length >= 8) break;
      }
    }

    // General article / story cards: if thumbnail is inside or part of a card linking
    // to an article page on the same host (e.g. Prothom Alo sidebar cards, blog cards, news cards)
    const cardLink = element.closest("a[href]") ||
      element.parentElement?.querySelector("a[href]") ||
      element.closest("figure,article,li,[role='article'],.card,[class*='card'],[class*='item']")?.querySelector("a[href]");
    if (cardLink) {
      const href = absoluteUrl(cardLink.getAttribute("href") || cardLink.href);
      if (href && !urls.includes(href)) {
        try {
          const u = new URL(href);
          if ((u.origin === location.origin || u.hostname.endsWith(host)) &&
              (u.protocol === "http:" || u.protocol === "https:") &&
              u.pathname !== location.pathname) {
            urls.push(href);
          }
        } catch (_) {}
      }
    }

    return urls.slice(0, 8);
  }

  function titleFromStockDetail(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      const host = normalizeHost(url.hostname);
      let slug = "";
      if (host.endsWith("shutterstock.com")) {
        slug = url.pathname.match(/\/(?:image-photo|image-vector|image-illustration|image-3d)\/(.+?)-(\d{6,})(?:$|[/?#])/i)?.[1] || "";
      } else if (host.endsWith("stock.adobe.com")) {
        const parts = url.pathname.split("/").filter(Boolean);
        const imagesIndex = parts.findIndex(part => part.toLowerCase() === "images");
        if (imagesIndex >= 0) slug = parts.slice(imagesIndex + 1).filter(part => !/^\d{6,}$/.test(part)).join(" ");
      } else if (host.endsWith("gettyimages.com") || host.endsWith("istockphoto.com")) {
        slug = url.pathname.match(/\/(?:detail|photo|vector|illustration)\/(.+?)(?:\/royalty-free-image)?(?:\/\d+|-id\d+|$)/i)?.[1] || "";
      }
      const clean = decodeURIComponent(slug)
        .replace(/^(?:stock[-_ ]*(?:photo|image|vector|illustration)[-_ ]*)+/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "";
    } catch (_) {
      return "";
    }
  }

  function cleanStockCaption(value) {
    const text = cleanText(value, 260)
      .replace(/\s*[|•·]\s*(?:Adobe\s*Stock|Shutterstock|Getty\s*Images|iStock)\s*$/i, "")
      .replace(/\s+-\s+(?:Adobe\s*Stock|Shutterstock|Getty\s*Images|iStock)\s*$/i, "")
      .replace(/^(?:Adobe\s*Stock|Shutterstock|Getty\s*Images|iStock)\s*[-|:]\s*/i, "")
      .trim();
    return text;
  }

  function isLikelyStockContributor(value) {
    const text = cleanStockCaption(value);
    return /\b\d[\d,\.]*\s+(?:photos?|images?|assets?|vectors?|illustrations?)\b/i.test(text) ||
      /^(?:by|from)\s+[A-Z][^,]{1,100}$/i.test(text);
  }

  function usefulStockCaption(value) {
    const text = cleanStockCaption(value);
    if (!text || isMarketplaceListingName(text) || isLikelyStockContributor(text)) return "";
    if (/^(?:download|free trial|standard license|dimensions|file type|more details|edit free|remove background|expand|explore all)$/i.test(text)) return "";
    return text;
  }

  function jsonLdCaptionValue(value, depth = 0) {
    if (depth > 5 || value == null) return "";
    if (typeof value === "string") return cleanStockCaption(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = jsonLdCaptionValue(item, depth + 1);
        if (found) return found;
      }
      return "";
    }
    if (typeof value !== "object") return "";
    for (const key of ["headline", "caption", "name", "title"]) {
      const found = jsonLdCaptionValue(value[key], depth + 1);
      if (found && !isMarketplaceListingName(found)) return found;
    }
    for (const key of ["mainEntity", "primaryImageOfPage", "image", "item", "about", "subjectOf"]) {
      const found = jsonLdCaptionValue(value[key], depth + 1);
      if (found && !isMarketplaceListingName(found)) return found;
    }
    return "";
  }

  function structuredStockCaption() {
    const selectors = [
      'meta[property="og:title"]',
      'meta[name="twitter:title"]',
      'meta[name="title"]'
    ];
    for (const selector of selectors) {
      const value = usefulStockCaption(document.querySelector(selector)?.getAttribute("content"));
      if (value) return value;
    }
    for (const node of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 18)) {
      try {
        const value = usefulStockCaption(jsonLdCaptionValue(JSON.parse(node.textContent || "")));
        if (value) return value;
      } catch (_) {}
    }
    return "";
  }

  function stockSourceCaption(host, container, element, details) {
    const directSelectors = host.endsWith("shutterstock.com")
      ? ["[data-automation='AssetTitle']", "[data-testid*='asset-title' i]", "[data-testid*='image-title' i]"]
      : host.endsWith("stock.adobe.com")
        ? ["[data-testid*='asset-title' i]", "[data-testid*='image-title' i]", "[data-automation*='asset-title' i]", "[data-automation*='image-title' i]"]
        : ["[data-testid*='asset-title' i]", "[data-testid*='image-title' i]"];

    // First look for the exact asset-title node exposed by the marketplace.
    const local = [];
    for (const root of [container, element?.closest?.("figure"), element]) {
      if (!root) continue;
      for (const selector of directSelectors) {
        const value = usefulStockCaption(firstUsefulText([root.querySelector?.(selector)], 260));
        if (value && !local.includes(value)) local.push(value);
      }
    }
    if (local.length) return local[0];

    // Then score visible headings. This avoids choosing contributor/count labels
    // such as “Russell Edwards 56 photos, images, assets”.
    const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].slice(0, 120)
      .map(node => usefulStockCaption(node?.getAttribute?.("title") || node?.textContent))
      .filter(Boolean);
    headings.sort((a,b) => {
      const score = text => {
        let value = Math.min(50, text.length);
        const words = text.split(/\s+/).length;
        if (words >= 6) value += 14;
        else if (words >= 4) value += 7;
        if (/[.!?:,]/.test(text)) value += 12;
        if (/\b(?:background|texture|pattern|overlay|abstract|illustration|design|snow|light|holiday|business|concept|banner)\b/i.test(text)) value += 8;
        return value;
      };
      return score(b) - score(a);
    });
    if (headings[0]) return headings[0];

    // JSON-LD is a reliable semantic fallback when the visible title is rendered late.
    const structured = usefulStockCaption(structuredStockCaption());
    if (structured) return structured;

    // Finally use the detail-page slug. This is less exact than the visible title
    // because punctuation is usually removed from the URL.
    for (const detail of details || []) {
      const value = usefulStockCaption(titleFromStockDetail(detail));
      if (value) return value;
    }
    return "";
  }


  function isMarketplaceListingName(value) {
    const text = cleanText(value, 220);
    return /^(?:\d[\d,\.\s]*\s+)?(?:icons?|images?|photos?|vectors?|illustrations?)\s+(?:royalty[- ]free|stock)|royalty[- ]free\s+(?:images?|stock photos?)|stock photos?\s*&\s*pictures|search results?/i.test(text) ||
      /^\d[\d,\.\s]+.*(?:royalty[- ]free|stock photos?|pictures)/i.test(text);
  }

  function originalFilenameFromElement(element, candidateRows) {
    const names = [];
    const add = value => {
      const clean = cleanText(value, 180);
      if (clean && !names.includes(clean)) names.push(clean);
    };
    let probe = element;
    for (let depth = 0; depth < 5 && probe; depth += 1, probe = probe.parentElement) {
      for (const attr of [
        "download", "data-filename", "data-file-name", "data-original-filename",
        "data-original-name", "data-name", "data-download-name"
      ]) add(probe.getAttribute?.(attr));
      const anchor = probe.matches?.("a[download]") ? probe : probe.querySelector?.("a[download]");
      add(anchor?.getAttribute?.("download"));
    }
    for (const row of candidateRows || []) add(basenameFromUrl(row?.url));
    return names[0] || "";
  }

  function siteMetadata(element, candidateRows, details) {
    const host = normalizeHost(location.hostname);
    const container = nearestContainer(element);
    const imageAlt = element instanceof HTMLImageElement
      ? cleanText(element.alt || element.getAttribute("aria-label") || element.getAttribute("title"), 220)
      : "";
    const metaTitle = firstUsefulText([
      document.querySelector('meta[property="og:title"]'),
      document.querySelector('meta[name="twitter:title"]'),
      document.querySelector('meta[name="title"]')
    ], 220);
    const metadata = {
      siteHost: host,
      siteName: host.replace(/^www\./, "").split(".")[0] || "website",
      creatorName: "",
      mediaTitle: "",
      sourceCaption: "",
      postId: "",
      originalFilename: originalFilenameFromElement(element, candidateRows),
      preferredName: ""
    };

    if (host.endsWith("instagram.com")) {
      const article = element.closest("article") || container;
      const detail = details.find(url => /instagram\.com\/(?:p|reel|tv)\//i.test(url)) || location.href;
      metadata.postId = detail.match(/\/(?:p|reel|tv)\/([^/?#]+)/i)?.[1] || "";
      const profile = [...(article?.querySelectorAll?.("a[href]") || [])].find(link => {
        try {
          const url = new URL(link.href, location.href);
          return /^\/[A-Za-z0-9._]+\/$/.test(url.pathname) && !/\/(?:explore|accounts|direct|stories)\//i.test(url.pathname);
        } catch (_) { return false; }
      });
      metadata.creatorName = cleanText(profile?.textContent || profile?.getAttribute?.("href")?.split("/").filter(Boolean)[0], 70).replace(/^@/, "");
      const captionNodes = [
        article?.querySelector?.("h1"),
        article?.querySelector?.("[data-testid='post-comment-root'] span"),
        ...[...(article?.querySelectorAll?.("span[dir='auto']") || [])].slice(0, 18)
      ];
      let caption = "";
      for (const node of captionNodes) {
        const candidate = usefulSocialCaption(node?.getAttribute?.("title") || node?.getAttribute?.("aria-label") || node?.textContent, 92);
        if (!candidate || candidate === metadata.creatorName) continue;
        caption = metadata.creatorName && candidate.toLowerCase().startsWith(metadata.creatorName.toLowerCase() + " ")
          ? usefulSocialCaption(candidate.slice(metadata.creatorName.length), 92)
          : candidate;
        if (caption) break;
      }
      metadata.mediaTitle = caption;
      metadata.preferredName = cleanText([
        metadata.creatorName ? `Instagram ${metadata.creatorName}` : "Instagram",
        metadata.postId || "",
        caption || ""
      ].filter(Boolean).join(" - "), 180);
    } else if (host.endsWith("facebook.com") || host === "fb.com") {
      const article = element.closest("[role='article'],div[data-pagelet*='FeedUnit'],article,[role='dialog']") || container;
      const detail = details.find(url => /facebook\.com\/(?:photo|photos|reel|watch|videos?)/i.test(url)) || "";
      metadata.postId = detail.match(/[?&]fbid=(\d+)/i)?.[1] || detail.match(/\/(\d{8,})(?:[/?#]|$)/)?.[1] || "";
      metadata.creatorName = firstUsefulText([
        article?.querySelector?.("h2 a[role='link']"),
        article?.querySelector?.("h3 a[role='link']"),
        article?.querySelector?.("strong a[role='link']"),
        article?.querySelector?.("a[aria-label][role='link']")
      ], 80);
      metadata.mediaTitle = firstUsefulText([
        article?.querySelector?.("[data-ad-preview='message']"),
        article?.querySelector?.("div[dir='auto']"),
        article?.querySelector?.("figcaption")
      ], 140);
      metadata.preferredName = cleanText([
        metadata.creatorName ? `Facebook ${metadata.creatorName}` : "Facebook",
        metadata.postId || "",
        metadata.mediaTitle || ""
      ].filter(Boolean).join(" - "), 190);
    } else if (host.endsWith("pinterest.com") || host === "pin.it") {
      const pin = element.closest("[data-test-id='pin'], [data-test-id='pinWrapper'], article") || container;
      const detail = details.find(url => /\/pin\/\d+/i.test(url)) || "";
      metadata.postId = detail.match(/\/pin\/(\d+)/i)?.[1] || "";
      metadata.mediaTitle = firstUsefulText([
        pin?.querySelector?.("[data-test-id='pin-title']"), pin?.querySelector?.("h1"),
        pin?.querySelector?.("[data-test-id='pin-description']"), pin?.querySelector?.("[data-test-id='rich-pin-description']"),
        pin?.querySelector?.("figcaption")
      ], 220) || imageAlt || metaTitle;
      metadata.creatorName = firstUsefulText([
        pin?.querySelector?.("[data-test-id='creator-profile-name']"), pin?.querySelector?.("a[href*='/'] [dir='auto']")
      ], 70);
      metadata.preferredName = cleanText([metadata.mediaTitle, metadata.creatorName, metadata.postId ? `Pin ${metadata.postId}` : ""].filter(Boolean).join(" - "), 220);
    } else if (host.endsWith("behance.net")) {
      const projectUrl = details.find(url => /behance\.net\/gallery\//i.test(url)) || (/\/gallery\//i.test(location.pathname) ? location.href : "");
      const projectMatch = projectUrl.match(/\/gallery\/(\d+)\/([^/?#]+)/i);
      metadata.postId = projectMatch?.[1] || "";
      const projectSlug = cleanText((projectMatch?.[2] || "").replace(/[-_]+/g, " "), 180);
      const cardTitle = firstUsefulText([
        container?.querySelector?.("[class*='Project-title'],[class*='ProjectTitle']"),
        container?.querySelector?.("h1,h2,h3"),
        element.closest("figure")?.querySelector?.("figcaption"),
        container?.querySelector?.("figcaption")
      ], 220);
      metadata.mediaTitle = projectSlug || cardTitle || stripAccessibilityDescription(imageAlt, 180) || metaTitle;
      metadata.creatorName = firstUsefulText([
        document.querySelector("[class*='Project-owner']"), document.querySelector("[class*='ProjectOwner']"),
        document.querySelector("a[href*='/'] [class*='User']")
      ], 70);
      metadata.preferredName = cleanText(metadata.mediaTitle || (metadata.postId ? `Behance ${metadata.postId}` : "Behance project"), 220);
    } else if (host.endsWith("shutterstock.com")) {
      const detail = details.find(url => /shutterstock\.com\/(?:image-photo|image-vector|image-illustration|image-3d)\//i.test(url)) || (/\/(?:image-photo|image-vector|image-illustration|image-3d)\//i.test(location.pathname) ? location.href : "");
      metadata.postId = detail.match(/-(\d{6,})(?:$|[/?#])/i)?.[1] || "";
      const detailTitle = titleFromStockDetail(detail);
      const exactCardTitle = firstUsefulText([
        container?.querySelector?.("[data-automation='AssetTitle']"), container?.querySelector?.("[data-testid*='asset-title' i]"),
        container?.querySelector?.("figcaption"), container?.querySelector?.("h1,h2,h3")
      ], 190);
      const choices = [detailTitle, exactCardTitle, imageAlt].map(value => stripAccessibilityDescription(value, 170).replace(/^(?:stock[-_ ]*(?:photo|image|vector|illustration)[-_ ]*)+/i, ""));
      metadata.sourceCaption = stockSourceCaption(host, container, element, details) || choices.map(value => usefulStockCaption(stripAccessibilityDescription(value, 170))).find(Boolean) || "";
      metadata.mediaTitle = metadata.sourceCaption;
      metadata.preferredName = cleanText(metadata.mediaTitle || (metadata.postId ? `Shutterstock ${metadata.postId}` : "Shutterstock image"), 170);
    } else if (host.endsWith("stock.adobe.com")) {
      const detail = details.find(url => /stock\.adobe\.com\/(?:[a-z]{2}\/)?images\//i.test(url)) || (/\/images\//i.test(location.pathname) ? location.href : "");
      metadata.postId = detail.match(/\/(\d{6,})(?:$|[/?#])/i)?.[1] || "";
      const detailTitle = titleFromStockDetail(detail);
      const cardTitle = firstUsefulText([container?.querySelector?.("[data-testid*='title']"), container?.querySelector?.("h1,h2,h3"), element.closest("figure")?.querySelector?.("figcaption")], 180);
      metadata.sourceCaption = stockSourceCaption(host, container, element, details) || [detailTitle, cardTitle, imageAlt].map(value => usefulStockCaption(stripAccessibilityDescription(value, 160))).find(Boolean) || "";
      metadata.mediaTitle = metadata.sourceCaption;
      metadata.preferredName = cleanText(metadata.mediaTitle || (metadata.postId ? `Adobe Stock ${metadata.postId}` : "Adobe Stock image"), 170);
    } else if (host.endsWith("gettyimages.com") || host.endsWith("istockphoto.com")) {
      const detail = details[0] || "";
      metadata.postId = detail.match(/(?:\/|-id)(\d{6,})(?:$|[/?#])/i)?.[1] || "";
      const detailTitle = titleFromStockDetail(detail);
      metadata.sourceCaption = stockSourceCaption(host, container, element, details) || [detailTitle, imageAlt, firstUsefulText([container?.querySelector?.("h1,h2,h3"), element.closest("figure")?.querySelector?.("figcaption")], 180)]
        .map(value => usefulStockCaption(stripAccessibilityDescription(value, 160))).find(Boolean) || "";
      metadata.mediaTitle = metadata.sourceCaption;
      metadata.preferredName = cleanText(metadata.mediaTitle || (metadata.postId ? `Stock image ${metadata.postId}` : "Stock image"), 170);
    } else {
      metadata.mediaTitle = firstUsefulText([
        element.closest("figure")?.querySelector?.("figcaption"), container?.querySelector?.("figcaption"),
        container?.querySelector?.("[class*='caption']"), container?.querySelector?.("[class*='title']"), container?.querySelector?.("h1,h2,h3")
      ], 220) || stripAccessibilityDescription(imageAlt, 120) || metaTitle;
      metadata.preferredName = cleanText(metadata.mediaTitle || metaTitle || document.title, 180);
    }

    if (!metadata.sourceCaption) metadata.sourceCaption = metadata.mediaTitle || "";
    if (!metadata.preferredName || isMarketplaceListingName(metadata.preferredName)) {
      metadata.preferredName = cleanText(metadata.mediaTitle || stripAccessibilityDescription(imageAlt, 120) || metadata.postId || metadata.siteName, 180);
    }
    return metadata;
  }



  const DIRECT_VIDEO_RE = /\.(?:mp4|webm|mov|m4v|ogv|avi|mkv)(?:$|[?#])/i;

  function isDirectVideoUrl(value) {
    const url = absoluteUrl(value);
    return Boolean(url && (url.startsWith("blob:") || url.startsWith("data:video/") || DIRECT_VIDEO_RE.test(url)));
  }

  function associatedVideoElement(element) {
    if (element instanceof HTMLVideoElement) return element;
    if (!(element instanceof Element)) return null;
    const elementRect = element.getBoundingClientRect?.();
    const roots = [
      element.closest("figure,[data-testid*='video'],[data-automation*='video'],[class*='video'],[class*='Video']"),
      element.parentElement,
      element.parentElement?.parentElement,
      element.closest("article,li,[role='article']")
    ].filter(Boolean);
    for (const root of roots) {
      for (const video of [...(root.querySelectorAll?.("video") || [])]) {
        if (!(video.currentSrc || video.src || video.querySelector("source[src]") || video.getAttribute("data-src"))) continue;
        const videoRect = video.getBoundingClientRect?.();
        const poster = absoluteUrl(video.poster || video.getAttribute("poster"));
        const imageUrl = element instanceof HTMLImageElement ? absoluteUrl(element.currentSrc || element.src) : "";
        const overlap = overlapRatio(elementRect, videoRect);
        const samePoster = Boolean(poster && imageUrl && poster === imageUrl);
        const closeSibling = video.parentElement === element.parentElement || video.parentElement?.contains?.(element) || element.parentElement?.contains?.(video);
        if (samePoster || overlap > .45 || (closeSibling && Number(videoRect?.width||0) > 80 && Number(videoRect?.height||0) > 80)) return video;
      }
    }
    return null;
  }

  function videoSourceCandidates(video, origin) {
    const rows = new Map();
    const add = (value, rank, source) => {
      const url = absoluteUrl(value);
      if (!isDirectVideoUrl(url)) return;
      const old = rows.get(url);
      if (!old || rank > old.rank) rows.set(url, {url, rank, authoritative:false, source});
    };
    add(video?.currentSrc, 3_000_000, "video-current-src");
    add(video?.src, 2_900_000, "video-src");
    video?.querySelectorAll?.("source[src]").forEach((source, index) => add(source.src || source.getAttribute("src"), 2_800_000 - index, "video-source"));
    const attrs = ["data-src","data-video-src","data-video-url","data-mp4","data-playback-url","data-media-url","data-download-url"];
    for (const node of [video, origin, video?.parentElement, origin?.closest?.("figure,article,li,[role='article']")].filter(Boolean)) {
      attrs.forEach((name, index) => add(node.getAttribute?.(name), 2_600_000 - index, name));
      node.querySelectorAll?.("a[href],source[src]").forEach((link, index) => add(link.href || link.src || link.getAttribute("href") || link.getAttribute("src"), 2_400_000 - index, "video-linked-source"));
    }
    return [...rows.values()].sort((a,b)=>b.rank-a.rank).slice(0, MAX_CANDIDATES);
  }

  function buildVideoResource(origin, video) {
    const rows = videoSourceCandidates(video, origin);
    if (!rows.length) return null;
    const details = detailPageUrls(origin || video);
    const metadata = siteMetadata(origin || video, rows, details);
    const yt = youtubeContext(origin || video);
    const originPreview = origin instanceof HTMLImageElement ? absoluteUrl(origin.currentSrc || origin.src) : "";
    const previewUrl = originPreview || videoThumbnailFor(video);
    const rectNode = visibleRect(origin) ? origin : video;
    const captureRect = visibleRect(rectNode) || rectNode?.getBoundingClientRect?.() || null;
    const title = yt?.title || metadata.preferredName || metadata.mediaTitle || cleanText(document.title || "video", 220);
    return {
      url: rows[0].url,
      candidates: rows,
      previewUrl,
      detailPageUrls: details,
      mediaKind: "video",
      kind: "video",
      mimeHint: video?.getAttribute?.("type") || video?.querySelector?.("source[type]")?.getAttribute("type") || "video/mp4",
      youtubeVideoId: yt?.id || "",
      youtubeTitle: yt?.title || "",
      pageUrl: location.href,
      pageTitle: document.title || "",
      suggestedName: title || "video",
      originalFilename: basenameFromUrl(rows[0].url),
      videoDuration: Number(video?.duration || 0),
      viewportRect: captureRect ? {
        left:Number(captureRect.left||0),top:Number(captureRect.top||0),width:Number(captureRect.width||0),height:Number(captureRect.height||0),right:Number(captureRect.right||0),bottom:Number(captureRect.bottom||0)
      } : null,
      viewportWidth:Number(innerWidth||0),viewportHeight:Number(innerHeight||0),devicePixelRatio:Number(window.devicePixelRatio||1),
      ...metadata
    };
  }


  function socialVideoPlatform() {
    const host = normalizeHost(location.hostname);
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com") || host === "fb.watch") return "facebook";
    if (host === "pinterest.com" || host.endsWith(".pinterest.com") || host === "pin.it" || host.endsWith(".pin.it")) return "pinterest";
    return "";
  }

  function targetSocialVideoRoot(target, platform = socialVideoPlatform()) {
    if (!(target instanceof Element)) return null;
    if (platform === "instagram") {
      return target.closest("article,[role='dialog']") || target.parentElement;
    }
    if (platform === "facebook") {
      return target.closest("[role='article'],div[data-pagelet*='FeedUnit'],article,[role='dialog']") || target.parentElement;
    }
    if (platform === "pinterest") {
      return target.closest("[data-test-id='pin'],[data-test-id='pinWrapper'],[data-test-id='closeup-body'],[data-test-id*='pin'],article,[role='dialog']") || target.parentElement;
    }
    return null;
  }

  function targetLikelySocialVideo(target) {
    const platform = socialVideoPlatform();
    if (!platform || !(target instanceof Element)) return false;
    if (target instanceof HTMLVideoElement || associatedVideoElement(target)) return true;
    const root = targetSocialVideoRoot(target, platform);
    if (!root) return false;
    const linkedVideoPage = videoPageLinkFor(target);
    if (linkedVideoPage && likelyVideoPageUrl(linkedVideoPage)) return true;
    if (root.querySelector?.("video,source[type^='video/'],[data-video-url],[data-video-src],[data-playback-url],[data-test-id*='video'],[data-testid*='video'],[data-automation*='video']")) return true;
    const labels = [...(root.querySelectorAll?.("[aria-label],[title],[data-test-id]") || [])].slice(0, 160)
      .map(node => `${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""} ${node.getAttribute("data-test-id") || ""}`)
      .join(" ");
    if (/\b(?:play|pause|video|reel|watch)\b/i.test(labels)) return true;
    if (platform === "instagram" && /\/(?:reel|tv)\//i.test(location.pathname)) return true;
    if (platform === "facebook" && /\/(?:reel|watch|videos?)\b/i.test(location.pathname)) return true;
    if (platform === "facebook" && root.querySelector?.("[data-video-id],[data-pagelet*='Video'],[aria-label*='Play' i],[aria-label*='Pause' i]")) return true;
    if (platform === "pinterest") {
      const ogType = document.querySelector('meta[property="og:type"],meta[name="twitter:card"]')?.getAttribute("content") || "";
      if (/video|player/i.test(ogType)) return true;
      if (root.querySelector?.("[class*='video'],[class*='Video'],[data-test-id*='play'],[aria-label*='Play' i]")) return true;
    }
    return false;
  }

  async function resolveSocialVideoResource(target, fallbackResource = null) {
    const platform = socialVideoPlatform();
    if (!platform || !targetLikelySocialVideo(target)) return fallbackResource;
    const root = targetSocialVideoRoot(target, platform) || target;
    const rect = visibleRect(target) || visibleRect(root) || target.getBoundingClientRect?.() || null;
    const details = detailPageUrls(target);
    const metadata = siteMetadata(target, [], details);
    const fallbackPreview = fallbackResource?.previewUrl || (target instanceof HTMLVideoElement ? videoThumbnailFor(target) : target instanceof HTMLImageElement ? absoluteUrl(target.currentSrc || target.src) : "");
    const point = rect ? {
      x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
      left: Number(rect.left || 0), top: Number(rect.top || 0), width: Number(rect.width || 0), height: Number(rect.height || 0)
    } : {x:lastPointer.x, y:lastPointer.y, left:0, top:0, width:0, height:0};
    try {
      const response = await chrome.runtime.sendMessage({
        action:"moodboxDownload-resolve-social-video",
        platform,
        point,
        pageUrl:location.href,
        detailPageUrls:details,
        suggestedName:metadata.preferredName || metadata.mediaTitle || fallbackResource?.suggestedName || document.title || `${platform} video`,
        previewUrl:fallbackPreview,
        viewportRect:rect ? {left:Number(rect.left||0),top:Number(rect.top||0),width:Number(rect.width||0),height:Number(rect.height||0),right:Number(rect.right||0),bottom:Number(rect.bottom||0)} : null,
        viewportWidth:Number(innerWidth||0),
        viewportHeight:Number(innerHeight||0),
        devicePixelRatio:Number(window.devicePixelRatio||1)
      });
      if (!response?.ok || !response.resource?.url) return fallbackResource;
      return {
        ...(fallbackResource || {}),
        ...response.resource,
        pageUrl:location.href,
        pageTitle:document.title || "",
        previewUrl:response.resource.previewUrl || fallbackPreview || fallbackResource?.previewUrl || "",
        detailPageUrls:details.length ? details : (response.resource.detailPageUrls || [location.href]),
        viewportRect:response.resource.viewportRect || (rect ? {left:Number(rect.left||0),top:Number(rect.top||0),width:Number(rect.width||0),height:Number(rect.height||0),right:Number(rect.right||0),bottom:Number(rect.bottom||0)} : null),
        viewportWidth:Number(innerWidth||0), viewportHeight:Number(innerHeight||0), devicePixelRatio:Number(window.devicePixelRatio||1)
      };
    } catch (_) {
      return fallbackResource;
    }
  }


  function likelyVideoPageUrl(value) {
    const url = absoluteUrl(value);
    if (!url) return "";
    try {
      const parsed = new URL(url);
      const host = normalizeHost(parsed.hostname);
      const path = `${parsed.pathname}${parsed.search}`;
      if ((host.endsWith("youtube.com") && /(?:\/watch\?v=|\/shorts\/|\/live\/)/i.test(path)) || host === "youtu.be") return url;
      if ((host.endsWith("instagram.com") && /\/(?:reel|tv)\//i.test(path)) || (host.endsWith("facebook.com") && /\/(?:watch|reel|videos)\b/i.test(path)) || host === "fb.watch") return url;
      if (/\/(?:videos?|footage|clips?|reels?)\//i.test(path) || /(?:stock|premium|free)[-_ ]?video/i.test(path)) return url;
    } catch (_) {}
    return "";
  }

  function videoPageLinkFor(element) {
    if (!(element instanceof Element)) return "";
    const roots = [element.closest("a[href]"), element.closest("figure,article,li,[role='article']"), element.parentElement].filter(Boolean);
    for (const root of roots) {
      if (root.matches?.("a[href]")) {
        const direct = likelyVideoPageUrl(root.href || root.getAttribute("href"));
        if (direct) return direct;
      }
      for (const link of [...(root.querySelectorAll?.("a[href]") || [])].slice(0, 30)) {
        const direct = likelyVideoPageUrl(link.href || link.getAttribute("href"));
        if (direct) return direct;
      }
    }
    return "";
  }

  function buildVideoPageResource(element) {
    const pageUrl = videoPageLinkFor(element);
    if (!pageUrl) return null;
    const details = [pageUrl];
    const previewUrl = element instanceof HTMLImageElement ? absoluteUrl(element.currentSrc || element.src) : "";
    const metadata = siteMetadata(element, [], details);
    const yt = youtubeContext(element);
    const captureRect = visibleRect(element) || element.getBoundingClientRect?.() || null;
    return {
      url:pageUrl,
      candidates:[],
      previewUrl,
      detailPageUrls:details,
      mediaKind:"video-page",
      kind:"video",
      youtubeVideoId:yt?.id || "",
      youtubeTitle:yt?.title || "",
      pageUrl:location.href,
      pageTitle:document.title || "",
      suggestedName:yt?.title || metadata.preferredName || metadata.mediaTitle || cleanText(document.title || "video", 220),
      viewportRect:captureRect ? {left:Number(captureRect.left||0),top:Number(captureRect.top||0),width:Number(captureRect.width||0),height:Number(captureRect.height||0),right:Number(captureRect.right||0),bottom:Number(captureRect.bottom||0)} : null,
      viewportWidth:Number(innerWidth||0),viewportHeight:Number(innerHeight||0),devicePixelRatio:Number(window.devicePixelRatio||1),
      ...metadata
    };
  }

  function buildYouTubeThumbnailResource(element) {
    const isYouTube = /(?:^|\.)youtube\.com$/i.test(location.hostname) || /(?:^|\.)youtu\.be$/i.test(location.hostname);
    if (!isYouTube || !(element instanceof Element)) return null;
    const yt = youtubeContext(element);
    if (!yt?.id) return null;
    const candidates = new Map();
    addYouTubeCandidates(candidates, yt);
    if (element instanceof HTMLImageElement) {
      addCandidate(candidates, element.currentSrc, 2_200_000, false, "youtube-visible-thumbnail");
      addCandidate(candidates, element.src, 2_100_000, false, "youtube-visible-thumbnail");
      parseSrcset(element.srcset).forEach(row => addCandidate(candidates, row.url, 2_250_000 + row.score, false, "youtube-thumbnail-srcset"));
    }
    const rows = [...candidates.values()].sort((a,b)=>Number(b.rank)-Number(a.rank)).slice(0, MAX_CANDIDATES);
    if (!rows.length) return null;
    const previewUrl = element instanceof HTMLImageElement ? absoluteUrl(element.currentSrc || element.src) : rows[0].url;
    const captureRect = visibleRect(element) || element.getBoundingClientRect?.() || null;
    return {
      url: rows[0].url, candidates: rows, previewUrl, detailPageUrls: [],
      mediaKind: "image", kind: "image", youtubeThumbnail: true,
      youtubeVideoId: yt.id, youtubeTitle: yt.title,
      pageUrl: location.href, pageTitle: document.title || "",
      suggestedName: `${yt.title || `YouTube-${yt.id}`} - thumbnail`,
      originalFilename: `${yt.id}-thumbnail.jpg`,
      viewportRect: captureRect ? {left:Number(captureRect.left||0),top:Number(captureRect.top||0),width:Number(captureRect.width||0),height:Number(captureRect.height||0),right:Number(captureRect.right||0),bottom:Number(captureRect.bottom||0)} : null,
      viewportWidth:Number(innerWidth||0),viewportHeight:Number(innerHeight||0),devicePixelRatio:Number(window.devicePixelRatio||1)
    };
  }

  function buildVideoThumbnailResource(element) {
    if (!(element instanceof Element)) return null;
    const yt = youtubeContext(element);
    const video = element instanceof HTMLVideoElement ? element : associatedVideoElement(element);
    const socialVideo = Boolean(targetLikelySocialVideo(element));
    const videoLike = Boolean(video || socialVideo || yt?.id);
    if (!videoLike) return null;

    const youtube = buildYouTubeThumbnailResource(element);
    if (youtube) return youtube;

    const candidates = new Map();
    const add = (value, rank, source, authoritative = false) => {
      const url = absoluteUrl(value);
      if (!url || !/^(?:https?:|data:image\/)/i.test(url)) return;
      addCandidate(candidates, url, rank, authoritative, source);
    };

    const root = targetSocialVideoRoot(element) || video?.closest("figure,article,li,[role='article'],[role='dialog']") || video?.parentElement || element.closest?.("figure,article,li,[role='article'],[role='dialog']") || element.parentElement;
    const videoPage = videoPageLinkFor(element);

    if (video) add(video.poster || video.getAttribute("poster"), 3_000_000, "video-poster", true);

    // Feed cards may use an <img> as the video cover while the actual <video>
    // node is hidden/replaced. Inspect the clicked card so opening the post is
    // never required just to get its thumbnail.
    const cardImages = [];
    if (element instanceof HTMLImageElement) cardImages.push(element);
    for (const image of [...(root?.querySelectorAll?.("img") || [])].slice(0, 80)) {
      if (!cardImages.includes(image)) cardImages.push(image);
    }
    for (const image of cardImages) {
      const rect = image.getBoundingClientRect?.();
      const area = Math.max(1, Number(rect?.width || 0) * Number(rect?.height || 0));
      add(image.currentSrc || image.src || image.getAttribute("src"), 2_650_000 + Math.min(300_000, area), "video-card-image");
      for (const row of parseSrcset(image.srcset || "")) add(row.url, 2_550_000 + row.score, "video-card-srcset");
      for (const name of ["data-original","data-src","data-full","data-full-src","data-pin-media","data-high-res-src","data-orig-img","data-original-image","data-original-src"]) {
        add(image.getAttribute(name), 2_700_000, `video-card-${name}`);
      }
    }

    // Same-origin video fallback: capture one rendered frame only when no real
    // poster/cover image is exposed by the site.
    if (!candidates.size && video) {
      try {
        const rect = visibleRect(video) || video.getBoundingClientRect?.();
        const width = Math.max(320, Math.min(4096, Math.round(Number(rect?.width || video.videoWidth || 1280) * Math.max(1, Number(devicePixelRatio || 1)))));
        const height = Math.max(180, Math.min(4096, Math.round(Number(rect?.height || video.videoHeight || 720) * Math.max(1, Number(devicePixelRatio || 1)))));
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d", {alpha:false});
        context?.drawImage(video, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.96);
        add(dataUrl, 2_900_000, "video-frame-capture", true);
      } catch (_) {}
    }

    // Metadata is strictly a video fallback. It must never turn an ordinary
    // still image into a video thumbnail just because the page has og:image.
    if (!candidates.size) {
      for (const meta of document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"],meta[name="twitter:image:src"]')) {
        add(meta.getAttribute("content"), 2_300_000, "page-social-thumbnail");
      }
    }

    const rows = [...candidates.values()].sort((a,b) => Number(b.rank) - Number(a.rank)).slice(0, MAX_CANDIDATES);
    if (!rows.length) return null;
    const details = detailPageUrls(element);
    const metadata = siteMetadata(element, rows, details);
    const baseTitle = metadata.preferredName || metadata.mediaTitle || document.title || "Video";
    const filenameId = yt?.id || metadata.postId || "video";
    const captureRect = visibleRect(element) || element.getBoundingClientRect?.() || null;
    return {
      url: rows[0].url, candidates: rows, detailPageUrls: details,
      mediaKind:"image", kind:"image", videoThumbnail:true,
      youtubeVideoId:yt?.id || "", youtubeTitle:yt?.title || "",
      pageUrl:location.href, pageTitle:document.title || "",
      suggestedName:`${cleanText(baseTitle, 150)} - thumbnail`,
      originalFilename:`${sanitizeBase(filenameId, "video")}-thumbnail.jpg`,
      viewportRect:captureRect ? {left:Number(captureRect.left||0),top:Number(captureRect.top||0),width:Number(captureRect.width||0),height:Number(captureRect.height||0),right:Number(captureRect.right||0),bottom:Number(captureRect.bottom||0)} : null,
      viewportWidth:Number(innerWidth||0),viewportHeight:Number(innerHeight||0),devicePixelRatio:Number(devicePixelRatio||1),
      ...metadata
    };
  }


  function buildResource(element) {
    const associatedVideo = associatedVideoElement(element);
    if (associatedVideo) {
      const videoResource = buildVideoResource(element, associatedVideo);
      if (videoResource) {
        const ytPage = videoResource.youtubeVideoId && String(videoResource.url || "").startsWith("blob:") ? buildVideoPageResource(element) : null;
        return ytPage || videoResource;
      }
    }
    const linkedVideoPage = buildVideoPageResource(element);
    if (linkedVideoPage) return linkedVideoPage;
    const candidates = new Map();
    const isYouTube = /(?:^|\.)youtube\.com$/i.test(location.hostname) || /(?:^|\.)youtu\.be$/i.test(location.hostname);
    const yt = isYouTube ? youtubeContext(element) : null;
    if (yt) addYouTubeCandidates(candidates, yt);

    if (element instanceof HTMLCanvasElement) {
      try {
        const dataUrl = element.toDataURL("image/png");
        if (dataUrl && dataUrl !== "data:,") addCandidate(candidates, dataUrl, 2_100_000, true, "canvas-render");
      } catch (_) {}
    }

    if (element.localName === "image" && element.namespaceURI?.includes("svg")) {
      addCandidate(
        candidates,
        element.getAttribute("href") || element.getAttributeNS("http://www.w3.org/1999/xlink", "href"),
        1_950_000,
        false,
        "svg-image"
      );
    }

    if (element instanceof HTMLImageElement) {
      const area = Math.max(1, Number(element.naturalWidth || 0) * Number(element.naturalHeight || 0));
      addCandidate(candidates, element.currentSrc, 1_200_000 + area, false, "current-src");
      addCandidate(candidates, element.src, 700_000, false, "src");
      parseSrcset(element.srcset).forEach(row => addCandidate(candidates, row.url, 1_500_000 + row.score, false, "srcset"));
      element.closest("picture")?.querySelectorAll("source[srcset]").forEach(source => {
        parseSrcset(source.getAttribute("srcset")).forEach(row => addCandidate(candidates, row.url, 1_650_000 + row.score, false, "picture-srcset"));
      });
      const attributes = [
        "data-original", "data-original-src", "data-src", "data-lazy-src", "data-image", "data-full",
        "data-full-src", "data-fullsize", "data-full-size", "data-original-image", "data-original-url",
        "data-zoom-image", "data-pin-media", "data-hi-res-src", "data-high-res-src",
        "data-testid-src", "data-src-large", "data-large-image", "data-image-url", "data-original-url"
      ];
      attributes.forEach((name, index) => addCandidate(candidates, element.getAttribute(name), 1_900_000 - index, false, name));
      const linked = imageHref(element.closest("a[href]")?.getAttribute("href"));
      if (linked) addCandidate(candidates, linked, 2_000_000, false, "linked-image");

      // Google Images search result link: /imgres?imgurl=...
      const googleLink = element.closest("a[href*='imgurl=']") || element.parentElement?.querySelector("a[href*='imgurl=']");
      if (googleLink) {
        try {
          const parsedLink = new URL(googleLink.href, location.href);
          const realImgUrl = parsedLink.searchParams.get("imgurl");
          if (realImgUrl) {
            addCandidate(candidates, realImgUrl, 3_000_000, true, "google-imgres-imgurl");
          }
        } catch (_) {}
      }
    }

    for (const url of backgroundUrls(element)) addCandidate(candidates, url, 1_000_000, false, "background-image");
    for (const candidate of [...candidates.values()]) {
      addPinterestCandidates(candidates, candidate.url);
      addBehanceCandidates(candidates, candidate.url);
      addMetaCdnCandidates(candidates, candidate.url);
      addStockCandidates(candidates, candidate.url);
      addGenericCdnCandidates(candidates, candidate.url);
    }
    addMatchingContainerCandidates(candidates, element);

    const rows = [...candidates.values()].sort((a, b) => Number(b.rank) - Number(a.rank)).slice(0, MAX_CANDIDATES);
    if (!rows.length) return null;
    const details = detailPageUrls(element);
    const metadata = siteMetadata(element, rows, details);

    let title = "";
    let mediaKind = element instanceof HTMLVideoElement ? "video-thumbnail" : "image";
    if (yt) {
      title = yt.title;
      mediaKind = "video-thumbnail";
    } else {
      title = metadata.preferredName || metadata.mediaTitle;
    }
    if (!title) title = cleanText(document.title || "browser-image", 220);

    const captureRect = visibleRect(element) || element.getBoundingClientRect?.() || null;
    return {
      url: rows[0].url,
      candidates: rows,
      detailPageUrls: details,
      mediaKind,
      youtubeVideoId: yt?.id || "",
      youtubeTitle: yt?.title || "",
      pageUrl: location.href,
      pageTitle: document.title || "",
      suggestedName: title || "browser-image",
      viewportRect: captureRect ? {
        left: Number(captureRect.left || 0), top: Number(captureRect.top || 0),
        width: Number(captureRect.width || 0), height: Number(captureRect.height || 0),
        right: Number(captureRect.right || 0), bottom: Number(captureRect.bottom || 0)
      } : null,
      viewportWidth: Number(innerWidth || 0),
      viewportHeight: Number(innerHeight || 0),
      devicePixelRatio: Number(window.devicePixelRatio || 1),
      ...metadata
    };
  }



  function socialImagePlatform() {
    const host = normalizeHost(location.hostname);
    if (host === "instagram.com" || host.endsWith(".instagram.com")) return "instagram";
    if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com")) return "facebook";
    if (host === "pinterest.com" || host.endsWith(".pinterest.com") || host === "pin.it" || host.endsWith(".pin.it")) return "pinterest";
    return "";
  }

  async function resolveCurrentSocialImageResource(target, fallbackResource = null) {
    const platform = socialImagePlatform();
    if (!platform || !(target instanceof Element) || targetLikelySocialVideo(target)) return fallbackResource;
    const rect = visibleRect(target) || target.getBoundingClientRect?.() || null;
    const details = detailPageUrls(target);
    const metadata = siteMetadata(target, fallbackResource?.candidates || [], details);
    const point = rect ? {
      x:Math.max(0,Math.min(innerWidth-1,rect.left+rect.width/2)),
      y:Math.max(0,Math.min(innerHeight-1,rect.top+rect.height/2)),
      left:Number(rect.left||0),top:Number(rect.top||0),width:Number(rect.width||0),height:Number(rect.height||0)
    } : {x:lastPointer.x,y:lastPointer.y,left:0,top:0,width:0,height:0};
    try {
      const response = await chrome.runtime.sendMessage({
        action:"moodboxDownload-resolve-social-image",
        platform,
        point,
        pageUrl:location.href,
        detailPageUrls:details,
        currentUrl:String((target instanceof HTMLImageElement ? target.currentSrc || target.src : "") || fallbackResource?.previewUrl || fallbackResource?.url || ""),
        suggestedName:metadata.preferredName || metadata.mediaTitle || fallbackResource?.suggestedName || document.title || `${platform} image`,
        postId:metadata.postId || "",
        viewportRect:rect ? {left:Number(rect.left||0),top:Number(rect.top||0),width:Number(rect.width||0),height:Number(rect.height||0),right:Number(rect.right||0),bottom:Number(rect.bottom||0)} : null,
        viewportWidth:Number(innerWidth||0),viewportHeight:Number(innerHeight||0),devicePixelRatio:Number(window.devicePixelRatio||1)
      });
      if (!response?.ok || !response.resource?.url) return fallbackResource;
      return {
        ...(fallbackResource || {}),
        ...response.resource,
        pageUrl:location.href,
        pageTitle:document.title || "",
        suggestedName:response.resource.suggestedName || metadata.preferredName || fallbackResource?.suggestedName || `${platform} image`,
        detailPageUrls:details.length ? details : (response.resource.detailPageUrls || [location.href]),
        viewportRect:response.resource.viewportRect || (rect ? {left:Number(rect.left||0),top:Number(rect.top||0),width:Number(rect.width||0),height:Number(rect.height||0),right:Number(rect.right||0),bottom:Number(rect.bottom||0)} : null),
        viewportWidth:Number(innerWidth||0),viewportHeight:Number(innerHeight||0),devicePixelRatio:Number(window.devicePixelRatio||1),
        ...metadata
      };
    } catch (_) {
      return fallbackResource;
    }
  }

  function instagramCarouselRoot(element) {
    const host = normalizeHost(location.hostname);
    if (host === "instagram.com" || host.endsWith(".instagram.com")) {
      return element?.closest?.("article") || element?.closest?.("[role='dialog']") || null;
    }
    if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.com" || host.endsWith(".fb.com")) {
      return element?.closest?.("[role='article']") ||
        element?.closest?.("div[data-pagelet*='FeedUnit']") ||
        element?.closest?.("article") ||
        element?.closest?.("[role='dialog']") || null;
    }
    if (host === "threads.net" || host.endsWith(".threads.net")) {
      return element?.closest?.("article") || element?.closest?.("[role='dialog']") || null;
    }
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      return element?.closest?.("[data-urn*='activity']") || element?.closest?.("article") || element?.closest?.("[role='dialog']") || null;
    }
    return null;
  }

  function carouselMediaUrl(node) {
    if (node instanceof HTMLImageElement) {
      return absoluteUrl(node.currentSrc || node.src || node.getAttribute("src") || "");
    }
    if (node instanceof HTMLVideoElement) {
      return absoluteUrl(node.currentSrc || node.src || node.poster || node.getAttribute("src") || "");
    }
    return "";
  }

  function mediaIntersectsRoot(node, root) {
    const rect = node?.getBoundingClientRect?.();
    const rootRect = root?.getBoundingClientRect?.();
    if (!rect || !rootRect || rect.width < 2 || rect.height < 2) return false;
    return rect.right > rootRect.left && rect.left < rootRect.right && rect.bottom > rootRect.top && rect.top < rootRect.bottom;
  }

  function largeCarouselMedia(root) {
    const rows = [];
    for (const node of root?.querySelectorAll?.("img,video") || []) {
      if (!(node instanceof HTMLImageElement || node instanceof HTMLVideoElement)) continue;
      if (node.closest("header,footer,nav")) continue;
      const rect = node.getBoundingClientRect?.();
      const naturalWidth = node instanceof HTMLImageElement ? Number(node.naturalWidth || 0) : Number(node.videoWidth || 0);
      const naturalHeight = node instanceof HTMLImageElement ? Number(node.naturalHeight || 0) : Number(node.videoHeight || 0);
      const renderedEdge = Math.max(Number(rect?.width || 0), Number(rect?.height || 0));
      const naturalEdge = Math.max(naturalWidth, naturalHeight);
      if (naturalEdge < 240 && renderedEdge < 180) continue;
      if (!carouselMediaUrl(node)) continue;
      if (!mediaIntersectsRoot(node, root) && renderedEdge < 120) continue;
      rows.push(node);
    }
    rows.sort((a, b) => {
      const ar = a.getBoundingClientRect?.() || {top:0,left:0,width:0,height:0};
      const br = b.getBoundingClientRect?.() || {top:0,left:0,width:0,height:0};
      const av = ar.bottom > 0 && ar.top < innerHeight && ar.right > 0 && ar.left < innerWidth ? 1 : 0;
      const bv = br.bottom > 0 && br.top < innerHeight && br.right > 0 && br.left < innerWidth ? 1 : 0;
      return bv - av || (br.width * br.height) - (ar.width * ar.height) || ar.top - br.top || ar.left - br.left;
    });
    return rows;
  }

  function carouselViewportRect(root) {
    const visible = largeCarouselMedia(root).map(node => node.getBoundingClientRect?.()).filter(rect =>
      rect && rect.width >= 40 && rect.height >= 40 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
    );
    if (!visible.length) return root?.getBoundingClientRect?.() || null;
    const biggest = visible.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    return biggest || root?.getBoundingClientRect?.() || null;
  }

  function carouselControlLabel(element) {
    if (!(element instanceof Element)) return "";
    const values = [
      element.getAttribute("aria-label"), element.getAttribute("title"),
      element.getAttribute("data-testid"), element.textContent
    ];
    for (const node of element.querySelectorAll?.("[aria-label],[title],svg title") || []) {
      values.push(node.getAttribute?.("aria-label"), node.getAttribute?.("title"), node.textContent);
    }
    return values.filter(Boolean).join(" ").replace(/\s+/g," ").trim();
  }

  function clickableCarouselControl(node) {
    if (!(node instanceof Element)) return null;
    const direct = node.closest?.("button,[role='button'],a[href],[tabindex]");
    if (direct) return direct;
    let current = node.parentElement;
    for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
      try {
        const style = getComputedStyle(current);
        if (typeof current.onclick === "function" || style.cursor === "pointer") return current;
      } catch (_) {}
    }
    return null;
  }

  function instagramCarouselButtons(root, direction) {
    const words = direction === "next"
      ? /(?:^|\b)(?:next|পরবর্তী|suivant|siguiente|weiter|avanti|pr[oó]ximo|seguinte|次へ|다음|التالي)(?:\b|$)/i
      : /(?:^|\b)(?:previous|prev|আগের|pr[eé]c[eé]dent|anterior|zur[uü]ck|indietro|戻る|이전|السابق)(?:\b|$)/i;
    const viewport = carouselViewportRect(root);
    const dialog = root?.closest?.("[role='dialog']");
    const scopes = [root, dialog, root?.parentElement, dialog?.parentElement, document].filter(Boolean);
    const candidates = [];
    const seen = new Set();

    const add = (control, labelled = false, label = "") => {
      if (!(control instanceof Element) || seen.has(control)) return;
      seen.add(control);
      if (control.matches?.(":disabled") || control.getAttribute("aria-disabled") === "true") return;
      const rect = control.getBoundingClientRect?.();
      if (!rect || rect.width < 4 || rect.height < 4) return;
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const inVerticalBand = !viewport || (centerY >= viewport.top - Math.max(50, viewport.height * .18) && centerY <= viewport.bottom + Math.max(50, viewport.height * .18));
      if (!inVerticalBand) return;
      const onCorrectSide = !viewport || (direction === "next"
        ? centerX >= viewport.left + viewport.width * .55
        : centerX <= viewport.left + viewport.width * .45);
      if (!labelled && !onCorrectSide) return;
      // Instagram sometimes stretches the clickable navigation layer over a large
      // portion of the photo. A labelled control must therefore not be rejected
      // merely because its transparent hit area is larger than the visible arrow.
      if (!labelled && (rect.width > 150 || rect.height > 150)) return;
      const edgeDistance = viewport ? (direction === "next" ? Math.abs(viewport.right - centerX) : Math.abs(centerX - viewport.left)) : 9999;
      const verticalDistance = viewport ? Math.abs((viewport.top + viewport.height / 2) - centerY) : 9999;
      candidates.push({control,labelled,label,edgeDistance,verticalDistance,area:rect.width*rect.height});
    };

    for (const scope of scopes) {
      // Start from every labelled descendant, including SVGs whose clickable
      // ancestor is an otherwise unlabelled div.
      for (const labelledNode of scope.querySelectorAll?.("[aria-label],[title],svg title") || []) {
        const label = carouselControlLabel(labelledNode);
        if (!words.test(label)) continue;
        add(clickableCarouselControl(labelledNode), true, label);
      }
      for (const control of scope.querySelectorAll?.("button,[role='button'],a[href],[tabindex]") || []) {
        const label = carouselControlLabel(control);
        add(control, words.test(label), label);
      }
    }
    candidates.sort((a,b) => Number(b.labelled)-Number(a.labelled) || a.edgeDistance-b.edgeDistance || a.verticalDistance-b.verticalDistance || a.area-b.area);
    return candidates.map(row => row.control);
  }

  function instagramCarouselButton(root, direction) {
    return instagramCarouselButtons(root,direction)[0] || null;
  }

  function normalizeCarouselUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (/^(?:data:|blob:)/i.test(raw)) return raw;
    try {
      const url = new URL(raw, location.href);
      url.hash = "";
      for (const key of [...url.searchParams.keys()]) {
        if (/^(?:stp|dst-jpg|ccb|oh|oe|_nc_|_nc_cat|_nc_sid|_nc_ohc|_nc_ht|ig_cache_key)$/i.test(key)) url.searchParams.delete(key);
      }
      return `${url.origin}${url.pathname}`.toLowerCase();
    } catch (_) {
      return raw.replace(/[?#].*$/, "").toLowerCase();
    }
  }

  function carouselResourceKey(resource) {
    const candidates = Array.isArray(resource?.candidates) ? resource.candidates : [];
    const values = [resource?.url, ...candidates.map(row => typeof row === "string" ? row : row?.url)].filter(Boolean);
    return normalizeCarouselUrl(values[0] || "");
  }

  function carouselStateSignature(root) {
    const rows = [];
    for (const node of largeCarouselMedia(root)) {
      const rect = node.getBoundingClientRect?.();
      if (!rect || rect.width < 20 || rect.height < 20 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
      rows.push(`${normalizeCarouselUrl(carouselMediaUrl(node))}:${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`);
    }
    const current = root?.querySelector?.('[aria-current="true"],[aria-selected="true"]');
    if (current) rows.push(`current:${current.getAttribute("aria-label") || current.textContent || "1"}`);
    return rows.sort().join("|");
  }

  async function waitForCarouselChange(root, before, timeout = 2100) {
    const started = performance.now();
    let changedAt = 0;
    while (performance.now() - started < timeout) {
      await new Promise(resolve => setTimeout(resolve, 70));
      const current = carouselStateSignature(root);
      if (current && current !== before) {
        if (!changedAt) changedAt = performance.now();
        if (performance.now() - changedAt >= 140) return true;
      } else {
        changedAt = 0;
      }
    }
    return false;
  }

  function instagramTargetShortcode(root) {
    const values = [location.href];
    for (const link of root?.querySelectorAll?.('a[href*="/p/"],a[href*="/reel/"],a[href*="/tv/"]') || []) values.push(link.href || link.getAttribute("href") || "");
    for (const value of values) {
      try {
        const match = new URL(value, location.href).pathname.match(/\/(?:p|reel|tv)\/([^/?#]+)/i);
        if (match?.[1]) return match[1];
      } catch (_) {}
    }
    return "";
  }

  function instagramEmbeddedResource(media, index = 0) {
    if (!media || typeof media !== "object") return null;
    const candidates = [];
    const add = (value, width = 0, height = 0, source = "instagram-data") => {
      const url = absoluteUrl(String(value || "").replace(/\\u0026/gi, "&").replace(/\\\//g, "/"));
      if (!url || candidates.some(row => row.url === url)) return;
      candidates.push({url, rank:Math.max(1, Number(width||0)*Number(height||0)), authoritative:true, source});
    };
    for (const row of media?.image_versions2?.candidates || media?.image_versions?.candidates || []) add(row?.url, row?.width, row?.height, "instagram-image-data");
    for (const row of media?.display_resources || media?.thumbnail_resources || []) add(row?.src || row?.url, row?.config_width || row?.width, row?.config_height || row?.height, "instagram-display-data");
    add(media?.display_url || media?.displayUrl || media?.thumbnail_src || media?.thumbnail_url || media?.image_url, media?.dimensions?.width || media?.original_width, media?.dimensions?.height || media?.original_height, "instagram-display-url");
    const videos = media?.video_versions || media?.videoVersions || [];
    for (const row of videos) add(row?.url, row?.width, row?.height, "instagram-video-data");
    add(media?.video_url || media?.videoUrl, media?.dimensions?.width || media?.original_width, media?.dimensions?.height || media?.original_height, "instagram-video-url");
    candidates.sort((a,b) => b.rank-a.rank);
    if (!candidates.length) return null;
    const isVideo = Boolean(videos.length || media?.video_url || media?.videoUrl || Number(media?.media_type) === 2 || media?.is_video);
    const videoCandidates = isVideo ? candidates.filter(row => /instagram-video/.test(row.source)) : [];
    const orderedCandidates = videoCandidates.length ? [...videoCandidates, ...candidates.filter(row => !videoCandidates.includes(row))] : candidates;
    const caption = cleanText(media?.accessibility_caption || media?.accessibilityCaption || media?.caption?.text || media?.title || document.title, 220);
    return {
      url:orderedCandidates[0].url,
      candidates:orderedCandidates,
      mediaKind:isVideo ? "video" : "image",
      pageUrl:location.href,
      pageTitle:document.title || "",
      suggestedName:caption || "Instagram carousel",
      instagramMediaId:String(media?.id || media?.pk || media?.shortcode || index || ""),
      detailPageUrls:[location.href]
    };
  }

  function collectInstagramEmbeddedCarousel(root, resources) {
    const shortcode = instagramTargetShortcode(root);
    if (!shortcode) return;
    const scripts = [...document.scripts].filter(script => /json/i.test(script.type || "") && script.textContent && script.textContent.length < 8 * 1024 * 1024).slice(0, 40);
    let visited = 0;
    const addMedia = media => {
      const resource = instagramEmbeddedResource(media, resources.size + 1);
      const key = carouselResourceKey(resource);
      if (resource && key && !resources.has(key)) resources.set(key, resource);
    };
    const inspectCarousel = object => {
      const edgeRows = object?.edge_sidecar_to_children?.edges;
      if (Array.isArray(edgeRows)) edgeRows.forEach(row => addMedia(row?.node || row));
      for (const key of ["carousel_media", "carouselMedia"]) {
        if (Array.isArray(object?.[key])) object[key].forEach(addMedia);
      }
    };
    const walk = (value, depth = 0, inheritedMatch = false) => {
      if (!value || typeof value !== "object" || depth > 16 || visited++ > 80000) return;
      const ownCode = String(value?.shortcode || value?.code || value?.media?.code || "");
      const matched = inheritedMatch || ownCode === shortcode;
      if (matched) inspectCarousel(value);
      if (Array.isArray(value)) {
        for (const row of value) walk(row, depth + 1, matched);
      } else {
        for (const row of Object.values(value)) walk(row, depth + 1, matched);
      }
    };
    for (const script of scripts) {
      try { walk(JSON.parse(script.textContent), 0, false); } catch (_) {}
      if (resources.size >= 50) break;
    }
  }


  function carouselIndicatorInfo(root) {
    let total = 0;
    let current = 0;
    const candidates = root?.querySelectorAll?.("[aria-label],[aria-valuetext],[aria-current],[aria-selected]") || [];
    for (const node of candidates) {
      const label = `${node.getAttribute?.("aria-label")||""} ${node.getAttribute?.("aria-valuetext")||""} ${node.textContent||""}`.replace(/\s+/g," ");
      for (const pattern of [
        /(?:slide|photo|image)?\s*(\d+)\s*(?:of|out of|\/)\s*(\d+)/i,
        /(?:go to|show)\s+(?:slide|photo|image)\s*(\d+)(?:\s*(?:of|\/)\s*(\d+))?/i
      ]) {
        const match = label.match(pattern);
        if (!match) continue;
        current = Math.max(current, Number(match[1]||0));
        total = Math.max(total, Number(match[2]||0), Number(match[1]||0));
      }
      if (node.getAttribute?.("aria-current") === "true" || node.getAttribute?.("aria-selected") === "true") {
        const number = Number(label.match(/\d+/)?.[0] || 0);
        if (number) current = number;
      }
    }

    // Instagram's dot row is often unlabelled. Detect a compact horizontal
    // cluster of 3–50 tiny circles located directly below the media viewport.
    const viewport = carouselViewportRect(root);
    let dotCount = 0;
    if (viewport) {
      for (const container of root?.querySelectorAll?.("div,ul,ol") || []) {
        const children = [...container.children];
        if (children.length < 3 || children.length > 50) continue;
        const rects = children.map(child => child.getBoundingClientRect?.()).filter(Boolean);
        if (rects.length !== children.length) continue;
        const tiny = rects.every(rect => rect.width >= 2 && rect.height >= 2 && rect.width <= 18 && rect.height <= 18);
        if (!tiny) continue;
        const top = Math.min(...rects.map(rect => rect.top));
        const bottom = Math.max(...rects.map(rect => rect.bottom));
        const left = Math.min(...rects.map(rect => rect.left));
        const right = Math.max(...rects.map(rect => rect.right));
        const aligned = bottom - top <= 22 && right - left <= Math.max(260, children.length * 24);
        const nearMedia = top >= viewport.bottom - 45 && top <= viewport.bottom + 90;
        if (aligned && nearMedia) dotCount = Math.max(dotCount, children.length);
      }
    }
    total = Math.max(total,dotCount);
    return {current,total};
  }

  function dominantCarouselMedia(root) {
    const viewport = carouselViewportRect(root) || root?.getBoundingClientRect?.();
    if (!viewport) return largeCarouselMedia(root)[0] || null;
    const centerX = viewport.left + viewport.width/2;
    const centerY = viewport.top + viewport.height/2;
    const rows = [];
    for (const node of largeCarouselMedia(root)) {
      const rect = node.getBoundingClientRect?.();
      if (!rect) continue;
      const overlapW = Math.max(0,Math.min(rect.right,viewport.right)-Math.max(rect.left,viewport.left));
      const overlapH = Math.max(0,Math.min(rect.bottom,viewport.bottom)-Math.max(rect.top,viewport.top));
      const overlap = overlapW*overlapH;
      if (overlap <= 0) continue;
      const nodeCenterX = rect.left+rect.width/2;
      const nodeCenterY = rect.top+rect.height/2;
      const distance = Math.hypot(nodeCenterX-centerX,nodeCenterY-centerY);
      const visible = rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth ? 1:0;
      rows.push({node,visible,overlap,distance,area:rect.width*rect.height});
    }
    rows.sort((a,b)=>b.visible-a.visible||b.overlap-a.overlap||a.distance-b.distance||b.area-a.area);
    return rows[0]?.node || largeCarouselMedia(root)[0] || null;
  }

  async function waitForCarouselMediaReady(root, timeout=1800) {
    const node=dominantCarouselMedia(root);
    if (!node) return;
    if (node instanceof HTMLImageElement) {
      if (node.complete && node.naturalWidth>0) {
        try { await Promise.race([node.decode(),new Promise(resolve=>setTimeout(resolve,450))]); } catch (_) {}
        return;
      }
      await Promise.race([
        new Promise(resolve=>{node.addEventListener("load",resolve,{once:true});node.addEventListener("error",resolve,{once:true});}),
        new Promise(resolve=>setTimeout(resolve,timeout))
      ]);
    } else if (node instanceof HTMLVideoElement && node.readyState<2) {
      await Promise.race([
        new Promise(resolve=>{node.addEventListener("loadeddata",resolve,{once:true});node.addEventListener("error",resolve,{once:true});}),
        new Promise(resolve=>setTimeout(resolve,timeout))
      ]);
    }
  }

  function carouselSlideIdentity(root) {
    const node=dominantCarouselMedia(root);
    const url=normalizeCarouselUrl(carouselMediaUrl(node));
    const rect=node?.getBoundingClientRect?.();
    const indicator=carouselIndicatorInfo(root);
    const transforms=[];
    let current=node;
    for(let depth=0;current&&depth<6;depth+=1,current=current.parentElement){
      const transform=current.style?.transform||current.getAttribute?.("style")||"";
      const hidden=current.getAttribute?.("aria-hidden")||"";
      if(transform||hidden)transforms.push(`${transform}:${hidden}`);
    }
    return `${url}|${indicator.current}/${indicator.total}|${Math.round(rect?.left||0)}:${Math.round(rect?.top||0)}|${transforms.join(";")}`;
  }

  async function clickCarouselControl(control,direction,root) {
    if (!(control instanceof Element)) return false;
    try { control.scrollIntoView?.({block:"nearest",inline:"nearest"}); } catch (_) {}
    try { control.focus?.({preventScroll:true}); } catch (_) {}
    try {
      // HTMLElement.click is the most compatible path for React's delegated
      // handler. Use a synthetic pointer sequence only when click is unavailable.
      if (typeof control.click === "function") control.click();
      else {
        const rect=control.getBoundingClientRect?.();
        const init={bubbles:true,cancelable:true,composed:true,clientX:(rect?.left||0)+(rect?.width||0)/2,clientY:(rect?.top||0)+(rect?.height||0)/2,button:0};
        for(const type of ["pointerdown","mousedown","pointerup","mouseup","click"]) control.dispatchEvent(new MouseEvent(type,init));
      }
      return true;
    } catch (_) {}
    try {
      const key=direction==="next"?"ArrowRight":"ArrowLeft";
      (dominantCarouselMedia(root)||root||document.body).dispatchEvent(new KeyboardEvent("keydown",{key,code:key,bubbles:true,cancelable:true}));
      return true;
    } catch (_) { return false; }
  }

  async function advanceCarousel(root,direction,before,timeout=3600) {
    const controls=instagramCarouselButtons(root,direction).slice(0,4);
    for(const control of controls){
      if(!await clickCarouselControl(control,direction,root))continue;
      if(await waitForCarouselChange(root,before,timeout)){
        await waitForCarouselMediaReady(root,1800);
        return true;
      }
    }
    // Some Instagram layouts expose no semantic button but still respond to
    // arrow keys when the media stage owns focus.
    try {
      const node=dominantCarouselMedia(root)||root;
      node?.focus?.({preventScroll:true});
      const key=direction==="next"?"ArrowRight":"ArrowLeft";
      for(const type of ["keydown","keyup"]) node?.dispatchEvent?.(new KeyboardEvent(type,{key,code:key,bubbles:true,cancelable:true}));
      if(await waitForCarouselChange(root,before,1600)){
        await waitForCarouselMediaReady(root,1200);
        return true;
      }
    } catch (_) {}
    return false;
  }

  async function collectInstagramMainWorldCarousel(root,resources) {
    const shortcode=instagramTargetShortcode(root);
    const rect=dominantCarouselMedia(root)?.getBoundingClientRect?.() || carouselViewportRect(root) || root?.getBoundingClientRect?.();
    if(!rect)return 0;
    try{
      const response=await chrome.runtime.sendMessage({
        action:"moodboxDownload-instagram-carousel-data",
        shortcode,
        point:{x:rect.left+rect.width/2,y:rect.top+rect.height/2,width:rect.width,height:rect.height}
      });
      if(!response?.ok)return Number(response?.totalHint||0);
      for(const media of response.items||[]){
        const resource=instagramEmbeddedResource(media,resources.size+1);
        const key=carouselResourceKey(resource);
        if(resource&&key&&!resources.has(key))resources.set(key,resource);
      }
      return Number(response.totalHint||response.items?.length||0);
    }catch(_){return 0}
  }

  function collectVisibleCarouselResources(root,resources) {
    const ordered=[];
    const dominant=dominantCarouselMedia(root);
    if(dominant)ordered.push(dominant);
    for(const node of largeCarouselMedia(root))if(!ordered.includes(node))ordered.push(node);
    for(const node of ordered){
      const resource=buildResource(node);
      const key=carouselResourceKey(resource);
      if(resource&&key&&!resources.has(key))resources.set(key,resource);
    }
  }

  async function collectInstagramCarouselResources(target) {
    const initialRoot=instagramCarouselRoot(target);
    if(!initialRoot)return[];
    const resources=new Map();
    let expected=carouselIndicatorInfo(initialRoot).total;

    // First read Instagram's React/page data in the MAIN world. Current builds
    // commonly keep every carousel member there even though only the current and
    // next slide exist as image nodes in the isolated content-script DOM.
    expected=Math.max(expected,await collectInstagramMainWorldCarousel(initialRoot,resources));
    collectInstagramEmbeddedCarousel(initialRoot,resources);
    collectVisibleCarouselResources(initialRoot,resources);
    expected=Math.max(expected,carouselIndicatorInfo(initialRoot).total);

    let advanced=0;
    let stagnant=0;
    const seenStates=new Set([carouselSlideIdentity(initialRoot)]);
    const maxSteps=Math.min(60,Math.max(expected?expected+5:24,12));

    // If MAIN-world extraction already delivered the indicated number, avoid
    // disturbing the user's carousel. Otherwise walk every slide with fresh DOM
    // lookups because Instagram replaces navigation controls after each move.
    if(!(expected>1&&resources.size>=expected)){
      for(let step=0;step<maxSteps;step+=1){
        const root=instagramCarouselRoot(target)||initialRoot;
        const indicator=carouselIndicatorInfo(root);
        expected=Math.max(expected,indicator.total);
        if(expected>1&&resources.size>=expected)break;
        const before=carouselSlideIdentity(root);
        const beforeCount=resources.size;
        const moved=await advanceCarousel(root,"next",before,3800);
        if(!moved){
          stagnant+=1;
          if(stagnant>=2)break;
          await new Promise(resolve=>setTimeout(resolve,250));
          continue;
        }
        advanced+=1;
        stagnant=0;
        const freshRoot=instagramCarouselRoot(target)||root;
        collectVisibleCarouselResources(freshRoot,resources);
        collectInstagramEmbeddedCarousel(freshRoot,resources);
        expected=Math.max(expected,carouselIndicatorInfo(freshRoot).total);
        const state=carouselSlideIdentity(freshRoot);
        if(seenStates.has(state)&&resources.size===beforeCount)break;
        seenStates.add(state);
        // Refresh MAIN-world data after the first successful move; React often
        // hydrates the complete sidecar object only after carousel interaction.
        if(advanced===1||resources.size<expected){
          expected=Math.max(expected,await collectInstagramMainWorldCarousel(freshRoot,resources));
        }
        if(!instagramCarouselButton(freshRoot,"next")&&(!expected||resources.size>=expected))break;
      }
    }

    // One final data pass catches media hydrated during navigation.
    const finalRoot=instagramCarouselRoot(target)||initialRoot;
    expected=Math.max(expected,await collectInstagramMainWorldCarousel(finalRoot,resources));
    collectInstagramEmbeddedCarousel(finalRoot,resources);
    collectVisibleCarouselResources(finalRoot,resources);

    // Restore the original slide without making successful collection depend on
    // the restoration. Fresh controls are resolved on every iteration.
    for(let step=0;step<advanced;step+=1){
      const root=instagramCarouselRoot(target)||initialRoot;
      const before=carouselSlideIdentity(root);
      if(!await advanceCarousel(root,"previous",before,1700))break;
    }

    const list=[...resources.values()].slice(0,60);
    const base=list[0]?.suggestedName||"Instagram carousel";
    list.forEach((resource,index)=>{
      resource.suggestedName=base;
      resource.collectionName=base;
      resource.collectionIndex=index+1;
      resource.collectionExpected=expected||list.length;
    });
    return list;
  }

  async function downloadResourcesForTarget(target) {
    if (!downloadCompatibleTarget(target, currentResource)) {
      throw new Error("This is a video. Use Download Thumbnail instead.");
    }

    const fallback = buildResource(target);
    if (!fallback || videoResource(fallback)) return [];

    // Hover download is intentionally single-item. Even when a post contains
    // several slides, resolve only the exact still image under this button.
    const exactImage = await resolveCurrentSocialImageResource(target, fallback);
    return [exactImage || fallback];
  }

  async function downloadThumbnailForTarget(target) {
    const resource = buildVideoThumbnailResource(target);
    if (!resource) throw new Error("No video thumbnail was exposed by this page.");
    return [resource];
  }

  function actionKey(kind, target, resource) {
    const rect = target?.getBoundingClientRect?.();
    return [
      kind,
      String(resource?.url || resource?.previewUrl || ""),
      String(resource?.postId || resource?.youtubeVideoId || ""),
      Math.round(Number(rect?.left || 0)),
      Math.round(Number(rect?.top || 0))
    ].join("|");
  }

  async function sendMoodboxResource(targetSnapshot, resourceSnapshot, projectId, button = null) {
    if (!targetSnapshot || !resourceSnapshot) throw new Error("Could not read this image.");
    const key = `${actionKey("moodbox", targetSnapshot, resourceSnapshot)}::${String(projectId || "")}`;
    if (inFlightActionKeys.has(key)) {
      toast("This item is already being processed");
      return null;
    }
    inFlightActionKeys.add(key);
    if (button) button.disabled = true;
    clearTimeout(hideTimer);
    try {
      const response = await chrome.runtime.sendMessage({
        action:"moodbox-direct-send",
        resource:resourceSnapshot,
        projectId:String(projectId || "")
      });
      if (!response?.ok) {
        const rawError = String(response?.error || "Could not send this image to MoodBox.");
        if (/resolveResourceName\s+is\s+not\s+defined/i.test(rawError)) {
          throw new Error("MoodBox service needs to be reloaded. Open the extension once, then try again.");
        }
        throw new Error(rawError);
      }
      moodboxProjectActive = true;
      moodboxProjectName = String(response.projectName || moodboxProjectName || "MoodBox");
      const usedId = String(response.projectId || projectId || "");
      if (usedId && moodboxProjects.length) {
        const used = moodboxProjects.find(row => String(row.id) === usedId);
        if (used) moodboxProjects = [used, ...moodboxProjects.filter(row => String(row.id) !== usedId)];
        moodboxStateCheckedAt = Date.now();
      }
      toast(`✓ Added to MoodBox${moodboxProjectName && moodboxProjectName !== "MoodBox" ? ` · ${moodboxProjectName}` : ""}`);
      return response;
    } finally {
      inFlightActionKeys.delete(key);
      if (button) button.disabled = false;
    }
  }

  function closeMoodboxTargetMenu() {
    targetMenu.replaceChildren();
    targetMenu.hidden = true;
  }

  async function openMoodboxTargetMenu(targetSnapshot, resourceSnapshot, anchorButton, projects) {
    targetMenu.replaceChildren();
    targetMenu.hidden = false;
    const rows = Array.isArray(projects) ? projects.filter(project => project?.id) : [];
    if (!rows.length) {
      closeMoodboxTargetMenu();
      throw new Error("Activate MoodBox and create at least one MoodBox first.");
    }
    if (rows.length === 1) {
      closeMoodboxTargetMenu();
      return sendMoodboxResource(targetSnapshot, resourceSnapshot, rows[0].id, anchorButton);
    }
    rows.forEach(project => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "target-row";
      row.title = String(project.name || "MoodBox");
      const image = document.createElement("img");
      image.src = chrome.runtime.getURL("logo.png");
      image.alt = "";
      const text = document.createElement("span");
      text.textContent = String(project.name || "MoodBox");
      row.append(image, text);
      row.addEventListener("pointerdown", event => {
        event.preventDefault();
        event.stopPropagation();
        overlayHovered = true;
        clearTimeout(hideTimer);
      }, true);
      row.addEventListener("click", async event => {
        event.preventDefault();
        event.stopPropagation();
        closeMoodboxTargetMenu();
        try { await sendMoodboxResource(targetSnapshot, resourceSnapshot, project.id, anchorButton); }
        catch (error) { toast(error?.message || "Could not send this image to MoodBox.", true); }
      }, true);
      targetMenu.appendChild(row);
    });
    const first = targetMenu.querySelector(".target-row");
    first?.focus?.();
  }

  function makeButton(kind, label, icon) {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    const image = document.createElement("img");
    image.src = chrome.runtime.getURL(icon);
    image.alt = "";
    const tooltip = document.createElement("span");
    tooltip.className = "tip";
    tooltip.textContent = label;
    button.append(image, tooltip);

    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      event.stopPropagation();
      overlayHovered = true;
      clearTimeout(hideTimer);
    }, true);
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      if (!currentTarget || button.disabled) return;

      // Lock the exact media under this button. The pointer may move to another
      // image while resolution/network work continues, but this job must never
      // switch to that later target.
      const targetSnapshot = currentTarget;
      const resourceSnapshot = currentResource || buildResource(targetSnapshot);
      if (targetBlockedByPlayingVideo(targetSnapshot)) {
        hideOverlay();
        return;
      }
      const key = actionKey(kind, targetSnapshot, resourceSnapshot);
      if (inFlightActionKeys.has(key)) {
        toast("This item is already being processed");
        return;
      }

      inFlightActionKeys.add(key);
      button.disabled = true;
      clearTimeout(hideTimer);
      try {
        if (kind === "moodbox") {
          let projects = (Date.now() - moodboxStateCheckedAt < 1800 && moodboxProjects.length)
            ? moodboxProjects.slice()
            : [];
          if (!projects.length) {
            const state = await chrome.runtime.sendMessage({action:"moodbox-get-projects"}).catch(() => ({ok:false, projects:[]}));
            projects = Array.isArray(state?.projects) ? state.projects.filter(row => row?.id) : [];
            if (state?.ok) {
              moodboxProjects = projects.slice();
              moodboxProjectActive = projects.length > 0;
              moodboxStateCheckedAt = Date.now();
            }
          }
          if (!projects.length) throw new Error("Activate MoodBox and create at least one MoodBox first.");
          if (projects.length > 1) {
            await openMoodboxTargetMenu(targetSnapshot, resourceSnapshot, button, projects);
          } else {
            await sendMoodboxResource(targetSnapshot, resourceSnapshot, projects[0].id, button);
          }
        } else if (kind === "thumbnail") {
          const resources = await downloadThumbnailForTarget(targetSnapshot);
          if (!resources.length) throw new Error("No video thumbnail was exposed by this page.");
          let response = null;
          try {
            response = await chrome.runtime.sendMessage({action:"moodboxDownload-download-media",resource:resources[0]});
          } catch (_) {
            throw new Error("MoodBox extension service is unavailable. Reload the extension and this page.");
          }
          if (!response?.ok) throw new Error(response?.error || "Thumbnail download failed.");
          toast("Thumbnail download started");
        } else {
          const resources = await downloadResourcesForTarget(targetSnapshot);
          if (!resources.length) throw new Error("No downloadable media source was exposed by this page.");
          let response = null;
          try {
            response = await chrome.runtime.sendMessage(resources.length > 1 ? {
              action:"moodboxDownload-download-media-list",resources
            } : {
              action:"moodboxDownload-download-media",resource:resources[0]
            });
          } catch (_) {
            throw new Error("MoodBox extension service is unavailable. Reload the extension and this page.");
          }
          if (!response?.ok) throw new Error(response?.error || "Download failed.");
          const count = Number(response.started || 0);
          const failed = Number(response.failed || 0);
          if (failed > 0 || !count) toast("Download failed", true);
          else toast("Download started");
        }
      } catch (error) {
        toast(error?.message || "Action failed", true);
      } finally {
        inFlightActionKeys.delete(key);
        button.disabled = false;
        scheduleHide(420);
      }
    }, true);
    if (kind === "download") {
      button.addEventListener("contextmenu", async event => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await chrome.storage.local.set({downloadHoverEnabled:false});
          downloadHoverEnabled = false;
          downloadSettingsReady = true;
          toast("Download hover inactive");
          renderOverlay();
        } catch (_) {
          toast("Could not disable Download hover", true);
        }
      }, true);
    }
    return button;
  }

  function renderOverlay() {
    refreshMoodboxState(false).catch(() => {});
    const active = actionState();
    if (!currentTarget) {
      hideOverlay();
      return;
    }
    if (!active.download && !active.moodbox) {
      // Settings/project checks are asynchronous. Keep the current media target
      // long enough for either check to finish, but never show an empty pill.
      if (!downloadSettingsReady || moodboxStateRequest || !moodboxStateCheckedAt) {
        overlayHost.style.display = "none";
        overlayHost.setAttribute("aria-hidden", "true");
        currentSignature = "";
        currentPlacement = "";
        actions.replaceChildren();
        return;
      }
      hideOverlay();
      return;
    }
    const targetSignature = actionKey("overlay", currentTarget, currentResource);
    const signature = `${active.download ? "d" : ""}${active.moodbox ? "m" : ""}:${targetSignature}`;
    if (signature !== currentSignature) {
      currentSignature = signature;
      currentPlacement = "";
      actions.replaceChildren();
      if (active.download) actions.appendChild(makeButton("download", "Download · right-click to deactivate", "download.png"));
      if (active.moodbox) {
        const mbLabel = moodboxProjects.length > 1 ? "Send to MoodBox" : `Send to ${moodboxProjectName}`;
        actions.appendChild(makeButton("moodbox", mbLabel, "logo.png"));
      }
    }
    overlayHost.style.display = "block";
    overlayHost.setAttribute("aria-hidden", "false");
    positionOverlay();
  }

  function placementCollisionScore(x, y, width, height) {
    const points = [
      [x + 3, y + 3], [x + width / 2, y + 3], [x + width - 3, y + 3],
      [x + 3, y + height / 2], [x + width / 2, y + height / 2], [x + width - 3, y + height / 2],
      [x + 3, y + height - 3], [x + width / 2, y + height - 3], [x + width - 3, y + height - 3]
    ];
    let score = 0;
    const counted = new Set();
    for (const [px, py] of points) {
      for (const node of document.elementsFromPoint(px, py).slice(0, 5)) {
        if (!(node instanceof Element) || node === overlayHost || node.closest?.("#moodbox-unified-hover-actions-host")) continue;
        if (node === currentTarget || node.matches?.("img,video,canvas,svg image")) continue;
        const interactive = node.closest?.("button,a,input,select,textarea,[role='button'],[role='menuitem'],[aria-haspopup]");
        if (interactive && !counted.has(interactive)) {
          counted.add(interactive);
          score += 100;
          continue;
        }
        try {
          if (getComputedStyle(node).cursor === "pointer" && !counted.has(node)) {
            counted.add(node);
            score += 35;
          }
        } catch (_) {}
      }
    }
    return score;
  }

  function positionOverlay() {
    let rect = null;
    if (currentTarget?.isConnected) rect = visibleRect(currentTarget);
    if (rect) lastTargetRect = rect;
    rect = rect || lastTargetRect;
    if (!rect) {
      if (!overlayHovered) hideOverlay();
      return;
    }
    const width = overlayHost.offsetWidth || Math.max(36, actions.childElementCount * 31 + 10);
    const height = overlayHost.offsetHeight || 36;
    const inset = 7;
    const centerX = rect.left + (rect.width - width) / 2;
    const centerY = rect.top + (rect.height - height) / 2;
    const placements = [
      {id:"top-center",x:centerX,y:rect.top+inset,preference:0},
      {id:"center",x:centerX,y:centerY,preference:8},
      {id:"bottom-center",x:centerX,y:rect.bottom-height-inset,preference:12},
      {id:"left-center",x:rect.left+inset,y:centerY,preference:18},
      {id:"right-center",x:rect.right-width-inset,y:centerY,preference:18}
    ].map(row => ({
      ...row,
      x:Math.max(4,Math.min(innerWidth-width-4,row.x)),
      y:Math.max(4,Math.min(innerHeight-height-4,row.y))
    }));

    // Keep one placement for the life of the hovered target. Re-scoring while a
    // site's native controls animate in/out makes the icon jump and can move it
    // away between pointerdown and click.
    let best = currentPlacement ? placements.find(row => row.id === currentPlacement) : null;
    if (!best) {
      best = placements.map(row => ({
        ...row,
        score:row.preference + placementCollisionScore(row.x,row.y,width,height)
      })).sort((a,b)=>a.score-b.score)[0];
      currentPlacement = best?.id || "top-center";
    }
    overlayHost.style.left = `${Math.round(best.x)}px`;
    overlayHost.style.top = `${Math.round(best.y)}px`;
  }

  function hideOverlay() {
    clearTimeout(hideTimer);
    overlayHost.style.display = "none";
    overlayHost.setAttribute("aria-hidden", "true");
    currentTarget = null;
    currentResource = null;
    currentSignature = "";
    currentPlacement = "";
    lastTargetRect = null;
    overlayHovered = false;
    actions.replaceChildren();
    closeMoodboxTargetMenu();
  }

  function scheduleHide(delay = 360) {
    clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (overlayHovered) return;
      const overlayRect = overlayHost.getBoundingClientRect();
      const targetRect = currentTarget?.isConnected ? currentTarget.getBoundingClientRect() : lastTargetRect;
      const insideOverlay = rectContains(overlayRect, lastPointer.x, lastPointer.y, 6);
      const insideTarget = rectContains(targetRect, lastPointer.x, lastPointer.y, 4);
      if (!insideOverlay && !insideTarget) hideOverlay();
    }, delay);
  }

  function toast(text, error = false) {
    document.getElementById("moodbox-unified-action-toast")?.remove();
    const node = document.createElement("div");
    node.id = "moodbox-unified-action-toast";
    node.textContent = text;
    node.style.cssText = `position:fixed;right:20px;bottom:20px;z-index:2147483647;padding:9px 14px;border-radius:9px;background:${error ? "#3A1519" : "#111713"};border:1px solid ${error ? "#E8565F" : "#71d13c"};color:${error ? "#FFD6D9" : "#EEF6EE"};font:600 12px/1.35 Inter,"Segoe UI",sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.42);pointer-events:none`;
    document.documentElement.appendChild(node);
    setTimeout(() => node.remove(), 2400);
  }

  function syncNativeContextTarget(element, resource) {
    if (!(element instanceof Element) || !resource?.url) return;
    const isVideo = Boolean(
      element instanceof HTMLVideoElement ||
      videoResource(resource) ||
      resource.videoThumbnail ||
      resource.youtubeThumbnail ||
      targetLikelySocialVideo(element)
    );
    const contextKind = isVideo ? "video" : "image";
    const signature = `${contextKind}:${actionKey("native-context", element, resource)}`;
    if (signature === lastNativeContextTargetSignature) return;
    lastNativeContextTargetSignature = signature;
    chrome.runtime.sendMessage({
      action:"moodbox-context-target",
      contextKind,
      resource,
      point:{x:Number(lastPointer.x||0),y:Number(lastPointer.y||0)},
      pageUrl:location.href,
      pageTitle:document.title || ""
    }).catch(() => {});
  }

  function inspectPointer() {
    pointerFrame = 0;
    if (overlayHovered || overlayHost.matches?.(":hover")) return;
    const hostRect = overlayHost.getBoundingClientRect();
    if (overlayHost.style.display !== "none" && rectContains(hostRect, lastPointer.x, lastPointer.y, 3)) {
      clearTimeout(hideTimer);
      return;
    }
    const lockedRect = currentTarget?.isConnected ? currentTarget.getBoundingClientRect?.() : lastTargetRect;
    if (overlayHost.style.display !== "none" && rectContains(lockedRect, lastPointer.x, lastPointer.y, 1)) {
      clearTimeout(hideTimer);
      positionOverlay();
      return;
    }
    const element = mediaElementAtPoint(lastPointer.x, lastPointer.y);
    if (!element) {
      if (lastNativeContextTargetSignature && !window.getSelection?.()?.toString?.()?.trim?.()) {
        lastNativeContextTargetSignature = "";
        chrome.runtime.sendMessage({ action: "moodbox-context-target", contextKind: "none", point: lastPointer, pageUrl: location.href, pageTitle: document.title || "" }).catch(() => {});
      }
      scheduleHide();
      return;
    }
    const resource = buildResource(element);
    if (!resource) {
      if (lastNativeContextTargetSignature && !window.getSelection?.()?.toString?.()?.trim?.()) {
        lastNativeContextTargetSignature = "";
        chrome.runtime.sendMessage({ action: "moodbox-context-target", contextKind: "none", point: lastPointer, pageUrl: location.href, pageTitle: document.title || "" }).catch(() => {});
      }
      scheduleHide();
      return;
    }
    clearTimeout(hideTimer);
    const changed = element !== currentTarget;
    currentTarget = element;
    currentResource = resource;
    syncNativeContextTarget(element, resource);
    const rect = visibleRect(element);
    if (rect) lastTargetRect = rect;
    if (changed || overlayHost.style.display === "none") renderOverlay();
    else positionOverlay();
  }

  document.addEventListener("pointermove", event => {
    lastPointer = {x: event.clientX, y: event.clientY};
    if (!pointerFrame) pointerFrame = requestAnimationFrame(inspectPointer);
  }, true);

  // Ctrl+Space downloads the exact still image currently under the mouse.
  // This shortcut is independent of the hover-button setting, but never fires
  // while typing in a form control or while the target is a video.
  document.addEventListener("keydown", event => {
    if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    if (event.code !== "Space" && event.key !== " ") return;
    const active = document.activeElement;
    if (active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))) return;

    const point = {x:Number(lastPointer.x || event.clientX || 0), y:Number(lastPointer.y || event.clientY || 0)};
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;

    const targetAtPointer = mediaElementAtPoint(point.x, point.y);
    const targetSnapshot = targetAtPointer || currentTarget;
    if (!(targetSnapshot instanceof Element) || !targetSnapshot.isConnected) return;

    let resourceSnapshot = null;
    try {
      resourceSnapshot = buildResource(targetSnapshot);
    } catch (_) {}
    if (!resourceSnapshot || videoResource(resourceSnapshot) || targetSnapshot instanceof HTMLVideoElement || targetBlockedByPlayingVideo(targetSnapshot) || targetLikelySocialVideo(targetSnapshot)) return;

    event.preventDefault();
    event.stopPropagation();

    const key = actionKey("ctrl-space", targetSnapshot, resourceSnapshot);
    if (inFlightActionKeys.has(key)) return;
    inFlightActionKeys.add(key);

    (async () => {
      try {
        // Ctrl+Space is a dedicated single-image fast path. It deliberately
        // bypasses the Download Hover on/off setting and never expands a
        // carousel/collection into multiple downloads.
        const response = await chrome.runtime.sendMessage({
          action:"moodboxDownload-hotkey-image",
          resource:resourceSnapshot,
          tabId:0
        });
        if (!response?.ok) throw new Error(response?.error || "Download failed.");
        if (response.skipped) {
          toast("Already downloaded");
        } else {
          toast("Download started");
        }
      } catch (error) {
        toast(error?.message || "Download failed", true);
      } finally {
        inFlightActionKeys.delete(key);
      }
    })();
  }, true);

  document.addEventListener("contextmenu", event => {
    try {
      const point = {x:Number(event.clientX||0), y:Number(event.clientY||0)};
      lastPointer = point;

      // 1. Direct target detection from event.target & composedPath
      let element = null;
      if (event.target instanceof Element) {
        element = mediaElementAtPoint(point.x, point.y, event.target);
      }
      if (!element && event.composedPath) {
        for (const target of event.composedPath()) {
          if (target instanceof Element && (target.matches?.("img, video, canvas") || (target.localName === "image" && target.namespaceURI?.includes("svg")))) {
            element = target;
            break;
          }
        }
      }
      if (!element) {
        element = mediaElementAtPoint(point.x, point.y);
      }
      if (!element && currentTarget?.isConnected) {
        const rect = visibleRect(currentTarget);
        if (rect && rectContains(rect, point.x, point.y, 16)) {
          element = currentTarget;
        }
      }

      // 2. If no media element is at the pointer, check if user right-clicked on selected text
      const isTextSelection = pointIntersectsSelection(point);
      if (!element && isTextSelection) {
        const fontTarget = resolveFontForSelectedText();
        if (fontTarget) {
          const selectedText = window.getSelection()?.toString()?.trim() || "";
          lastRightClickTarget = {
            element: null,
            resource: null,
            fontTarget,
            contextKind: "font",
            point,
            srcUrl: "",
            selectedText,
            time: Date.now()
          };
          chrome.runtime.sendMessage({
            action: "moodbox-context-target",
            contextKind: "font",
            fontTarget,
            selectedText,
            point,
            pageUrl: location.href,
            pageTitle: document.title || ""
          }).catch(() => {});
          return;
        }
      }

      let resource = null;
      let contextKind = "none";
      if (element) {
        resource = buildVideoThumbnailResource(element);
        if (!resource) {
          const videoRoot = targetSocialVideoRoot(element) || element.closest?.("figure,article,li,[role='article'],[role='dialog']");
          if (videoRoot && videoRoot !== element) resource = buildVideoThumbnailResource(videoRoot);
        }
        if (resource) {
          contextKind = "video";
        } else {
          resource = buildResource(element);
          const isVideo = Boolean(
            element instanceof HTMLVideoElement ||
            videoResource(resource) ||
            targetLikelySocialVideo(element)
          );
          contextKind = isVideo ? "video" : (resource ? "image" : "none");
          if (isVideo) {
            resource = buildVideoThumbnailResource(element) || resource;
            if (!resource?.videoThumbnail) {
              const videoRoot = targetSocialVideoRoot(element) || element.closest?.("figure,article,li,[role='article'],[role='dialog']");
              if (videoRoot && videoRoot !== element) resource = buildVideoThumbnailResource(videoRoot) || resource;
            }
          }
        }
      }

      const targetSrc = element instanceof HTMLImageElement ? (element.currentSrc || element.src || "") : (resource?.url || "");
      lastRightClickTarget = {
        element,
        resource,
        contextKind,
        point,
        srcUrl: targetSrc,
        time: Date.now()
      };

      lastNativeContextTargetSignature = contextKind !== "none" && resource?.url
        ? `${contextKind}:${actionKey("native-context", element, resource)}`
        : "";
      chrome.runtime.sendMessage({
        action:"moodbox-context-target",
        contextKind, resource, point,
        srcUrl: targetSrc,
        pageUrl:location.href, pageTitle:document.title || ""
      }).catch(() => {});
    } catch (_) {}
  }, true);

  let selectionDebounceTimer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionDebounceTimer);
    selectionDebounceTimer = setTimeout(() => {
      try {
        const selection = window.getSelection();
        const text = selection?.toString()?.trim();
        if (text && !selection.isCollapsed) {
          const fontTarget = resolveFontForSelectedText();
          if (fontTarget) {
            chrome.runtime.sendMessage({
              action: "moodbox-context-target",
              contextKind: "font",
              fontTarget,
              selectedText: text,
              pageUrl: location.href,
              pageTitle: document.title || ""
            }).catch(() => {});
          }
        }
      } catch (_) {}
    }, 120);
  });

  function refreshForVideoPlayback(event) {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;

    if (event.type === "play" || event.type === "playing") {
      if (currentTarget && targetRelatedToVideo(currentTarget, video)) {
        if (!pointerFrame) pointerFrame = requestAnimationFrame(inspectPointer);
      }
      return;
    }

    // When playback stops, re-check the media currently under the pointer so
    // still-image actions can return without requiring a mouse jiggle.
    if (!pointerFrame) pointerFrame = requestAnimationFrame(inspectPointer);
  }

  for (const type of ["play", "playing", "pause", "ended"]) {
    document.addEventListener(type, refreshForVideoPlayback, true);
  }

  overlayHost.addEventListener("pointerenter", () => {
    overlayHovered = true;
    clearTimeout(hideTimer);
  }, true);
  overlayHost.addEventListener("pointerleave", event => {
    overlayHovered = false;
    lastPointer = {x: event.clientX, y: event.clientY};
    scheduleHide(420);
  }, true);

  document.addEventListener("pointerleave", () => scheduleHide(350), true);
  window.addEventListener("scroll", () => {
    if (overlayHost.style.display !== "none") positionOverlay();
  }, true);
  window.addEventListener("resize", () => {
    if (overlayHost.style.display !== "none") positionOverlay();
  }, true);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hideOverlay();
    else refreshMoodboxState(true).catch(() => {});
  });


  function batchFilename(url, fallback = "image") {
    try {
      const parsed = new URL(String(url || ""), location.href);
      const raw = decodeURIComponent(parsed.pathname.split("/").pop() || "");
      return cleanText(raw, 160) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function batchType(url, mime = "") {
    const source = String(url || "");
    const match = source.split(/[?#]/)[0].match(/\.([a-z0-9]{2,7})$/i);
    if (match) return match[1].toLowerCase().replace("jpeg", "jpg");
    const dataMime = source.match(/^data:([^;,]+)/i)?.[1] || "";
    const fullMime = String(mime || dataMime || "").toLowerCase().split(";")[0].trim();
    const mimeMap = {
      "image/jpeg":"jpg","image/svg+xml":"svg","font/woff":"woff","font/woff2":"woff2","font/ttf":"ttf","font/otf":"otf",
      "application/font-woff":"woff","application/vnd.ms-fontobject":"eot","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov",
      "audio/mpeg":"mp3","audio/mp4":"m4a","audio/wav":"wav","audio/x-wav":"wav","audio/ogg":"ogg","audio/flac":"flac",
      "application/pdf":"pdf","application/json":"json","application/ld+json":"json","text/vtt":"vtt"
    };
    if (mimeMap[fullMime]) return mimeMap[fullMime];
    const fromMime = fullMime.split("/").pop().replace("jpeg", "jpg").replace("svg+xml", "svg").replace("x-font-", "").replace("vnd.ms-fontobject", "eot");
    return fromMime || "asset";
  }

  const batchWarmCandidates = new Map();

  function rememberBatchWarmCandidate(value, meta = {}) {
    const url = absoluteUrl(value);
    if (!url || url.startsWith("chrome-extension:") || /^javascript:/i.test(url)) return;
    const existing = batchWarmCandidates.get(url) || {};
    const oldArea = Number(existing.width || 0) * Number(existing.height || 0);
    const newArea = Number(meta.width || 0) * Number(meta.height || 0);
    const incomingTop = Number(meta.pageTop), existingTop = Number(existing.pageTop);
    const hasIncomingTop = Number.isFinite(incomingTop), hasExistingTop = Number.isFinite(existingTop);
    batchWarmCandidates.set(url, {
      ...existing,
      ...meta,
      url,
      width: newArea >= oldArea ? Number(meta.width || 0) : Number(existing.width || 0),
      height: newArea >= oldArea ? Number(meta.height || 0) : Number(existing.height || 0),
      alt: existing.alt || meta.alt || "",
      filename: existing.filename || meta.filename || "",
      source: existing.source || meta.source || "page-scan",
      bytes: Math.max(Number(existing.bytes || 0), Number(meta.bytes || 0)),
      pageTop: hasIncomingTop && hasExistingTop ? Math.min(incomingTop, existingTop) : hasIncomingTop ? incomingTop : hasExistingTop ? existingTop : null,
      pageLeft: hasIncomingTop && (!hasExistingTop || incomingTop <= existingTop) ? Number(meta.pageLeft || 0) : Number(existing.pageLeft || 0),
      order: Number.isFinite(Number(existing.order)) ? Number(existing.order) : batchWarmCandidates.size
    });
  }

  function snapshotBatchViewport() {
    for (const image of document.images) {
      const rect = image.getBoundingClientRect();
      const meta = {
        width: image.naturalWidth, height: image.naturalHeight, alt: image.alt,
        filename: image.getAttribute("download") || "", source: "page-scan",
        pageTop: Math.max(0, window.scrollY + rect.top), pageLeft: Math.max(0, window.scrollX + rect.left),
        familyKey: `page-${Math.round(window.scrollY + rect.top)}-${Math.round(window.scrollX + rect.left)}-${Math.round(rect.width)}x${Math.round(rect.height)}`
      };
      rememberBatchWarmCandidate(image.currentSrc || image.src, meta);
      rememberBatchWarmCandidate(image.src, meta);
      for (const item of parseSrcset(image.srcset || "")) rememberBatchWarmCandidate(item.url, {...meta, source: "lazy-srcset"});
      for (const name of ["data-src", "data-lazy-src", "data-original", "data-original-src", "data-full", "data-full-src", "data-zoom-image", "data-pin-media", "data-hi-res-src", "data-high-res-src", "data-large", "data-image", "data-url"]) {
        rememberBatchWarmCandidate(image.getAttribute(name), {...meta, source: `lazy-${name}`});
      }
    }
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const initiator = String(entry.initiatorType || "").toLowerCase();
        if (initiator === "img" || initiator === "image" || /\.(?:avif|bmp|gif|ico|jpe?g|png|svgz?|tiff?|webp|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|aac|flac|pdf|vtt|srt)(?:$|[?#])/i.test(String(entry.name || ""))) {
          rememberBatchWarmCandidate(entry.name, {
            source: `network-${initiator || "resource"}`,
            bytes: Number(entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0)
          });
        }
      }
    } catch (_) {}
  }

  function mediaAssetIdentities(value) {
    const source = String(value || "");
    if (!source) return [];
    let decoded = source;
    try { decoded = decodeURIComponent(source); } catch (_) {}
    const found = new Set();
    const addAdobe = id => {
      const clean = String(id || "").trim();
      if (/^\d{6,}$/.test(clean)) found.add(`adobe:${clean}`);
    };

    for (const match of decoded.matchAll(/(?:^|[\\/_-])(?:\d{2,4}_)?F_(\d{6,})(?=[\\/_.?#-]|$)/gi)) addAdobe(match[1]);
    for (const match of decoded.matchAll(/\/video\/(?:[^/?#]+\/)*(\d{6,})(?:$|[/?#])/gi)) addAdobe(match[1]);
    for (const match of decoded.matchAll(/(?:asset|content|video)[-_ ]?id["'=:\s-]*(\d{6,})/gi)) addAdobe(match[1]);

    try {
      const url = new URL(source, document.baseURI);
      const path = decodeURIComponent(url.pathname);
      const named = path.match(/(?:video|footage|clip|asset|media)[\\/_-]+(\d{7,})(?=[\\/_.-]|$)/i)
        || path.match(/[-_](\d{8,})(?=[_.-](?:mp4|webm|mov|m4v|jpe?g|png|webp|avif)(?:$|[?#]))/i);
      if (named?.[1]) found.add(`${url.hostname.toLowerCase()}:${named[1]}`);
    } catch (_) {}
    return [...found];
  }

  function mediaAssetIdentity(value) {
    return mediaAssetIdentities(value)[0] || "";
  }

  function videoCardRoot(node) {
    if (!(node instanceof Element)) return null;
    const structural = node.closest(
      "[data-asset-id],[data-content-id],[data-video-id]," +
      "[data-testid*='asset'],[data-automation*='asset']," +
      "article,figure,li,[role='article']"
    );
    if (structural) return structural;

    let probe = node.parentElement;
    for (let depth = 0; probe && depth < 9; depth += 1, probe = probe.parentElement) {
      const links = probe.querySelectorAll?.(
        "a[href*='/video/'],a[href*='_F_'][href*='.mp4'],[data-asset-id],[data-content-id],[data-video-id]"
      ) || [];
      if (links.length === 1) return probe;
      if (links.length > 1) break;
    }
    return node.parentElement || node;
  }

  function identitiesFromNode(node) {
    const found = new Set();
    const scan = value => mediaAssetIdentities(value).forEach(id => found.add(id));
    let probe = node instanceof Element ? node : null;
    for (let depth = 0; probe && depth < 8; depth += 1, probe = probe.parentElement) {
      scan(probe.getAttribute?.("href"));
      scan(probe.getAttribute?.("src"));
      for (const attribute of probe.attributes || []) {
        const name = String(attribute.name || "").toLowerCase();
        if (name.includes("id") || name.includes("asset") || name.includes("video") || name === "href" || name === "src") {
          scan(attribute.value);
          if (/^(?:data-)?(?:asset|content|video)?-?id$/i.test(name) && /^\d{6,}$/.test(String(attribute.value || ""))) {
            found.add(`adobe:${String(attribute.value).trim()}`);
          }
        }
      }
    }

    const card = videoCardRoot(node);
    if (card) {
      const candidates = card.querySelectorAll?.(
        "a[href*='/video/'],a[href*='_F_'],[data-asset-id],[data-content-id],[data-video-id],[data-id]"
      ) || [];
      for (const candidate of [...candidates].slice(0, 120)) {
        scan(candidate.getAttribute?.("href"));
        for (const name of ["data-asset-id","data-content-id","data-video-id","data-id"]) {
          const value = candidate.getAttribute?.(name);
          if (/^\d{6,}$/.test(String(value || ""))) found.add(`adobe:${String(value).trim()}`);
          else scan(value);
        }
      }
    }
    return [...found];
  }

  function previewRectFor(node) {
    if (!(node instanceof Element)) return null;
    try {
      const rect = node.getBoundingClientRect();
      const left = Number(rect.left || 0), top = Number(rect.top || 0);
      const width = Number(rect.width || 0), height = Number(rect.height || 0);
      if (width < 24 || height < 24) return null;
      return {left, top, width, height};
    } catch (_) {
      return null;
    }
  }

  function buildVideoPreviewIndex() {
    const previews = new Map();

    const remember = (value, node, source = "video-card-thumbnail", extraIdentities = []) => {
      const url = absoluteUrl(value);
      if (!url) return;
      const identities = new Set([...mediaAssetIdentities(url), ...extraIdentities, ...identitiesFromNode(node)]);
      if (!identities.size) return;

      const rect = previewRectFor(node);
      const width = Math.max(0, Number(node?.naturalWidth || node?.videoWidth || rect?.width || 0));
      const height = Math.max(0, Number(node?.naturalHeight || node?.videoHeight || rect?.height || 0));
      const area = width * height;
      const descriptor = `${url} ${node?.alt || ""} ${node?.getAttribute?.("aria-label") || ""}`.toLowerCase();
      if (area && area < 1600) return;
      if (/(?:favicon|site-logo|brand-logo|avatar|profile-icon)/i.test(descriptor) && area < 120000) return;

      for (const identity of identities) {
        const current = previews.get(identity);
        const currentArea = Number(current?.width || 0) * Number(current?.height || 0);
        const currentHasRect = Boolean(current?.previewRect);
        const better = !current || area > currentArea || (area === currentArea && rect && !currentHasRect);
        if (!better) continue;
        previews.set(identity, {
          url,
          width,
          height,
          alt: cleanText(node?.alt || node?.getAttribute?.("aria-label") || "", 220),
          source,
          pageTop: rect ? Math.max(0, window.scrollY + rect.top) : null,
          pageLeft: rect ? Math.max(0, window.scrollX + rect.left) : null,
          previewRect: rect,
          viewportWidth: Number(innerWidth || 0),
          viewportHeight: Number(innerHeight || 0),
          familyKey: `video:${identity}`
        });
      }
    };

    const rememberRectOnly = (node, identities, source = "video-card-rendered") => {
      const rect = previewRectFor(node);
      if (!rect || !identities?.length) return;
      const width = Math.max(0, Number(node?.naturalWidth || node?.videoWidth || rect.width || 0));
      const height = Math.max(0, Number(node?.naturalHeight || node?.videoHeight || rect.height || 0));
      const area = width * height;
      for (const identity of identities) {
        const current = previews.get(identity);
        const currentArea = Number(current?.width || 0) * Number(current?.height || 0);
        if (current?.previewRect && currentArea >= area) continue;
        previews.set(identity, {
          url: String(current?.url || ""),
          width,
          height,
          alt: cleanText(node?.getAttribute?.("aria-label") || "", 220),
          source,
          pageTop: Math.max(0, window.scrollY + rect.top),
          pageLeft: Math.max(0, window.scrollX + rect.left),
          previewRect: rect,
          viewportWidth: Number(innerWidth || 0),
          viewportHeight: Number(innerHeight || 0),
          familyKey: `video:${identity}`
        });
      }
    };

    const bestRenderedNode = card => {
      if (!(card instanceof Element)) return null;
      const candidates = [card, ...card.querySelectorAll("img,video,canvas,picture,[style*='background'],[style*='url(']")];
      let best = null, bestArea = 0;
      for (const node of candidates.slice(0, 80)) {
        const rect = previewRectFor(node);
        if (!rect) continue;
        const area = rect.width * rect.height;
        if (area > bestArea) { best = node; bestArea = area; }
      }
      return best;
    };

    for (const image of document.images) {
      const identities = identitiesFromNode(image);
      remember(image.currentSrc || image.src, image, "video-card-thumbnail", identities);
      remember(image.src, image, "video-card-thumbnail", identities);
      for (const row of parseSrcset(image.srcset || "")) remember(row.url, image, "video-card-srcset", identities);
      for (const name of [
        "data-src", "data-lazy-src", "data-original", "data-original-src",
        "data-full", "data-full-src", "data-image", "data-thumbnail",
        "data-thumb", "data-poster"
      ]) remember(image.getAttribute(name), image, `video-card-${name}`, identities);
    }

    const videoLinks = document.querySelectorAll(
      "a[href*='/video/'],a[href*='_F_'][href*='.mp4'],[data-asset-id],[data-content-id],[data-video-id]"
    );
    for (const seed of [...videoLinks].slice(0, 2500)) {
      const identities = identitiesFromNode(seed);
      if (!identities.length) continue;
      const card = videoCardRoot(seed);
      const renderedNode = bestRenderedNode(card || seed);
      if (renderedNode) rememberRectOnly(renderedNode, identities);
      const images = card?.querySelectorAll?.("img") || [];
      for (const image of [...images].slice(0, 12)) {
        remember(image.currentSrc || image.src, image, "video-card-linked-image", identities);
        for (const row of parseSrcset(image.srcset || "")) remember(row.url, image, "video-card-linked-srcset", identities);
      }
      const videos = card?.querySelectorAll?.("video") || [];
      for (const video of [...videos].slice(0, 4)) {
        remember(video.poster || video.getAttribute("poster"), video, "video-card-poster", identities);
      }
      const backgroundNodes = card?.querySelectorAll?.('[style*="background"],[style*="url("]') || [];
      for (const node of [...backgroundNodes].slice(0, 20)) {
        for (const url of backgroundUrls(node)) remember(url, node, "video-card-background", identities);
      }
    }

    for (const video of document.querySelectorAll("video")) {
      const identities = identitiesFromNode(video);
      remember(video.poster || video.getAttribute("poster"), video, "video-element-poster", identities);
    }

    for (const node of document.querySelectorAll('[style*="background"],[style*="url("]')) {
      const identities = identitiesFromNode(node);
      if (!identities.length) continue;
      for (const url of backgroundUrls(node)) remember(url, node, "video-card-background", identities);
    }
    return previews;
  }

  function videoThumbnailFor(video) {
    if (!(video instanceof HTMLVideoElement)) return "";
    const direct = absoluteUrl(video.poster || video.getAttribute("poster"));
    if (direct) return direct;

    const container = video.closest("figure,article,[role='article'],li") || video.parentElement;
    const nearby = container?.querySelector?.("img");
    const nearbyUrl = absoluteUrl(nearby?.currentSrc || nearby?.src || nearby?.getAttribute?.("data-src"));
    if (nearbyUrl) return nearbyUrl;

    try {
      if (video.readyState >= 2 && Number(video.videoWidth) > 0 && Number(video.videoHeight) > 0) {
        const maxWidth = 640;
        const scale = Math.min(1, maxWidth / Number(video.videoWidth));
        const width = Math.max(1, Math.round(Number(video.videoWidth) * scale));
        const height = Math.max(1, Math.round(Number(video.videoHeight) * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext("2d");
        context?.drawImage(video, 0, 0, width, height);
        const frame = canvas.toDataURL("image/jpeg", .78);
        if (frame && frame !== "data:,") return frame;
      }
    } catch (_) {}

    return absoluteUrl(
      document.querySelector('meta[property="og:image"],meta[name="twitter:image"]')?.getAttribute("content")
    );
  }

  function collectBatchResources(scanMode = "quick") {
    const fontsOnly = scanMode === "fonts";
    const exhaustive = scanMode === "deep" || fontsOnly;
    const records = new Map();
    const videoPreviewIndex = buildVideoPreviewIndex();
    const familyIds = new WeakMap();
    let sequence = 0;
    let familySequence = 0;

    const imagePattern = /\.(?:avif|bmp|gif|ico|jpe?g|jfif|pjpeg|png|svgz?|tiff?|webp)(?:$|[?#])/i;
    const fontPattern = /\.(?:woff2?|ttf|otf|eot)(?:$|[?#])/i;
    const videoPattern = /\.(?:mp4|webm|mov|m4v|ogv|avi|mkv)(?:$|[?#])/i;
    const audioPattern = /\.(?:mp3|wav|ogg|oga|m4a|aac|flac|opus)(?:$|[?#])/i;
    const documentPattern = /\.(?:pdf)(?:$|[?#])/i;
    const captionPattern = /\.(?:vtt|srt)(?:$|[?#])/i;
    const lottiePattern = /(?:lottie|bodymovin|animation)[^/?#]*\.json(?:$|[?#])/i;

    const likelyImage = value => /^(?:data:image\/|blob:)/i.test(String(value || "")) || imagePattern.test(String(value || ""));
    const likelyFont = value => /^(?:data:font\/|data:application\/(?:font|x-font|vnd\.ms-fontobject))/i.test(String(value || "")) || fontPattern.test(String(value || ""));
    const likelyVideo = value => /^(?:data:video\/)/i.test(String(value || "")) || videoPattern.test(String(value || ""));
    const likelyAudio = value => /^(?:data:audio\/)/i.test(String(value || "")) || audioPattern.test(String(value || ""));
    const likelyDocument = value => documentPattern.test(String(value || ""));
    const likelyCaption = value => captionPattern.test(String(value || ""));
    const likelyAnimation = value => lottiePattern.test(String(value || ""));
    const likelyAsset = value => likelyImage(value) || likelyFont(value) || likelyVideo(value) || likelyAudio(value) || likelyDocument(value) || likelyCaption(value) || likelyAnimation(value);

    const familyFor = node => {
      if (!(node instanceof Element)) return "";
      if (!familyIds.has(node)) familyIds.set(node, `dom-${familySequence++}`);
      return familyIds.get(node);
    };
    const positionFor = node => {
      if (!(node instanceof Element)) return {};
      try {
        const rect = node.getBoundingClientRect();
        return {
          pageTop: Math.max(0, window.scrollY + Number(rect.top || 0)),
          pageLeft: Math.max(0, window.scrollX + Number(rect.left || 0))
        };
      } catch (_) { return {}; }
    };
    const resolveAgainst = (value, base = document.baseURI) => {
      const raw = String(value || "").trim();
      if (!raw || raw === "none") return "";
      if (/^(?:data:(?:image|font|application|audio|video|text)\/|blob:)/i.test(raw)) return raw;
      try {
        const url = new URL(raw, base || document.baseURI);
        return /^https?:$/i.test(url.protocol) ? url.href : "";
      } catch (_) { return ""; }
    };
    const kindFor = (url, type, declared = "") => {
      if (declared) return declared;
      if (likelyFont(url) || /^(?:woff2?|ttf|otf|eot)$/i.test(type)) return "font";
      if (type === "svg" || type === "svgz") return "vector";
      if (likelyImage(url)) return "image";
      if (likelyVideo(url) || /^(?:mp4|webm|mov|m4v|ogv|avi|mkv)$/i.test(type)) return "video";
      if (likelyAudio(url) || /^(?:mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(type)) return "audio";
      if (likelyDocument(url) || type === "pdf") return "document";
      if (likelyAnimation(url) || type === "json") return "animation";
      if (likelyCaption(url) || /^(?:vtt|srt)$/i.test(type)) return "caption";
      return "other";
    };
    const fallbackFor = kind => ({font:"web-font",video:"video",audio:"audio",document:"document",animation:"animation",caption:"captions",vector:"vector",image:"image"})[kind] || "asset";
    const previewForVideoUrl = value => {
      const identity = mediaAssetIdentity(value);
      return identity ? videoPreviewIndex.get(identity) || null : null;
    };

    const add = (value, meta = {}, base = document.baseURI) => {
      const url = resolveAgainst(value, base);
      if (!url || url.startsWith("chrome-extension:") || /^javascript:/i.test(url)) return;
      if (!likelyAsset(url) && !meta.force) return;
      const key = url;
      const existing = records.get(key);
      const type = batchType(url, meta.mime);
      const kind = kindFor(url, type, String(meta.kind || ""));
      if (fontsOnly && kind !== "font") return;
      const fallback = fallbackFor(kind);
      const rawTop = Number(meta.pageTop), rawLeft = Number(meta.pageLeft);
      const resolvedPreview = resolveAgainst(meta.previewUrl, base);
      const row = {
        id: key,
        url,
        previewUrl: resolvedPreview || (kind === "video" ? "" : url),
        filename: /^(?:data:|blob:)/i.test(url) ? cleanText(meta.filename || fallback, 160) : batchFilename(url, meta.filename || fallback),
        type,
        kind,
        width: Math.max(0, Number(meta.width || 0)),
        height: Math.max(0, Number(meta.height || 0)),
        bytes: Math.max(0, Number(meta.bytes || 0)),
        source: String(meta.source || "page"),
        pageUrl: location.href,
        pageTitle: document.title || "",
        frameUrl: location.href,
        alt: cleanText(meta.alt || "", 220),
        familyKey: String(meta.familyKey || ""),
        fontFamily: cleanText(meta.fontFamily || "", 120),
        fontStyle: cleanText(meta.fontStyle || "", 40),
        fontWeight: cleanText(meta.fontWeight || "", 40),
        pageTop: Number.isFinite(rawTop) ? rawTop : null,
        pageLeft: Number.isFinite(rawLeft) ? rawLeft : null,
        previewRect: meta.previewRect && Number(meta.previewRect.width) > 0 && Number(meta.previewRect.height) > 0 ? {
          left: Number(meta.previewRect.left || 0),
          top: Number(meta.previewRect.top || 0),
          width: Number(meta.previewRect.width || 0),
          height: Number(meta.previewRect.height || 0)
        } : null,
        viewportWidth: Number(meta.viewportWidth || 0),
        viewportHeight: Number(meta.viewportHeight || 0),
        order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : sequence++
      };
      if (!existing) {
        records.set(key, row);
        return;
      }

      const oldArea = Number(existing.width || 0) * Number(existing.height || 0);
      const newArea = row.width * row.height;
      const oldTop = Number(existing.pageTop), newTop = Number(row.pageTop);
      const oldKnown = Number.isFinite(oldTop), newKnown = Number.isFinite(newTop);
      const useNewPosition = newKnown && (!oldKnown || newTop < oldTop || (newTop === oldTop && Number(row.pageLeft || 0) < Number(existing.pageLeft || 0)));
      const merged = {
        ...row,
        ...existing,
        alt: existing.alt || row.alt,
        previewUrl: (existing.previewUrl && existing.previewUrl !== existing.url) ? existing.previewUrl : row.previewUrl || existing.previewUrl || row.url,
        familyKey: existing.familyKey || row.familyKey,
        fontFamily: existing.fontFamily || row.fontFamily,
        fontStyle: existing.fontStyle || row.fontStyle,
        fontWeight: existing.fontWeight || row.fontWeight,
        bytes: Math.max(Number(existing.bytes || 0), Number(row.bytes || 0)),
        order: Math.min(Number(existing.order || 0), Number(row.order || 0)),
        pageTop: useNewPosition ? row.pageTop : existing.pageTop,
        pageLeft: useNewPosition ? row.pageLeft : existing.pageLeft,
        previewRect: existing.previewRect || row.previewRect || null,
        viewportWidth: Number(existing.viewportWidth || row.viewportWidth || 0),
        viewportHeight: Number(existing.viewportHeight || row.viewportHeight || 0)
      };
      if (newArea > oldArea) { merged.width = row.width; merged.height = row.height; }
      if ((existing.type === "asset" || existing.type === "image") && row.type !== "asset") merged.type = row.type;
      if (existing.kind === "other" && row.kind !== "other") merged.kind = row.kind;
      records.set(key, merged);
    };

    const scanSrcset = (value, meta = {}) => parseSrcset(value).forEach(item => add(item.url, {...meta, source:meta.source || "srcset"}));
    const scanCss = (text, source = "stylesheet", base = document.baseURI) => {
      const css = String(text || "");
      for (const block of css.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)) {
        const body = block[1];
        const family = (body.match(/font-family\s*:\s*([^;]+)/i)?.[1] || "Web font").replace(/["']/g, "").trim();
        const style = (body.match(/font-style\s*:\s*([^;]+)/i)?.[1] || "normal").trim();
        const weight = (body.match(/font-weight\s*:\s*([^;]+)/i)?.[1] || "400").trim();
        const familyKey = `font:${family.toLowerCase()}:${style.toLowerCase()}:${weight.toLowerCase()}`;
        for (const match of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
          add(match[1], {kind:"font",force:true,source:`${source}-font-face`,fontFamily:family,fontStyle:style,fontWeight:weight,familyKey}, base);
        }
      }
      for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1], {source}, base);
      for (const match of css.matchAll(/(?:https?:)?\/\/[^\s"'<>\\)]+\.(?:avif|bmp|gif|ico|jpe?g|png|svgz?|tiff?|webp|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|mp3|wav|ogg|m4a|aac|flac|pdf|vtt|srt)(?:\?[^\s"'<>\\)]*)?/gi)) add(match[0], {source}, base);
    };

    const finalizeRows = () => {
      const rows = [...records.values()].filter(row => row.url);
      rows.sort((a,b) => {
        const aKnown = Number.isFinite(Number(a.pageTop)), bKnown = Number.isFinite(Number(b.pageTop));
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        if (aKnown && bKnown) {
          const topDiff = Number(a.pageTop) - Number(b.pageTop);
          if (Math.abs(topDiff) > 2) return topDiff;
          const leftDiff = Number(a.pageLeft || 0) - Number(b.pageLeft || 0);
          if (Math.abs(leftDiff) > 2) return leftDiff;
        }
        return Number(a.order) - Number(b.order);
      });
      rows.forEach((row,index) => { row.order = index; });
      return rows.slice(0,12000);
    };

    if (fontsOnly) {
      [...document.querySelectorAll("style")].slice(0, 800).forEach(style => {
        const text = String(style.textContent || "");
        if (text.length <= 4_000_000) scanCss(text, "font-style-block", document.baseURI);
      });
      for (const sheet of document.styleSheets || []) {
        try { for (const rule of sheet.cssRules || []) scanCss(rule.cssText, "font-stylesheet", sheet.href || document.baseURI); } catch (_) {}
      }
      document.querySelectorAll("link[href]").forEach(link => {
        const as = String(link.getAttribute("as") || "").toLowerCase();
        if (as === "font") add(link.getAttribute("href"), {
          kind:"font", force:true, source:"font-preload",
          fontFamily:link.getAttribute("data-family") || "", familyKey:familyFor(link)
        });
      });
      try {
        for (const entry of performance.getEntriesByType("resource")) {
          const name = String(entry.name || "");
          if (!likelyFont(name)) continue;
          add(name, {kind:"font", force:true, source:"network-font", bytes:Number(entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0)});
        }
      } catch (_) {}
      return finalizeRows();
    }

    for (const candidate of batchWarmCandidates.values()) add(candidate.url, candidate);

    [...document.images].forEach((image, imageIndex) => {
      const familyKey = familyFor(image.closest("picture") || image) || `image-${imageIndex}`;
      const meta = {width:image.naturalWidth,height:image.naturalHeight,alt:image.alt,filename:image.getAttribute("download") || "",familyKey,...positionFor(image)};
      add(image.currentSrc || image.src, {...meta,source:"img-current"});
      add(image.src, {...meta,source:"img-src"});
      scanSrcset(image.srcset, {...meta,source:"img-srcset"});
      image.closest("picture")?.querySelectorAll("source[srcset]").forEach(source => scanSrcset(source.getAttribute("srcset"), {...meta,source:"picture-source"}));
      for (const name of ["data-src","data-lazy-src","data-original","data-original-src","data-full","data-full-src","data-zoom-image","data-pin-media","data-hi-res-src","data-high-res-src","data-large","data-image","data-url"]) add(image.getAttribute(name), {...meta,source:name});
    });

    document.querySelectorAll("video").forEach(video => {
      const familyKey = familyFor(video);
      const pos = positionFor(video);
      const previewUrl = videoThumbnailFor(video);
      const previewRect = previewRectFor(video);
      const videoMeta = {kind:"video",force:true,previewUrl,mime:video.getAttribute("type") || "",source:"video-source",familyKey,...pos,previewRect,viewportWidth:Number(innerWidth || 0),viewportHeight:Number(innerHeight || 0)};
      add(video.currentSrc || video.src || video.getAttribute("src"), videoMeta);
      video.querySelectorAll("source[src]").forEach(source => add(source.src || source.getAttribute("src"), {...videoMeta,mime:source.type || videoMeta.mime}));
      if (video.poster || video.getAttribute("poster")) add(video.poster || video.getAttribute("poster"), {width:video.videoWidth,height:video.videoHeight,source:"video-poster",familyKey,...pos});
      video.querySelectorAll("track[src]").forEach(track => add(track.src || track.getAttribute("src"), {kind:"caption",force:true,mime:"text/vtt",source:"video-caption",familyKey,...pos}));
    });
    document.querySelectorAll("audio").forEach(audio => {
      const familyKey = familyFor(audio);
      const pos = positionFor(audio);
      add(audio.currentSrc || audio.src || audio.getAttribute("src"), {kind:"audio",force:true,mime:audio.getAttribute("type") || "",source:"audio-source",familyKey,...pos});
      audio.querySelectorAll("source[src]").forEach(source => add(source.src || source.getAttribute("src"), {kind:"audio",force:true,mime:source.type,source:"audio-source",familyKey,...pos}));
    });
    document.querySelectorAll("track[src]").forEach(track => add(track.src || track.getAttribute("src"), {kind:"caption",force:true,mime:"text/vtt",source:"caption-track",familyKey:familyFor(track),...positionFor(track)}));
    document.querySelectorAll("input[type='image'][src]").forEach(input => add(input.src, {width:input.width,height:input.height,alt:input.alt,source:"input-image",familyKey:familyFor(input),...positionFor(input)}));
    document.querySelectorAll("a[href],area[href]").forEach(link => {
      const href = link.getAttribute("href");
      if (!likelyAsset(href)) return;
      const linkedVideo = likelyVideo(href);
      const indexedPreview = linkedVideo ? previewForVideoUrl(href) : null;
      const card = link.closest("figure,article,[role='article'],li") || link;
      const cardImage = card.querySelector?.("img");
      const thumbnail = linkedVideo ? (indexedPreview?.url || absoluteUrl(cardImage?.currentSrc || cardImage?.src || cardImage?.getAttribute?.("data-src"))) : "";
      add(href, {
        kind:linkedVideo?"video":"", force:linkedVideo, previewUrl:thumbnail, source:"asset-link",
        filename:link.getAttribute("download") || "",
        width:indexedPreview?.width, height:indexedPreview?.height, alt:indexedPreview?.alt || "",
        familyKey:indexedPreview?.familyKey || familyFor(link),
        pageTop:indexedPreview?.pageTop ?? positionFor(link).pageTop,
        pageLeft:indexedPreview?.pageLeft ?? positionFor(link).pageLeft,
        previewRect:indexedPreview?.previewRect || null,
        viewportWidth:indexedPreview?.viewportWidth || Number(innerWidth || 0),
        viewportHeight:indexedPreview?.viewportHeight || Number(innerHeight || 0)
      });
    });
    document.querySelectorAll("meta[property='og:image'],meta[property='og:image:url'],meta[property='og:image:secure_url'],meta[name='twitter:image'],meta[name='twitter:image:src'],meta[itemprop='image']").forEach(meta => add(meta.content, {source:"page-metadata"}));

    document.querySelectorAll("link[href]").forEach(link => {
      const rel = String(link.rel || "").toLowerCase();
      const as = String(link.getAttribute("as") || "").toLowerCase();
      const href = link.getAttribute("href");
      if (as === "font") add(href, {kind:"font",force:true,source:"font-preload",fontFamily:link.getAttribute("data-family") || "",familyKey:familyFor(link)});
      else if (as === "video") {
        const preview = previewForVideoUrl(href);
        add(href, {kind:"video",force:true,source:"video-preload",previewUrl:preview?.url || "",width:preview?.width,height:preview?.height,alt:preview?.alt || "",familyKey:preview?.familyKey || "",pageTop:preview?.pageTop,pageLeft:preview?.pageLeft,previewRect:preview?.previewRect || null,viewportWidth:preview?.viewportWidth || Number(innerWidth || 0),viewportHeight:preview?.viewportHeight || Number(innerHeight || 0)});
      }
      else if (as === "audio") add(href, {kind:"audio",force:true,source:"audio-preload"});
      else if (rel.includes("icon") || as === "image") add(href, {source:rel.includes("icon") ? "favicon" : "image-preload"});
      scanSrcset(link.getAttribute("imagesrcset"), {source:"preload-srcset"});
    });

    document.querySelectorAll("svg image").forEach(image => add(image.getAttribute("href") || image.getAttributeNS("http://www.w3.org/1999/xlink","href"), {width:image.width?.baseVal?.value,height:image.height?.baseVal?.value,source:"svg-image",familyKey:familyFor(image.closest("svg") || image),...positionFor(image)}));
    [...document.querySelectorAll("svg")].slice(0, exhaustive ? 2000 : 120).forEach((svg,index) => {
      try {
        const rect = svg.getBoundingClientRect();
        if (rect.width < 24 || rect.height < 24) return;
        const xml = new XMLSerializer().serializeToString(svg);
        add(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`, {width:Math.round(rect.width),height:Math.round(rect.height),filename:`inline-vector-${index + 1}.svg`,mime:"image/svg+xml",source:"inline-svg",familyKey:familyFor(svg),...positionFor(svg)});
      } catch (_) {}
    });
    document.querySelectorAll("object[data],embed[src]").forEach(node => {
      const value = node.getAttribute("data") || node.getAttribute("src");
      const mime = String(node.type || "");
      if (likelyAsset(value) || /^(?:image|font|video|audio|application\/pdf)/i.test(mime)) add(value, {mime,source:"embedded-asset",force:true,familyKey:familyFor(node),...positionFor(node)});
    });

    const attributeCandidates = exhaustive
      ? document.querySelectorAll("*")
      : document.querySelectorAll('[style*="url("],[style*="background"],[data-src],[data-image],[data-background],[data-bg],[data-original],[data-full],[data-zoom-image],[data-lottie],[data-animation]');
    for (const node of attributeCandidates) {
      const rect = node.getBoundingClientRect?.();
      const pos = positionFor(node);
      for (const url of backgroundUrls(node)) add(url, {width:rect?.width,height:rect?.height,source:"background-image",familyKey:familyFor(node),...pos});
      for (const attribute of node.attributes || []) {
        const name = attribute.name.toLowerCase(), value = attribute.value;
        if (name === "style") scanCss(value, "inline-style");
        else if (name.includes("srcset")) scanSrcset(value, {width:rect?.width,height:rect?.height,source:name,familyKey:familyFor(node),...pos});
        else if ((name.includes("src") || name.includes("image") || name.includes("poster") || name.includes("thumb") || name.includes("background") || name.includes("original") || name.includes("zoom") || name.includes("lottie") || name.includes("animation") || name === "href") && likelyAsset(value)) {
          add(value, {width:rect?.width,height:rect?.height,source:`attribute-${name}`,familyKey:familyFor(node),...pos});
        }
      }
    }

    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const initiator = String(entry.initiatorType || "").toLowerCase(), name = String(entry.name || "");
        if (initiator === "img" || initiator === "image" || likelyAsset(name)) {
          const kind = likelyFont(name) ? "font" : likelyVideo(name) ? "video" : likelyAudio(name) ? "audio" : likelyDocument(name) ? "document" : likelyCaption(name) ? "caption" : likelyAnimation(name) ? "animation" : "";
          const indexedPreview = kind === "video" ? previewForVideoUrl(name) : null;
          add(name, {
            kind, force:Boolean(kind), previewUrl:indexedPreview?.url || "",
            width:indexedPreview?.width, height:indexedPreview?.height, alt:indexedPreview?.alt || "",
            familyKey:indexedPreview?.familyKey || "", pageTop:indexedPreview?.pageTop, pageLeft:indexedPreview?.pageLeft,
            previewRect:indexedPreview?.previewRect || null,
            viewportWidth:indexedPreview?.viewportWidth || Number(innerWidth || 0),
            viewportHeight:indexedPreview?.viewportHeight || Number(innerHeight || 0),
            source:`network-${initiator || "resource"}`,
            bytes:Number(entry.transferSize || entry.encodedBodySize || entry.decodedBodySize || 0)
          });
        }
      }
    } catch (_) {}

    [...document.querySelectorAll("style")].slice(0, exhaustive ? 500 : 80).forEach(style => {
      const text = String(style.textContent || "");
      if (text.length <= (exhaustive ? 4_000_000 : 500_000)) scanCss(text, "style-block", document.baseURI);
    });

    if (exhaustive) {
      for (const sheet of document.styleSheets || []) {
        try { for (const rule of sheet.cssRules || []) scanCss(rule.cssText, "stylesheet", sheet.href || document.baseURI); } catch (_) {}
      }

      document.querySelectorAll("noscript").forEach((node,index) => {
      try {
        const parsed = new DOMParser().parseFromString(node.textContent || "", "text/html");
        parsed.querySelectorAll("img").forEach(image => { add(image.getAttribute("src"), {alt:image.alt,source:`noscript-${index + 1}`}); scanSrcset(image.getAttribute("srcset"), {alt:image.alt,source:`noscript-srcset-${index + 1}`}); });
      } catch (_) {}
    });

    let scriptMatches = 0;
    for (const script of document.scripts) {
      if (scriptMatches > 3500) break;
      const text = String(script.textContent || "");
      if (!text || text.length > 8_000_000) continue;
      for (const match of text.matchAll(/https?:\\?\/\\?\/[^"'\s<>]+?\.(?:avif|bmp|gif|ico|jpe?g|png|svgz?|tiff?|webp|woff2?|ttf|otf|eot|mp4|webm|mov|m4v|ogv|mp3|wav|ogg|m4a|aac|flac|pdf|vtt|srt)(?:\\?[?#][^"'\s<>]*)?/gi)) {
        add(match[0].replace(/\\\//g,"/").replace(/\\u0026/g,"&"), {source:"page-data"});
        scriptMatches += 1;
        if (scriptMatches > 3500) break;
      }
      for (const match of text.matchAll(/https?:\\?\/\\?\/[^"'\s<>]*(?:lottie|bodymovin|animation)[^"'\s<>]*?\.json(?:\\?[?#][^"'\s<>]*)?/gi)) {
        add(match[0].replace(/\\\//g,"/").replace(/\\u0026/g,"&"), {kind:"animation",force:true,mime:"application/json",source:"page-animation-data"});
        scriptMatches += 1;
        if (scriptMatches > 3500) break;
      }
    }

    }

    return finalizeRows();
  }

  async function warmLazyBatchImages() {
    const startX = window.scrollX, startY = window.scrollY;
    snapshotBatchViewport();
    try {
      let lastHeight = 0;
      let stableBottomPasses = 0;
      for (let step = 0; step < 36; step += 1) {
        const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
        if (height <= innerHeight + 40) break;
        const progress = Math.min(1, step / 30);
        const target = Math.max(0, (height - innerHeight) * progress);
        window.scrollTo({left: startX, top: target, behavior: "auto"});
        await new Promise(resolve => setTimeout(resolve, step < 5 ? 100 : 135));
        snapshotBatchViewport();
        const currentHeight = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
        const nearBottom = target >= Math.max(0, currentHeight - innerHeight - 120);
        if (nearBottom && currentHeight === lastHeight) stableBottomPasses += 1;
        else stableBottomPasses = 0;
        lastHeight = currentHeight;
        if (nearBottom && stableBottomPasses >= 3) break;
      }
      window.scrollTo({left: startX, top: Math.max(0, document.documentElement.scrollHeight - innerHeight), behavior: "auto"});
      await new Promise(resolve => setTimeout(resolve, 180));
      snapshotBatchViewport();
    } catch (_) {
    } finally {
      window.scrollTo({left: startX, top: startY, behavior: "auto"});
      await new Promise(resolve => setTimeout(resolve, 140));
      snapshotBatchViewport();
    }
  }

  function collectFontStylesheetUrls() {
    const urls = new Set();
    const add = value => {
      const url = absoluteUrl(value);
      if (url && /^https?:/i.test(url)) urls.add(url);
    };
    for (const sheet of document.styleSheets || []) add(sheet.href);
    document.querySelectorAll('link[rel~="stylesheet"][href],link[rel="preload"][as="style"][href]').forEach(link => add(link.getAttribute("href")));
    return [...urls].slice(0, 160);
  }

  async function resolveBatchResource(url) {
    const value = String(url || "");
    if (value.startsWith("data:")) return {ok: true, dataUrl: value};
    if (!value.startsWith("blob:")) return {ok: true, url: value};
    try {
      const response = await fetch(value);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Could not read this asset."));
        reader.readAsDataURL(blob);
      });
      return {ok: true, dataUrl};
    } catch (error) {
      return {ok: false, error: error?.message || "Could not resolve this page asset."};
    }
  }

  function pointIntersectsSelection(point) {
    if (!point || typeof point.x !== "number" || typeof point.y !== "number") return false;
    try {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
      const text = selection.toString().trim();
      if (!text) return false;
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        const rects = range.getClientRects();
        for (const rect of rects) {
          if (point.x >= rect.left - 4 && point.x <= rect.right + 4 &&
              point.y >= rect.top - 4 && point.y <= rect.bottom + 4) {
            return true;
          }
        }
      }
    } catch (_) {}
    return false;
  }

  function resolveFontForSelectedText() {
    const selection = window.getSelection();
    const selectedText = selection?.toString()?.trim() || "";
    if (!selectedText) return null;

    let node = null;
    try {
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        node = range.startContainer;
        if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
        if (!(node instanceof Element)) {
          node = range.commonAncestorContainer;
          if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
        }
      }
    } catch (_) {}

    if (!(node instanceof Element)) {
      node = selection.anchorNode;
      if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    }
    if (!(node instanceof Element)) node = document.body;
    if (!node) return null;

    const computed = window.getComputedStyle(node);
    const rawFamily = computed.fontFamily || "";
    const weight = computed.fontWeight || "400";
    const style = computed.fontStyle || "normal";

    const families = rawFamily
      .split(",")
      .map(f => f.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);

    if (!families.length) return null;

    const fontRules = [];
    const addFontRule = (family, fStyle, fWeight, url, format) => {
      const cleanUrl = absoluteUrl(url);
      if (!cleanUrl) return;
      fontRules.push({
        family: family.replace(/^['"]|['"]$/g, "").trim(),
        style: (fStyle || "normal").trim().toLowerCase(),
        weight: String(fWeight || "400").trim(),
        url: cleanUrl,
        format: (format || "").toLowerCase()
      });
    };

    const parseCssBlock = (css, base) => {
      for (const block of String(css || "").matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)) {
        const body = block[1];
        const fam = (body.match(/font-family\s*:\s*([^;]+)/i)?.[1] || "").replace(/["']/g, "").trim();
        const st = (body.match(/font-style\s*:\s*([^;]+)/i)?.[1] || "normal").trim();
        const wt = (body.match(/font-weight\s*:\s*([^;]+)/i)?.[1] || "400").trim();
        for (const m of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/gi)) {
          try {
            const resolved = new URL(m[1], base).href;
            addFontRule(fam, st, wt, resolved, m[2] || "");
          } catch (_) {}
        }
      }
    };

    // 1. Scan inline <style> tags
    for (const s of document.querySelectorAll("style")) {
      const text = s.textContent || "";
      if (text.length <= 4_000_000) parseCssBlock(text, document.baseURI);
    }

    // 2. Scan accessible stylesheets
    for (const sheet of document.styleSheets || []) {
      try {
        for (const rule of sheet.cssRules || []) {
          if (rule instanceof CSSFontFaceRule || rule.type === 5) {
            const fam = (rule.style?.fontFamily || "").replace(/["']/g, "").trim();
            const st = rule.style?.fontStyle || "normal";
            const wt = rule.style?.fontWeight || "400";
            const src = rule.style?.src || "";
            for (const m of src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)(?:\s*format\(\s*["']?([^"')]+)["']?\s*\))?/gi)) {
              try {
                const resolved = new URL(m[1], sheet.href || document.baseURI).href;
                addFontRule(fam, st, wt, resolved, m[2] || "");
              } catch (_) {}
            }
          }
        }
      } catch (_) {}
    }

    // 3. Scan preloaded fonts
    for (const link of document.querySelectorAll('link[rel="preload"][as="font"]')) {
      const href = link.getAttribute("href");
      if (href) {
        const fam = link.getAttribute("data-family") || "";
        addFontRule(fam, "normal", "400", href, "");
      }
    }

    // 4. Scan network performance entries
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const name = String(entry.name || "");
        if (/\.(?:woff2?|ttf|otf|eot)(?:$|[?#])/i.test(name)) {
          addFontRule("", "normal", "400", name, "");
        }
      }
    } catch (_) {}

    let matchedRule = null;
    let matchedFamily = "";

    const normWeight = w => (w === "bold" ? "700" : (w === "normal" ? "400" : String(w || "400")));
    const targetWeight = normWeight(weight);
    const targetStyle = (style || "normal").toLowerCase();

    for (const fam of families) {
      const famLower = fam.toLowerCase();
      if (/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|-apple-system|blinkmacsystemfont)$/i.test(famLower)) {
        continue;
      }
      const candidates = fontRules.filter(r => r.family && r.family.toLowerCase() === famLower);
      if (candidates.length) {
        matchedFamily = fam;
        let best = candidates.find(c => normWeight(c.weight) === targetWeight && c.style === targetStyle);
        if (!best) best = candidates.find(c => normWeight(c.weight) === targetWeight);
        if (!best) best = candidates[0];

        const sameWeightCandidates = candidates.filter(c => normWeight(c.weight) === normWeight(best.weight) && c.style === best.style);
        const formatPriority = { ttf: 5, otf: 4, woff2: 3, woff: 2, eot: 1 };
        sameWeightCandidates.sort((a, b) => {
          const extA = (a.url.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1] || a.format).toLowerCase();
          const extB = (b.url.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1] || b.format).toLowerCase();
          return (formatPriority[extB] || 0) - (formatPriority[extA] || 0);
        });

        matchedRule = sameWeightCandidates[0] || best;
        break;
      }
    }

    // Fallback: match by filename/url if fontRules has no explicit family match
    if (!matchedRule) {
      for (const fam of families) {
        const famLower = fam.toLowerCase();
        if (famLower.length < 3 || /^(sans-serif|serif|monospace|system-ui)$/i.test(famLower)) continue;
        const found = fontRules.find(r => r.url.toLowerCase().includes(famLower));
        if (found) {
          matchedFamily = fam;
          matchedRule = found;
          break;
        }
      }
    }

    const stylesheetUrls = collectFontStylesheetUrls();

    const weightNameMap = {
      "100": "Thin",
      "200": "ExtraLight",
      "300": "Light",
      "400": "Regular",
      "500": "Medium",
      "600": "SemiBold",
      "700": "Bold",
      "800": "ExtraBold",
      "900": "Black"
    };

    if (!matchedRule) {
      const primaryFamily = families[0] || "System font";
      return {
        ok: false,
        isSystemFont: true,
        fontFamily: primaryFamily,
        fallbackFamilies: families.slice(1),
        fontWeight: weight,
        fontStyle: style,
        selectedText,
        stylesheetUrls,
        message: `Selected text uses local system font: "${primaryFamily}". It has no downloadable webfont file.`
      };
    }

    const primaryFamily = matchedFamily || matchedRule.family || families[0] || "WebFont";
    const ext = (matchedRule.url.match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1] || matchedRule.format || "woff2").toLowerCase();
    const cleanExt = ["woff2", "woff", "ttf", "otf", "eot"].includes(ext) ? ext : "woff2";
    const weightLabel = weightNameMap[String(targetWeight)] || (targetWeight === "400" ? "Regular" : targetWeight);
    const cleanFamilyName = primaryFamily.replace(/[<>:"/\\|?*]+/g, "").trim();
    const filename = `${cleanFamilyName}-${weightLabel}.${cleanExt}`;

    return {
      ok: true,
      isSystemFont: false,
      fontFamily: primaryFamily,
      fallbackFamilies: families.slice(1),
      fontWeight: targetWeight,
      fontStyle: targetStyle,
      url: matchedRule.url,
      filename,
      selectedText,
      stylesheetUrls
    };
  }

  let overlayTrackingFrame = 0;
  function trackVisibleOverlay() {
    overlayTrackingFrame = 0;
    if (overlayHost.style.display === "none") return;
    if (!currentTarget?.isConnected) {
      if (!overlayHovered) hideOverlay();
      return;
    }
    const rect = visibleRect(currentTarget);
    if (!rect) {
      if (!overlayHovered) hideOverlay();
      return;
    }
    lastTargetRect = rect;
    positionOverlay();
    overlayTrackingFrame = requestAnimationFrame(trackVisibleOverlay);
  }

  const previousRenderOverlay = renderOverlay;
  renderOverlay = function moodboxDownloadRenderOverlayTracked() {
    previousRenderOverlay();
    if (overlayHost.style.display !== "none" && !overlayTrackingFrame) {
      overlayTrackingFrame = requestAnimationFrame(trackVisibleOverlay);
    }
  };

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let changed = false;
    if (Object.prototype.hasOwnProperty.call(changes, "downloadHoverEnabled")) {
      downloadHoverEnabled = changes.downloadHoverEnabled.newValue !== false;
      downloadSettingsReady = true;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(changes, "downloadAll")) {
      downloadAllEnabled = Boolean(changes.downloadAll.newValue);
      downloadSettingsReady = true;
      changed = true;
    }
    if (Object.prototype.hasOwnProperty.call(changes, "downloadSites")) {
      downloadSites = normalizedSites(changes.downloadSites.newValue ?? DOWNLOAD_DEFAULTS.downloadSites);
      downloadSettingsReady = true;
      changed = true;
    }
    if (changed && currentTarget) renderOverlay();
  });

  loadDownloadSettings();

  function showCustomConfirmFontDownload(family) {
    return new Promise(resolve => {
      try {
        const existing = document.getElementById("moodbox-font-confirm-modal");
        if (existing) existing.remove();

        const host = document.createElement("div");
        host.id = "moodbox-font-confirm-modal";
        host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.65);backdrop-filter:blur(6px);font-family:Inter,Segoe UI,-apple-system,sans-serif;";

        const card = document.createElement("div");
        card.style.cssText = "width:350px;background:#121613;border:1px solid #28372A;border-radius:16px;box-shadow:0 24px 50px rgba(0,0,0,0.7);padding:22px;color:#F0F5F0;box-sizing:border-box;";

        const iconRow = document.createElement("div");
        iconRow.style.cssText = "display:flex;align-items:center;gap:10px;margin-bottom:12px;";

        const iconBadge = document.createElement("div");
        iconBadge.style.cssText = "width:36px;height:36px;border-radius:10px;background:#1A251C;border:1px solid #2C422F;display:flex;align-items:center;justify-content:center;color:#71d13c;font-size:16px;font-weight:700;";
        iconBadge.textContent = "Aa";

        const title = document.createElement("div");
        title.style.cssText = "font-size:14.5px;font-weight:700;color:#F0F5F0;";
        title.textContent = "Font Already Downloaded";

        iconRow.appendChild(iconBadge);
        iconRow.appendChild(title);

        const desc = document.createElement("div");
        desc.style.cssText = "font-size:12px;color:#8F9F90;line-height:1.55;margin-bottom:20px;";
        desc.textContent = `The font "${family}" was already downloaded to your PC. Would you like to download it again?`;

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:10px;justify-content:flex-end;";

        const cancelBtn = document.createElement("button");
        cancelBtn.style.cssText = "padding:8px 16px;border-radius:9px;background:#181E19;border:1px solid #2A362C;color:#A4B4A6;font-size:12px;font-weight:600;cursor:pointer;";
        cancelBtn.textContent = "Cancel";

        const okBtn = document.createElement("button");
        okBtn.style.cssText = "padding:8px 18px;border-radius:9px;background:#71d13c;border:none;color:#071405;font-size:12px;font-weight:700;cursor:pointer;";
        okBtn.textContent = "Download Again";

        const cleanup = (confirmed) => {
          host.remove();
          resolve(confirmed);
        };

        cancelBtn.onclick = () => cleanup(false);
        okBtn.onclick = () => cleanup(true);
        host.onclick = (e) => { if (e.target === host) cleanup(false); };

        const keyHandler = (e) => {
          if (e.key === "Escape") {
            window.removeEventListener("keydown", keyHandler);
            cleanup(false);
          } else if (e.key === "Enter") {
            window.removeEventListener("keydown", keyHandler);
            cleanup(true);
          }
        };
        window.addEventListener("keydown", keyHandler);

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);

        card.appendChild(iconRow);
        card.appendChild(desc);
        card.appendChild(btnRow);
        host.appendChild(card);
        document.documentElement.appendChild(host);
      } catch (_) {
        resolve(true);
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.action === "moodbox-confirm-font-download") {
      const family = message.fontFamily || "this font";
      showCustomConfirmFontDownload(family).then(confirmed => {
        sendResponse({ confirmed: Boolean(confirmed) });
      });
      return true;
    }

    if (message?.action === "moodbox-get-selected-font") {
      const fontTarget = resolveFontForSelectedText();
      sendResponse({ok: Boolean(fontTarget), fontTarget});
      return false;
    }

    if (message?.action === "moodbox-get-context-target") {
      try {
        const reqSrcUrl = String(message.srcUrl || "").trim();
        const now = Date.now();

        // 1. If reqSrcUrl is provided, this is definitively an image request!
        if (reqSrcUrl) {
          const wanted = absoluteUrl(reqSrcUrl);
          if (lastRightClickTarget && (now - lastRightClickTarget.time) < 30_000 && lastRightClickTarget.resource) {
            const targetSrc = absoluteUrl(lastRightClickTarget.srcUrl);
            const inCandidates = Array.isArray(lastRightClickTarget.resource?.candidates) &&
              lastRightClickTarget.resource.candidates.some(c => urlsMatch(c.url, wanted));
            if (urlsMatch(targetSrc, wanted) || inCandidates) {
              sendResponse({ok: true, contextKind: lastRightClickTarget.contextKind || "image", resource: lastRightClickTarget.resource});
              return false;
            }
          }
          for (const image of document.images) {
            const values = [
              image.currentSrc, image.src,
              image.getAttribute("data-src"), image.getAttribute("data-original"),
              image.getAttribute("data-original-src"), image.getAttribute("data-pin-media")
            ].map(absoluteUrl).filter(Boolean);
            if (values.some(v => urlsMatch(v, wanted))) {
              const res = buildResource(image);
              if (res) {
                sendResponse({ok: true, contextKind: "image", resource: res});
                return false;
              }
            }
          }
        }

        // 2. Fresh right-click target (< 30s)
        if (lastRightClickTarget && (now - lastRightClickTarget.time) < 30_000) {
          if (lastRightClickTarget.contextKind === "font" && lastRightClickTarget.fontTarget) {
            sendResponse({ok: true, contextKind: "font", fontTarget: lastRightClickTarget.fontTarget});
            return false;
          }
          if (lastRightClickTarget.resource?.url && (lastRightClickTarget.contextKind === "image" || lastRightClickTarget.contextKind === "video")) {
            sendResponse({ok: true, contextKind: lastRightClickTarget.contextKind, resource: lastRightClickTarget.resource});
            return false;
          }
        }

        // 3. Check if pointer is on selected text
        const probePoint = message.point || lastPointer || {x: 0, y: 0};
        if (!reqSrcUrl && pointIntersectsSelection(probePoint)) {
          const fontTarget = resolveFontForSelectedText();
          if (fontTarget) {
            sendResponse({ok: true, contextKind: "font", fontTarget});
            return false;
          }
        }

        // 4. Fallback: probe media at probePoint
        if (probePoint.x > 0 || probePoint.y > 0) {
          const element = mediaElementAtPoint(probePoint.x, probePoint.y);
          if (element) {
            const res = buildResource(element);
            if (res) {
              sendResponse({ok: true, contextKind: "image", resource: res});
              return false;
            }
          }
        }
      } catch (_) {}
      sendResponse({ok: false, resource: null, contextKind: "none"});
      return false;
    }

    if (message?.action === "moodbox-context-probe") {
      try {
        const now = Date.now();
        if (lastRightClickTarget && (now - lastRightClickTarget.time) < 30_000 && lastRightClickTarget.resource?.url) {
          sendResponse({ok: true, contextKind: lastRightClickTarget.contextKind, resource: lastRightClickTarget.resource, point: lastRightClickTarget.point, pageUrl: location.href, pageTitle: document.title || ""});
          return false;
        }

        const point = message.point && Number.isFinite(Number(message.point.x)) && Number.isFinite(Number(message.point.y))
          ? {x:Number(message.point.x), y:Number(message.point.y)}
          : {x:Number(lastPointer.x || 0), y:Number(lastPointer.y || 0)};
        const x = point.x;
        const y = point.y;
        const element = mediaElementAtPoint(x, y);
        if (!element) {
          sendResponse({ok:false, contextKind:"page", resource:null, point, pageUrl:location.href, pageTitle:document.title || ""});
          return false;
        }
        let thumbnail = buildVideoThumbnailResource(element);
        if (!thumbnail) {
          const videoRoot = targetSocialVideoRoot(element) || element.closest?.("figure,article,li,[role='article'],[role='dialog']");
          if (videoRoot && videoRoot !== element) thumbnail = buildVideoThumbnailResource(videoRoot);
        }
        if (thumbnail) {
          lastPointer = {x,y};
          syncNativeContextTarget(element, thumbnail);
          sendResponse({ok:true, contextKind:"video", resource:thumbnail, point, pageUrl:location.href, pageTitle:document.title || ""});
          return false;
        }
        const resource = buildResource(element);
        if (resource?.url) {
          lastPointer = {x,y};
          syncNativeContextTarget(element, resource);
          sendResponse({ok:true, contextKind:"image", resource, point, pageUrl:location.href, pageTitle:document.title || ""});
          return false;
        }
        sendResponse({ok:false, contextKind:"page", resource:null, point, pageUrl:location.href, pageTitle:document.title || ""});
      } catch (error) {
        sendResponse({ok:false, contextKind:"page", resource:null, error:error?.message || "Could not inspect the clicked point."});
      }
      return false;
    }
    if (message?.action === "moodboxDownload-collect-batch") {
      (async () => {
        try {
          const scanMode = message.scanMode === "deep" ? "deep" : (message.scanMode === "fonts" ? "fonts" : "quick");
          if (scanMode === "deep") await warmLazyBatchImages();
          sendResponse({
            ok: true,
            items: collectBatchResources(scanMode),
            stylesheets: scanMode === "fonts" ? collectFontStylesheetUrls() : [],
            pageUrl: location.href,
            pageTitle: document.title || ""
          });
        } catch (error) {
          sendResponse({ok: false, error: error?.message || "Could not scan this page."});
        }
      })();
      return true;
    }
    if (message?.action === "moodboxDownload-resolve-batch-resource") {
      resolveBatchResource(message.url).then(sendResponse);
      return true;
    }
    if (message?.action !== "moodboxDownload-resource-for-src") return false;
    const wanted = String(message.srcUrl || "");
    const matches = [];
    for (const image of document.images) {
      const values = [
        image.currentSrc, image.src,
        image.getAttribute("data-src"), image.getAttribute("data-original"),
        image.getAttribute("data-original-src"), image.getAttribute("data-pin-media")
      ].map(absoluteUrl).filter(Boolean);
      if (!values.some(v => urlsMatch(v, wanted))) continue;
      const rect = visibleRect(image);
      matches.push({image, area: rect ? rect.width * rect.height : 0});
    }
    matches.sort((a, b) => b.area - a.area);
    const element = matches[0]?.image || null;
    if (!element) {
      sendResponse({ok: false, error: "The selected page image is no longer available."});
      return false;
    }
    const resource = buildResource(element);
    sendResponse(resource ? {ok: true, resource} : {ok: false, error: "Could not read this page image."});
    return false;
  });


})();
