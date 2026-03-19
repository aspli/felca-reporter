// ── FELCA Reporter — content.js ───────────────────────────────────────────
// Adds a local queue action into the "More actions" dropdown on channel video
// listing pages and a playlist import button on /playlist?list=... pages.

(function () {
  const STYLE_ID = 'felca-queue-style';
  const ITEM_CLASS = 'felca-queue-menu-item';
  const ITEM_LABEL_CLASS = 'felca-queue-menu-label';
  const PLAYLIST_BTN_CLASS = 'felca-playlist-import-btn';

  let queuedVideoIds = new Set();
  let currentMenuVideo = null;
  let refreshTimer = null;
  let playlistImporterRunning = false;

  init();

  async function init() {
    injectStyles();
    await restoreState();
    watchStorage();
    trackMenuSource();
    setupPlaylistImporter();
    observeDropdowns();
    document.addEventListener('yt-navigate-finish', setupPlaylistImporter);
    window.addEventListener('popstate', setupPlaylistImporter);
  }

  async function restoreState() {
    const { queuedVideos = [] } = await chrome.storage.local.get('queuedVideos');
    queuedVideoIds = new Set(queuedVideos.map(item => item?.videoId).filter(Boolean));
  }

  function watchStorage() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.queuedVideos) return;
      const items = changes.queuedVideos.newValue || [];
      queuedVideoIds = new Set(items.map(item => item?.videoId).filter(Boolean));
    });
  }

  function trackMenuSource() {
    document.addEventListener('pointerdown', event => {
      if (!isVideoListPage()) return;

      const button = event.target.closest(
        'button[aria-label="Mais ações"], button[aria-label="More actions"], button[aria-label="Menu de ações"]'
      );
      if (!button) return;

      const card = button.closest('ytd-rich-item-renderer, ytd-grid-video-renderer');
      if (!card) return;

      const video = getVideoFromCard(card);
      if (!video) return;

      currentMenuVideo = video;

      // Remove item antigo imediatamente ao abrir novo menu
      removeOldItems();

      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refreshOpenDropdown, 150);
    }, true);
  }

  function removeOldItems() {
    document.querySelectorAll('.' + ITEM_CLASS).forEach(el => el.remove());
  }

  function observeDropdowns() {
    const observer = new MutationObserver(() => {
      if (!isVideoListPage()) return;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(refreshOpenDropdown, 200);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function setupPlaylistImporter() {
    if (!isPlaylistPage()) return;
    injectPlaylistButton();
  }

  function injectPlaylistButton() {
    if (document.querySelector('.' + PLAYLIST_BTN_CLASS)) return;

    const target = document.querySelector('#primary-inner, ytd-watch-metadata, #contents');
    if (!target) {
      window.setTimeout(injectPlaylistButton, 1000);
      return;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = PLAYLIST_BTN_CLASS;
    button.textContent = 'Importar playlist desta página';
    button.addEventListener('click', () => importCurrentPlaylist());
    target.prepend(button);
  }

  function getPlaylistButton() {
    return document.querySelector('.' + PLAYLIST_BTN_CLASS);
  }

  function refreshOpenDropdown(attempt) {
    if (attempt === undefined) attempt = 0;
    let injected = false;

    document.querySelectorAll('tp-yt-iron-dropdown').forEach(dropdown => {
      if (!isDropdownVisible(dropdown)) return;
      const list = dropdown.querySelector('tp-yt-paper-listbox');
      if (list) { injectMenuItemIntoList(list); injected = true; }
    });

    document.querySelectorAll('ytd-menu-popup-renderer').forEach(popup => {
      if (!popup.offsetParent) return;
      const list = popup.querySelector('tp-yt-paper-listbox');
      if (list) { injectMenuItemIntoList(list); injected = true; }
    });

    // Retry se o listbox ainda nao estava pronto (race condition)
    if (!injected && attempt < 5) {
      window.setTimeout(function() { refreshOpenDropdown(attempt + 1); }, 100);
    }
  }

  function injectMenuItemIntoList(list) {
    if (!list || !currentMenuVideo) return;

    // Remove item antigo antes de reinjetar (garante atualização do estado)
    list.querySelectorAll('.' + ITEM_CLASS).forEach(el => el.remove());

    const menuVideo = currentMenuVideo;
    const isQueued = queuedVideoIds.has(menuVideo.videoId);
    const labelText = isQueued ? 'Na fila da extensão' : 'Adicionar à fila da extensão';

    const item = document.createElement('div');
    item.className = ITEM_CLASS + (isQueued ? ' is-added' : '');
    item.setAttribute('role', 'menuitem');
    item.dataset.videoId = menuVideo.videoId;
    item.innerHTML =
      '<div class="felca-item-inner">' +
        '<span class="felca-item-icon">' +
          '<svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 0 24 24" width="24" focusable="false" aria-hidden="true">' +
            '<path d="M19 3H5c-1.1 0-2 .9-2 2v11h2V5h14v14h-9v2h9c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2Zm-8 16H8v-3H6v3H3v2h3v3h2v-3h3v-2Z" fill="currentColor"></path>' +
          '</svg>' +
        '</span>' +
        '<span class="' + ITEM_LABEL_CLASS + '">' + labelText + '</span>' +
      '</div>';

    let activated = false;

    const handleActivate = async event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      if (activated || queuedVideoIds.has(menuVideo.videoId)) return;
      activated = true;
      await addVideoToQueue(menuVideo);
      const labelEl = item.querySelector('.' + ITEM_LABEL_CLASS);
      if (labelEl) labelEl.textContent = 'Na fila da extensão';
      item.classList.add('is-added');
    };

    item.addEventListener('mousedown', handleActivate, true);
    item.addEventListener('touchstart', handleActivate, true);
    item.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      handleActivate(event);
    }, true);

    list.appendChild(item);
  }

  function isVideoListPage() {
    return location.hostname === 'www.youtube.com' && /\/videos(?:\/|$)?/.test(location.pathname);
  }

  function isPlaylistPage() {
    return location.hostname === 'www.youtube.com' && location.pathname === '/playlist' && location.search.includes('list=');
  }

  function isDropdownVisible(dropdown) {
    return dropdown.offsetParent !== null || dropdown.style.display !== 'none';
  }

  function getVideoFromCard(card) {
    const anchor = card.querySelector('a[href*="/watch?v="]');
    if (!anchor) return null;

    let url;
    try {
      url = new URL(anchor.getAttribute('href'), location.origin).toString();
    } catch {
      return null;
    }

    const videoId = extractVideoId(url);
    if (!videoId) return null;

    const titleEl = card.querySelector('.yt-lockup-metadata-view-model__title, #video-title, #video-title-link');
    return {
      videoId,
      url,
      title: titleEl?.textContent?.trim() || ''
    };
  }

  function extractVideoId(url) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1) || null;
      return parsed.searchParams.get('v');
    } catch {
      return null;
    }
  }

  async function addVideoToQueue(video) {
    const { queuedVideos = [], savedUrls = '' } = await chrome.storage.local.get([
      'queuedVideos',
      'savedUrls'
    ]);

    if (queuedVideos.some(item => item.videoId === video.videoId)) {
      queuedVideoIds.add(video.videoId);
      return;
    }

    const nextQueuedVideos = [
      {
        videoId: video.videoId,
        url: video.url,
        title: video.title,
        ts: Date.now()
      },
      ...queuedVideos
    ].slice(0, 500);

    const savedLines = savedUrls
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    if (!savedLines.includes(video.url)) savedLines.push(video.url);

    await chrome.storage.local.set({
      queuedVideos: nextQueuedVideos,
      savedUrls: savedLines.join('\n')
    });

    queuedVideoIds.add(video.videoId);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function importCurrentPlaylist() {
    if (playlistImporterRunning) return;
    playlistImporterRunning = true;
    const button = getPlaylistButton();

    if (button) {
      button.disabled = true;
      button.dataset.label = button.textContent;
      button.textContent = 'Importando...';
      button.classList.add('is-loading');
    }

    try {
      const collected = new Map();
      let stableRounds = 0;
      let lastCount = 0;

      for (let i = 0; i < 30 && stableRounds < 3; i++) {
        await waitForPlaylistItems(1500);
        collectPlaylistUrls(collected);

        const currentCount = collected.size;
        if (currentCount === lastCount) stableRounds++;
        else stableRounds = 0;
        lastCount = currentCount;

        window.scrollTo(0, document.documentElement.scrollHeight);
        await sleep(1200);
      }

      collectPlaylistUrls(collected);
      const urls = [...collected.values()];

      if (!urls.length) {
        alert('Nenhuma URL de vídeo encontrada nesta playlist.');
        return;
      }

      const { queuedVideos = [], savedUrls = '' } = await chrome.storage.local.get([
        'queuedVideos',
        'savedUrls'
      ]);

      const queuedById = new Map(queuedVideos.map(item => [item.videoId, item]));
      const savedSet = new Set(savedUrls.split('\n').map(line => line.trim()).filter(Boolean));
      const nextQueuedVideos = [...queuedVideos];
      let added = 0;
      let skipped = 0;

      for (const url of urls) {
        const videoId = extractVideoId(url);
        if (!videoId || queuedById.has(videoId)) {
          skipped++;
          continue;
        }

        nextQueuedVideos.unshift({
          videoId,
          url,
          title: '',
          ts: Date.now()
        });
        queuedById.set(videoId, true);
        savedSet.add(url);
        queuedVideoIds.add(videoId);
        added++;
      }

      await chrome.storage.local.set({
        queuedVideos: nextQueuedVideos.slice(0, 500),
        savedUrls: [...savedSet].join('\n')
      });

      alert('Playlist lida: ' + urls.length + ' vídeo(s) encontrados. ' + added + ' adicionados à fila' + (skipped ? ', ' + skipped + ' já estavam na fila' : '') + '.');
    } finally {
      playlistImporterRunning = false;
      if (button) {
        button.disabled = false;
        button.textContent = button.dataset.label || 'Importar playlist desta página';
        button.classList.remove('is-loading');
        delete button.dataset.label;
      }
    }
  }

  function collectPlaylistUrls(collected) {
    const anchors = document.querySelectorAll([
      'ytd-playlist-video-renderer a#video-title[href*="/watch?v="]',
      'ytd-playlist-video-renderer a#thumbnail[href*="/watch?v="]',
      'ytd-playlist-video-renderer a[href*="/watch?v="]',
      'a#video-title[href*="/watch?v="]',
      'a#thumbnail[href*="/watch?v="]'
    ].join(', '));

    anchors.forEach(anchor => {
      const href = anchor.getAttribute('href');
      if (!href) return;

      try {
        const url = new URL(href, location.origin).toString();
        const videoId = extractVideoId(url);
        if (!videoId || collected.has(videoId)) return;
        collected.set(videoId, url);
      } catch {
        return;
      }
    });
  }

  function waitForPlaylistItems(timeoutMs) {
    if (timeoutMs === undefined) timeoutMs = 1500;
    return new Promise(resolve => {
      const start = Date.now();
      const tick = () => {
        const count = document.querySelectorAll(
          'ytd-playlist-video-renderer a#video-title[href*="/watch?v="], ytd-playlist-video-renderer a#thumbnail[href*="/watch?v="]'
        ).length;
        if (count > 0 || Date.now() - start >= timeoutMs) {
          resolve();
          return;
        }
        window.setTimeout(tick, 100);
      };
      tick();
    });
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.felca-queue-menu-item {' +
        'display: flex; align-items: center;' +
        'padding: 0; margin: 0; cursor: pointer; list-style: none;' +
      '}' +
      '.felca-item-inner, .felca-item-inner * { pointer-events: none; }' +
      '.felca-item-inner {' +
        'display: flex; align-items: center; gap: 16px;' +
        'padding: 0 16px; height: 36px; width: 100%;' +
        'font-family: Roboto, Arial, sans-serif;' +
        'font-size: 1.4rem; font-weight: 400;' +
        'color: var(--yt-spec-text-primary, #0f0f0f);' +
        'box-sizing: border-box;' +
      '}' +
      '.felca-item-inner:hover {' +
        'background: var(--yt-spec-badge-chip-background, rgba(0,0,0,.05));' +
      '}' +
      '.felca-item-icon {' +
        'display: flex; align-items: center; justify-content: center;' +
        'width: 24px; height: 24px; flex-shrink: 0;' +
        'color: var(--yt-spec-text-primary, #0f0f0f);' +
      '}' +
      '.felca-queue-menu-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
      '.felca-queue-menu-item.is-added .felca-queue-menu-label { color: rgb(20, 168, 110); font-weight: 600; }' +
      'ytd-menu-popup-renderer { max-height: none !important; }' +
      'ytd-menu-popup-renderer tp-yt-paper-listbox { max-height: none !important; overflow: visible !important; }' +
      '.felca-playlist-import-btn {' +
        'display: inline-flex; align-items: center; justify-content: center;' +
        'margin: 12px 0; padding: 10px 14px;' +
        'border: 1px solid rgba(255,45,85,.5); border-radius: 999px;' +
        'background: rgba(255,45,85,.12); color: #fff;' +
        'font: 700 13px/1 Arial,sans-serif; cursor: pointer;' +
      '}' +
      '.felca-playlist-import-btn:hover { background: rgba(255,45,85,.18); }' +
      '.felca-playlist-import-btn.is-loading { opacity: .75; cursor: progress; }';

    document.documentElement.appendChild(style);
  }
})();