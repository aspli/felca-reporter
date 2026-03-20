// FELCA Reporter — popup.js

const REASON_MAP = {
	violent: { key: 'violent', label: 'Violento ou repulsivo' },
	sexual: { key: 'sexual', label: 'Conteúdo sexual' },
	child_abuse: { key: 'child_abuse', label: 'Abuso infantil' },
	harmful: { key: 'harmful', label: 'Atos perigosos' },
};

const DEFAULT_MESSAGE = `Com a entrada em vigor da Lei nº 15.211/2025 (Lei Felca / ECA Digital), em 17 de março de 2026, as plataformas são obrigadas a garantir mecanismos de verificação de idade para conteúdos impróprios para menores. Se você publica vídeos com classificação +18, você precisa ativar a restrição de idade diretamente nas configurações do vídeo no YouTube Studio — caso contrário, fica sujeito a denúncias e remoção por descumprimento da legislação vigente.`;

let okCount = 0,
	failCount = 0,
	total = 0,
	done = 0;

// DOM
const urlInput = document.getElementById('urlInput');
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
const historyList = document.getElementById('historyList');
const btnClear = document.getElementById('btnClear');
const urlPillBox = document.getElementById('urlPillBox');
const btnClearJob = document.getElementById('btnClearJob');
const btnTogglePause = document.getElementById('btnTogglePause');
const btnCancelJob = document.getElementById('btnCancelJob');
const btnBackEditor = document.getElementById('btnBackEditor');

// Integration elements
const endpointUrlInput = document.getElementById('endpointUrl');
const btnFetch = document.getElementById('btnFetch');
const fetchStatus = document.getElementById('fetchStatus');
const fetchedList = document.getElementById('fetchedList');
const btnAddAll = document.getElementById('btnAddAll');

let urlItems = [];
let fetchedVideos = [];

// Tabs
document.querySelectorAll('.tab').forEach((tab) => {
	tab.addEventListener('click', () => {
		document
			.querySelectorAll('.tab')
			.forEach((t) => t.classList.remove('active'));
		document
			.querySelectorAll('.page')
			.forEach((p) => p.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById('page-' + tab.dataset.tab).classList.add('active');
		if (tab.dataset.tab === 'history') renderHistory();
	});
});

// Integration: Restore saved endpoint URL
chrome.storage.local.get(['savedEndpointUrl'], (res) => {
	if (res.savedEndpointUrl) {
		endpointUrlInput.value = res.savedEndpointUrl;
	}
});

endpointUrlInput.addEventListener('change', () => {
	chrome.storage.local.set({ savedEndpointUrl: endpointUrlInput.value.trim() });
});

// Integration: Fetch videos from endpoint
btnFetch.addEventListener('click', async () => {
	const url = endpointUrlInput.value.trim();
	if (!url) {
		showFetchStatus('error', 'Informe a URL do endpoint');
		return;
	}

	btnFetch.disabled = true;
	showFetchStatus('loading', 'Buscando vídeos...');
	fetchedList.innerHTML = '';
	btnAddAll.style.display = 'none';
	fetchedVideos = [];

	try {
		const response = await fetch(url, { method: 'GET' });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const data = await response.json();
		const videos = data.videos || [];

		if (!Array.isArray(videos) || videos.length === 0) {
			showFetchStatus('success', 'Nenhum vídeo encontrado no endpoint');
			btnFetch.disabled = false;
			return;
		}

		// Validate and categorize videos
		const validVideos = [];
		const invalidVideos = [];
		const duplicateVideos = [];

		for (const videoUrl of videos) {
			const isValid = parseUrls(videoUrl).filter(Boolean).length > 0;
			const isDuplicate = urlItems.includes(videoUrl) || validVideos.includes(videoUrl);

			if (!isValid) {
				invalidVideos.push(videoUrl);
			} else if (isDuplicate) {
				duplicateVideos.push(videoUrl);
			} else {
				validVideos.push(videoUrl);
			}
		}

		fetchedVideos = validVideos;

		// Render fetched list
		renderFetchedList(validVideos, invalidVideos, duplicateVideos);

		const parts = [];
		if (validVideos.length) parts.push(`${validVideos.length} válido(s)`);
		if (duplicateVideos.length) parts.push(`${duplicateVideos.length} duplicado(s)`);
		if (invalidVideos.length) parts.push(`${invalidVideos.length} inválido(s)`);

		showFetchStatus('success', `Encontrados: ${parts.join(', ')}`);

		if (validVideos.length > 0) {
			btnAddAll.style.display = 'block';
		}
	} catch (err) {
		showFetchStatus('error', `Erro: ${err.message}`);
	} finally {
		btnFetch.disabled = false;
	}
});

function showFetchStatus(type, message) {
	fetchStatus.className = 'fetch-status show ' + type;
	fetchStatus.textContent = message;
}

function renderFetchedList(valid, invalid, duplicates) {
	const items = [];

	for (const url of valid) {
		items.push(`<div class="fetched-item"><span class="url">${escapeHtml(url)}</span><span class="status">novo</span></div>`);
	}
	for (const url of duplicates) {
		items.push(`<div class="fetched-item"><span class="url">${escapeHtml(url)}</span><span class="status skip">duplicado</span></div>`);
	}
	for (const url of invalid) {
		items.push(`<div class="fetched-item"><span class="url">${escapeHtml(url)}</span><span class="status skip" style="background:rgba(255,45,85,.15);color:var(--accent)">inválido</span></div>`);
	}

	fetchedList.innerHTML = items.join('');
}

function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

// Integration: Add all fetched videos to main list
btnAddAll.addEventListener('click', () => {
	if (fetchedVideos.length === 0) return;

	const count = fetchedVideos.length;
	urlItems.push(...fetchedVideos);
	syncUrls();
	renderUrlPills();

	// Clear integration state
	fetchedVideos = [];
	fetchedList.innerHTML = '';
	btnAddAll.style.display = 'none';
	showFetchStatus('success', `${count} vídeo(s) adicionados à lista de denúncias!`);

	// Switch to report tab
	document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
	document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
	document.querySelector('[data-tab="report"]').classList.add('active');
	document.getElementById('page-report').classList.add('active');
});

// Restaura estado salvo
chrome.storage.local.get(['savedUrls', 'savedMessage'], (res) => {
	urlItems = (res.savedUrls || '')
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	renderUrlPills();

	msgInput.value =
		res.savedMessage !== undefined ? res.savedMessage : DEFAULT_MESSAGE;
	updateCharCount();
});

urlInput.addEventListener('keydown', (e) => {
	if (e.key !== 'Enter') return;
	e.preventDefault();

	const raw = urlInput.value.trim();
	if (!raw) return;

	const lines = raw
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);

	if (!lines.length) return;

	urlItems.push(...lines);
	syncUrls();
	renderUrlPills();
	urlInput.value = '';
});

