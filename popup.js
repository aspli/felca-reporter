// FELCA Reporter — popup.js

const REASON_MAP = {
  violent: { key: 'violent', label: 'Violento ou repulsivo' },
  sexual: { key: 'sexual', label: 'Conteúdo sexual' },
  child_abuse: { key: 'child_abuse', label: 'Abuso infantil' },
  harmful: { key: 'harmful', label: 'Atos perigosos' }
};

const DEFAULT_MESSAGE = `Com a entrada em vigor da Lei nº 15.211/2025 (Lei Felca / ECA Digital), em 17 de março de 2026, as plataformas são obrigadas a garantir mecanismos de verificação de idade para conteúdos impróprios para menores. Se você publica vídeos com classificação +18, você precisa ativar a restrição de idade diretamente nas configurações do vídeo no YouTube Studio — caso contrário, fica sujeito a denúncias e remoção por descumprimento da legislação vigente.`;

let okCount = 0;
let failCount = 0;
let total = 0;
let done = 0;
let urlItems = [];
let reportJob = null;

// DOM
const urlInput = document.getElementById('urlInput');
const urlPillBox = document.getElementById('urlPillBox');
const reasonSel = document.getElementById('reasonSelect');
const msgInput = document.getElementById('msgInput');
const msgToggle = document.getElementById('msgToggle');
const charCount = document.getElementById('charCount');
const btnReport = document.getElementById('btnReport');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const logList = document.getElementById('logList');
const summary = document.getElementById('summary');
const countOk = document.getElementById('countOk');
const countFail = document.getElementById('countFail');
const reportStatusBadge = document.getElementById('reportStatusBadge');
const reportStatusSummary = document.getElementById('reportStatusSummary');
const reportStatusCurrent = document.getElementById('reportStatusCurrent');
const btnTogglePause = document.getElementById('btnTogglePause');
const btnCancelJob = document.getElementById('btnCancelJob');
const btnBackEditor = document.getElementById('btnBackEditor');
const btnClearJob = document.getElementById('btnClearJob');
const historyList = document.getElementById('historyList');
const btnClear = document.getElementById('btnClear');
const btnClearList = document.getElementById('btnClearList');

// Tabs
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('page-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'history') renderHistory();
  });
});

// Restaura estado salvo
chrome.storage.local.get(['savedUrls', 'savedMessage', 'reportJob'], res => {
  urlItems = parseStoredUrls(res.savedUrls || '');
  renderUrlPills();
  syncQueuedVideosFromUrls();
  msgInput.value = res.savedMessage !== undefined ? res.savedMessage : DEFAULT_MESSAGE;
  reportJob = res.reportJob || null;
  renderReportState(reportJob);
  updateCharCount();
});

urlInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  addUrlsFromText(urlInput.value);
  urlInput.value = '';
});

urlInput.addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text') || '';
  if (!text) return;
  if (!text.includes('\n') && !text.includes('\r') && !text.includes('youtube.com') && !text.includes('youtu.be')) {
    return;
  }
  event.preventDefault();
  addUrlsFromText(text);
  urlInput.value = '';
});

urlInput.addEventListener('blur', () => {
  const raw = urlInput.value.trim();
  if (!raw) return;
  addUrlsFromText(raw);
  urlInput.value = '';
});

msgInput.addEventListener('input', () => {
  chrome.storage.local.set({ savedMessage: msgInput.value });
  updateCharCount();
});

function updateCharCount() {
  const len = msgInput.value.length;
  charCount.textContent = `${len} / 500`;
  charCount.className = 'char-count' + (len > 450 ? ' over' : len > 380 ? ' warn' : '');
}

msgToggle.addEventListener('click', () => {
  msgInput.value = DEFAULT_MESSAGE;
  chrome.storage.local.set({ savedMessage: DEFAULT_MESSAGE });
  updateCharCount();
});