msgInput.addEventListener('input', () => {
	chrome.storage.local.set({ savedMessage: msgInput.value });
	updateCharCount();
});

function syncUrls() {
	chrome.storage.local.set({ savedUrls: urlItems.join('\n') });
}

function renderUrlPills() {
  if (!urlItems.length) {
    urlPillBox.innerHTML =
      '<div class="url-pill-empty">Nenhuma URL adicionada ainda.</div>';
    return;
  }

  // NOVA LÓGICA: Exibe um card condensado se houver muitas URLs (Evita o bug visual e travamentos)
  if (urlItems.length > 50) {
    urlPillBox.innerHTML = `
      <div style="width: 100%; text-align: center; padding: 15px 10px; color: var(--green);">
        <div style="font-size: 24px; font-weight: bold; font-family: 'Barlow Condensed', sans-serif;">
          📦 ${urlItems.length} Vídeos na Fila
        </div>
        <div style="font-size: 11px; margin-top: 5px; color: var(--muted);">
          A visualização detalhada em pills foi ocultada para não travar a tela.<br>
          Os links já estão prontos na memória para a denúncia.
        </div>
        <button type="button" id="btnLimparPillsOcultas" class="btn-clear" style="margin-top: 10px;">Limpar Fila Oculta</button>
      </div>
    `;

    // Adiciona o ouvinte para o botão de limpar, já que as pills de remover individuais não estarão lá
    const btnLimpar = document.getElementById('btnLimparPillsOcultas');
    if (btnLimpar) {
      btnLimpar.addEventListener('click', () => {
        if (confirm('Deseja apagar todas as URLs da fila oculta?')) {
          urlItems = [];
          syncUrls();
          renderUrlPills();
        }
      });
    }
    return;
  }

  // Lógica original: Exibe as pills normalmente para quantidades menores
  urlPillBox.innerHTML = urlItems
    .map(
      (url, idx) => `
    <div class="url-pill" title="${url}">
      <span class="url-pill-text">${url}</span>
      <button type="button" class="url-pill-remove" data-index="${idx}" aria-label="Remover URL">×</button>
    </div>
  `,
    )
    .join('');
}

urlPillBox.addEventListener('click', (e) => {
	const btn = e.target.closest('.url-pill-remove');
	if (!btn) return;

	const idx = Number(btn.dataset.index);
	if (Number.isNaN(idx)) return;

	urlItems.splice(idx, 1);
	syncUrls();
	renderUrlPills();
});

function updateCharCount() {
	const len = msgInput.value.length;
	charCount.textContent = `${len} / 500`;
	charCount.className =
		'char-count' + (len > 450 ? ' over' : len > 380 ? ' warn' : '');
}

msgToggle.addEventListener('click', () => {
	msgInput.value = DEFAULT_MESSAGE;
	chrome.storage.local.set({ savedMessage: DEFAULT_MESSAGE });
	updateCharCount();
});

// URL parser
function parseUrls(raw) {
	return raw
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean)
		.map((url) => {
			try {
				const u = new URL(url);
				const isYT =
					u.hostname.includes('youtube.com') && u.searchParams.get('v');
				const isShort = u.hostname === 'youtu.be' && u.pathname.length > 1;
				return isYT || isShort ? url : null;
			} catch {
				return null;
			}
		});
}

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

// History
async function saveToHistory(url, success, reason, error) {
	const { reportHistory = [] } =
		await chrome.storage.local.get('reportHistory');
	reportHistory.unshift({
		url,
		success,
		reason,
		error: error || null,
		ts: Date.now(),
	});
	if (reportHistory.length > 200) reportHistory.splice(200);
	await chrome.storage.local.set({ reportHistory });
}

function renderHistory() {
	chrome.storage.local.get('reportHistory', ({ reportHistory = [] }) => {
		if (!reportHistory.length) {
			historyList.innerHTML =
				'<div class="history-empty"><span>📭</span>Nenhuma denúncia registrada ainda.</div>';
			return;
		}
		historyList.innerHTML = reportHistory
			.map((item) => {
				const d = new Date(item.ts);
				const date =
					d.toLocaleDateString('pt-BR') +
					' ' +
					d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
				const shortUrl = item.url.replace('https://', '').replace('www.', '');
				return `<div class="history-item ${item.success ? 'ok' : 'fail'}">
        <div class="history-icon">${item.success ? '✅' : '❌'}</div>
        <div class="history-body">
          <span class="history-url" title="${item.url}">${shortUrl}</span>
          <div class="history-meta">
            <span>${date}</span>
            <span class="history-tag">${item.reason}</span>
            ${!item.success && item.error ? `<span class="history-err">${item.error.slice(0, 60)}</span>` : ''}
          </div>
        </div>
      </div>`;
			})
			.join('');
	});
}

btnClear.addEventListener('click', () => {
	if (confirm('Apagar todo o histórico de denúncias?')) {
		chrome.storage.local.set({ reportHistory: [] }, renderHistory);
	}
});

btnClearJob.addEventListener('click', () => {
  if (!confirm('Limpar toda a lista de URLs?')) return;
  urlItems = [];
  syncUrls();
  renderUrlPills();
  document.getElementById('urlInput').value = '';
});

// ============================================================================
// 1. SISTEMA DE FILA EM SEGUNDO PLANO (INTEGRAÇÃO COM O BACKGROUND)
// ============================================================================

// Sincroniza a interface visual com o estado da fila no background
function syncJobUi(job) {
  const reportStatusCard = document.getElementById('reportStatusCard');
  const badge = document.getElementById('reportStatusBadge');
  const summary = document.getElementById('reportStatusSummary');
  const current = document.getElementById('reportStatusCurrent');

  // Se não tem job rodando, esconde o painel e mostra o botão de denunciar
  if (!job || (!job.running && !job.paused && !job.cancelled && job.status !== 'Finalizado')) {
      reportStatusCard.style.display = 'none';
      btnReport.style.display = 'block';
      return;
  }

  // Se tem job, mostra o painel e esconde o botão
  reportStatusCard.style.display = 'block';
  btnReport.style.display = 'none';

  badge.textContent = job.status || 'processando';
  badge.className = 'status-badge ' + (job.paused ? 'paused' : job.cancelled ? 'error' : job.running ? 'running' : 'done');

  summary.innerHTML = `Concluídos: <strong>${job.done || 0} de ${job.total || 0}</strong><br>` +
                      `<span style="color: var(--green)">Sucesso: ${job.okCount || 0}</span> | ` +
                      `<span style="color: var(--accent)">Falhas: ${job.failCount || 0}</span>`;

  current.textContent = job.currentUrl ? `Atual: ${job.currentUrl.replace('https://www.youtube.com/watch?v=', '')}` : '';

  btnTogglePause.style.display = (job.running && !job.cancelled) ? 'block' : 'none';
  btnTogglePause.textContent = job.paused ? '▶ Retomar' : '⏸ Pausar';
  btnCancelJob.style.display = (job.running && !job.cancelled) ? 'block' : 'none';
  btnBackEditor.style.display = (!job.running || job.cancelled) ? 'block' : 'none';
}