function parseStoredUrls(raw) {
  const seen = new Set();
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(normalizeYoutubeUrl)
    .filter(Boolean)
    .filter(url => {
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function splitCandidateUrls(raw) {
  return raw
    .split(/[\n,]+/)
    .map(line => line.trim())
    .filter(Boolean);
}

function extractVideoId(raw) {
  try {
    const url = new URL(raw);
    if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
    return url.searchParams.get('v');
  } catch {
    return null;
  }
}

function normalizeYoutubeUrl(raw) {
  try {
    const url = new URL(raw);
    const videoId = extractVideoId(raw);
    if (!videoId) return null;
    if (!url.hostname.includes('youtube.com') && url.hostname !== 'youtu.be') return null;
    return `https://www.youtube.com/watch?v=${videoId}`;
  } catch {
    return null;
  }
}

function addUrlsFromText(raw) {
  const next = [];
  const seen = new Set(urlItems);

  splitCandidateUrls(raw).forEach(candidate => {
    const normalized = normalizeYoutubeUrl(candidate);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    next.push(normalized);
  });

  if (!next.length) {
    renderUrlPills();
    return;
  }

  urlItems = [...urlItems, ...next];
  syncUrls();
  renderUrlPills();
}

function removeUrlAt(index) {
  if (index < 0 || index >= urlItems.length) return;
  urlItems.splice(index, 1);
  syncUrls();
  renderUrlPills();
}

function syncUrls() {
  const savedUrls = urlItems.join('\n');
  const queuedVideos = urlItems.map(url => {
    const videoId = extractVideoId(url);
    return {
      videoId,
      url,
      title: '',
      ts: Date.now()
    };
  }).filter(item => item.videoId);

  chrome.storage.local.set({
    savedUrls,
    queuedVideos
  });
}

function syncQueuedVideosFromUrls() {
  const queuedVideos = urlItems.map(url => {
    const videoId = extractVideoId(url);
    return {
      videoId,
      url,
      title: '',
      ts: Date.now()
    };
  }).filter(item => item.videoId);

  chrome.storage.local.set({ queuedVideos });
}

function shortUrl(url) {
  return url.replace('https://www.youtube.com/watch?v=', 'youtube.com/watch?v=');
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderUrlPills() {
  if (!urlItems.length) {
    urlPillBox.innerHTML = '<div class="url-pill-empty">Nenhuma URL adicionada ainda.</div>';
    return;
  }

  urlPillBox.innerHTML = urlItems.map((url, idx) => `
    <div class="url-pill" title="${escapeHtml(url)}">
      <span class="url-pill-text">${escapeHtml(shortUrl(url))}</span>
      <button type="button" class="url-pill-remove" data-index="${idx}" aria-label="Remover URL">×</button>
    </div>
  `).join('');
}

function shortDisplayUrl(url) {
  return url ? url.replace('https://', '').replace('www.', '') : '';
}

function renderReportState(job) {
  reportJob = job || null;

  if (!job) {
    document.body.classList.remove('is-executing');
    document.body.classList.remove('job-finished');
    reportStatusBadge.className = 'status-badge';
    reportStatusBadge.textContent = 'parado';
    reportStatusSummary.textContent = 'Nenhuma denúncia em andamento.';
    reportStatusCurrent.textContent = '';
    btnReport.disabled = false;
    btnReport.classList.remove('running');
    btnReport.textContent = '🚨 Denunciar todos os vídeos';
    progressWrap.classList.remove('show');
    progressFill.style.width = '0%';
    summary.classList.remove('show');
    countOk.textContent = '0';
    countFail.textContent = '0';
    btnTogglePause.disabled = true;
    btnTogglePause.textContent = 'Pausar';
    btnCancelJob.disabled = true;
    btnBackEditor.style.display = 'none';
    btnClearJob.disabled = true;
    btnClearJob.textContent = 'Limpar fila';
    return;
  }

  okCount = job.okCount || 0;
  failCount = job.failCount || 0;
  total = job.total || 0;
  done = job.done || 0;

  const isRunning = !!job.running;
  const isPaused = !!job.paused;
  const isCancelled = !!job.cancelled;
  const isFinished = !isRunning && !isPaused;
  document.body.classList.toggle('is-executing', isRunning || isPaused);
  document.body.classList.toggle('job-finished', isFinished);
  const badgeClass = isPaused ? 'paused' : (isRunning ? 'running' : (isCancelled || failCount > 0 ? 'error' : 'done'));
  const badgeText = isPaused ? 'pausado' : (isRunning ? 'em andamento' : (isCancelled ? 'cancelado' : (failCount > 0 ? 'concluído com falhas' : 'concluído')));

  reportStatusBadge.className = `status-badge ${badgeClass}`;
  reportStatusBadge.textContent = badgeText;
  reportStatusSummary.textContent = isFinished
    ? `Fila finalizada. ${done} / ${total} processados. ${okCount} ok, ${failCount} falhas.${isCancelled ? ' A fila foi cancelada.' : ''}`
    : `${done} / ${total} processados. ${okCount} ok, ${failCount} falhas.${isPaused ? ' A fila está pausada.' : ''}${isCancelled ? ' A fila foi cancelada.' : ''}`;
  reportStatusCurrent.textContent = job.currentUrl ? `Atual: ${shortDisplayUrl(job.currentUrl)}` : '';
  countOk.textContent = String(okCount);
  countFail.textContent = String(failCount);

  progressWrap.classList.toggle('show', true);
  progressFill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  btnReport.disabled = isRunning || isPaused;
  btnReport.classList.toggle('running', isRunning || isPaused);
  btnReport.textContent = isRunning
    ? `⏳ Processando ${done} / ${total || 0}...`
    : isPaused
      ? `⏸️ Pausado ${done} / ${total || 0}`
    : isCancelled
      ? '🚨 Denunciar todos os vídeos'
      : '🚨 Denunciar todos os vídeos';
  summary.classList.toggle('show', true);
  btnTogglePause.disabled = !isRunning && !isPaused;
  btnTogglePause.textContent = isPaused ? 'Continuar' : 'Pausar';
  btnCancelJob.disabled = !isRunning && !isPaused;
  btnBackEditor.style.display = isFinished ? 'inline-flex' : 'none';
  btnClearJob.disabled = isRunning || isPaused ? true : false;
  btnClearJob.textContent = isFinished ? 'Limpar fila' : 'Limpar fila';
}

urlPillBox.addEventListener('click', event => {
  const btn = event.target.closest('.url-pill-remove');
  if (!btn) return;
  const idx = Number(btn.dataset.index);
  if (Number.isNaN(idx)) return;
  removeUrlAt(idx);
});

// Log helpers
function addLog(status, message, url) {
  const el = document.createElement('div');
  el.className = `log-item ${status}`;
  el.innerHTML = `<span class="log-dot"></span>
    <span class="log-text">${message}<span class="log-url">${url}</span></span>`;
  logList.appendChild(el);
  logList.scrollTop = logList.scrollHeight;
}

function removePending() {
  logList.querySelector('.log-item.pending')?.remove();
}

function renderHistory() {
  chrome.storage.local.get('reportHistory', ({ reportHistory = [] }) => {
    if (!reportHistory.length) {
      historyList.innerHTML = '<div class="history-empty"><span>📭</span>Nenhuma denúncia registrada ainda.</div>';
      return;
    }
    historyList.innerHTML = reportHistory.map(item => {
      const d = new Date(item.ts);
      const date = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const shortUrlText = item.url.replace('https://', '').replace('www.', '');
      return `<div class="history-item ${item.success ? 'ok' : 'fail'}">
        <div class="history-icon">${item.success ? '✅' : '❌'}</div>
        <div class="history-body">
          <span class="history-url" title="${item.url}">${shortUrlText}</span>
          <div class="history-meta">
            <span>${date}</span>
            <span class="history-tag">${item.reason}</span>
            ${!item.success && item.error ? `<span class="history-err">${item.error.slice(0, 60)}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;

  if (changes.savedUrls) {
    urlItems = parseStoredUrls(changes.savedUrls.newValue || '');
    renderUrlPills();
    syncQueuedVideosFromUrls();
  }

  if (changes.reportJob) {
    renderReportState(changes.reportJob.newValue || null);
  }
});

async function patchReportJob(patch) {
  const { reportJob = null } = await chrome.storage.local.get('reportJob');
  if (!reportJob) return;
  await chrome.storage.local.set({
    reportJob: {
      ...reportJob,
      ...patch,
      updatedAt: Date.now()
    }
  });
}

btnTogglePause.addEventListener('click', async () => {
  if (!reportJob || (!reportJob.running && !reportJob.paused)) return;
  await patchReportJob({ paused: !reportJob.paused, cancelled: false, status: !reportJob.paused ? 'Pausado' : 'Retomando...' });
});

btnCancelJob.addEventListener('click', async () => {
  if (!reportJob || (!reportJob.running && !reportJob.paused)) return;
  if (!confirm('Cancelar a denúncia em andamento?')) return;
  await patchReportJob({ cancelled: true, paused: false, status: 'Cancelando...' });
});

btnClearJob.addEventListener('click', async () => {
  if (!reportJob || reportJob.running || reportJob.paused) return;
  if (!confirm('Limpar a fila real e o estado atual?')) return;
  urlItems = [];
  renderUrlPills();
  await chrome.storage.local.set({
    savedUrls: '',
    queuedVideos: []
  });
  await chrome.storage.local.remove('reportJob');
});

btnBackEditor.addEventListener('click', async () => {
  if (!reportJob || reportJob.running || reportJob.paused) return;
  await chrome.storage.local.remove('reportJob');
});

btnClear.addEventListener('click', () => {
  if (confirm('Apagar todo o histórico de denúncias?')) {
    chrome.storage.local.set({ reportHistory: [] }, renderHistory);
  }
});

btnClearList.addEventListener('click', () => {
  if (!confirm('Limpar toda a lista de URLs?')) return;
  urlItems = [];
  syncUrls();
  renderUrlPills();
  urlInput.value = '';
});

// Main
btnReport.addEventListener('click', async () => {
  const urls = [...urlItems];
  const valid = urls.filter(Boolean);

  if (!valid.length) {
    alert('Nenhuma URL válida do YouTube encontrada.\n\nCole uma URL e pressione Enter, ou use URLs do tipo:\nhttps://www.youtube.com/watch?v=XXXXX\nhttps://youtu.be/XXXXX');
    return;
  }

  const reasonKey = reasonSel.value;
  const reasonData = REASON_MAP[reasonKey];
  const userComment = msgInput.value.trim();

  if (reportJob?.running) {
    alert('Já existe uma denúncia em andamento.');
    return;
  }

  const jobId = `job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const initialJob = {
    jobId,
    running: true,
    paused: false,
    cancelled: false,
    total: valid.length,
    done: 0,
    okCount: 0,
    failCount: 0,
    currentUrl: '',
    status: 'Iniciando...',
    reason: reasonData.label,
    startedAt: Date.now(),
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({ reportJob: initialJob });
  chrome.runtime.sendMessage({
    action: 'startReportBatch',
    jobId,
    urls: valid,
    reasonData,
    userComment
  });
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