// Escuta as mudanças do background em tempo real
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.reportJob) {
      syncJobUi(changes.reportJob.newValue);
      if (!changes.reportJob.newValue?.running) renderHistory(); // Atualiza o histórico ao terminar
  }
});

// Sincroniza ao abrir o popup
chrome.storage.local.get('reportJob', (res) => {
  syncJobUi(res.reportJob);
});

// Ações dos botões do painel de controle
btnTogglePause.addEventListener('click', () => {
  chrome.storage.local.get('reportJob', (res) => {
      if (res.reportJob) {
          const isPaused = res.reportJob.paused;
          // Inverte o estado
          chrome.storage.local.set({ reportJob: { ...res.reportJob, paused: !isPaused }});
          
          // Se estava pausado e agora vai rodar, manda o sinal pra acordar o script
          if (isPaused) {
              chrome.runtime.sendMessage({ action: 'resumeBatch' });
          }
      }
  });
});

btnCancelJob.addEventListener('click', () => {
  if(confirm('Deseja realmente cancelar o envio das denúncias?')) {
      chrome.storage.local.get('reportJob', (res) => {
          if (res.reportJob) {
              chrome.storage.local.set({ reportJob: { ...res.reportJob, cancelled: true }});
          }
      });
  }
});

btnBackEditor.addEventListener('click', () => {
  chrome.storage.local.set({ reportJob: null });
  syncJobUi(null);
});

// ENVIA AS URLs PARA A FILA INTELIGENTE DO BACKGROUND
btnReport.addEventListener('click', () => {
  const urls = parseUrls(urlItems.join('\n'));
  const valid = urls.filter(Boolean);

  if (!valid.length) {
      alert('Nenhuma URL válida do YouTube encontrada na fila.');
      return;
  }

  const reasonKey = reasonSel.value;
  const reasonData = REASON_MAP[reasonKey];
  const userComment = msgInput.value.trim();
  const jobId = 'job_' + Date.now();

  chrome.runtime.sendMessage({
      action: 'startReportBatch',
      jobId,
      urls: valid,
      reasonData,
      userComment
  });
});

// ============================================================================
// 2. EXTRATOR DE CANAIS (A nossa super ferramenta)
// ============================================================================

document.getElementById('extractBtn').addEventListener('click', () => {
  const channelUrl = document.getElementById('channelUrl').value.trim();
  const statusDiv = document.getElementById('extractStatus');
  
  if (!channelUrl.includes('youtube.com/')) {
    statusDiv.textContent = 'Por favor, insira uma URL de canal válida.';
    return;
  }

  statusDiv.textContent = 'Extraindo vídeos em segundo plano... Pode demorar, não feche o navegador.';
  document.getElementById('extractBtn').disabled = true;

  chrome.runtime.sendMessage({ action: 'extractChannelVideos', url: channelUrl });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const statusDiv = document.getElementById('extractStatus');

  if (request.action === 'extractionComplete') {
    document.getElementById('extractBtn').disabled = false;
    
    const urlsExtraidas = request.videos.map(id => `https://www.youtube.com/watch?v=${id}`);
    
    // Filtro de duplicadas usando Set
    const tamanhoAntes = urlItems.length;
    urlItems = [...new Set([...urlItems, ...urlsExtraidas])];
    const adicionadas = urlItems.length - tamanhoAntes;
    const duplicadas = urlsExtraidas.length - adicionadas;

    statusDiv.textContent = `${request.videos.length} extraídos: ${adicionadas} novos adicionados (${duplicadas} ignorados).`;
    
    syncUrls();
    renderUrlPills();
    document.getElementById('urlInput').value = '';
    chrome.storage.local.remove('lastExtractedVideos');
  }

  if (request.action === 'extractionError') {
    document.getElementById('extractBtn').disabled = false;
    statusDiv.textContent = `Erro: ${request.error}`;
  }
});

chrome.storage.local.get(['lastExtractedVideos'], (result) => {
  if (result.lastExtractedVideos && result.lastExtractedVideos.length > 0) {
    const statusDiv = document.getElementById('extractStatus');
    const urlsExtraidas = result.lastExtractedVideos.map(id => `https://www.youtube.com/watch?v=${id}`);
    
    urlItems = [...new Set([...urlItems, ...urlsExtraidas])];
    syncUrls();
    renderUrlPills();
    document.getElementById('urlInput').value = '';
    
    if (statusDiv) {
      statusDiv.textContent = `${result.lastExtractedVideos.length} vídeos recuperados (duplicatas removidas)!`;
    }
    chrome.storage.local.remove('lastExtractedVideos');
  }
});