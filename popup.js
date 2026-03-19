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
  urlInput.value = '';
});

btnTogglePause.addEventListener('click', () => {});
btnCancelJob.addEventListener('click', () => {});
btnBackEditor.addEventListener('click', () => {});

// Main
btnReport.addEventListener('click', async () => {
	const urls = parseUrls(urlItems.join('\n'));
	const valid = urls.filter(Boolean);
	const invalid = urls.filter((u) => u === null).length;

	if (!valid.length) {
		alert(
			'Nenhuma URL válida do YouTube encontrada.\n\nFormatos aceitos:\nhttps://www.youtube.com/watch?v=XXXXX\nhttps://youtu.be/XXXXX',
		);
		return;
	}

	const reasonKey = reasonSel.value;
	const reasonData = REASON_MAP[reasonKey];
	const userComment = msgInput.value.trim();

	okCount = 0;
	failCount = 0;
	done = 0;
	total = valid.length;
	logList.innerHTML = '';
	progressWrap.classList.add('show');
	summary.classList.remove('show');
	btnReport.disabled = true;
	btnReport.classList.add('running');
	btnReport.textContent = `⏳ Processando 0 / ${total}...`;
	progressFill.style.width = '0%';

	if (invalid)
		addLog('error', `${invalid} linha(s) ignorada(s) — URL inválida`, '');

	for (const url of valid) {
		addLog('pending', 'Enviando denúncia...', url);

		let result;
		try {
			result = await new Promise((resolve) => {
				chrome.runtime.sendMessage(
					{ action: 'reportVideo', url, reasonData, userComment },
					resolve,
				);
			});
			if (chrome.runtime.lastError)
				result = { success: false, error: chrome.runtime.lastError.message };
		} catch (e) {
			result = { success: false, error: e.message };
		}

		removePending();
		done++;

		if (result?.success) {
			okCount++;
			addLog('success', '✓ Denúncia enviada com sucesso', url);
		} else {
			failCount++;
			addLog('error', `✗ ${result?.error || 'erro desconhecido'}`, url);
		}

		await saveToHistory(
			url,
			!!result?.success,
			reasonData.label,
			result?.error,
		);
		progressFill.style.width = Math.round((done / total) * 100) + '%';
		btnReport.textContent = `⏳ Processando ${done} / ${total}...`;
		await sleep(1200);
	}

	btnReport.disabled = false;
	btnReport.classList.remove('running');
	btnReport.textContent = '🚨 Denunciar todos os vídeos';
	countOk.textContent = okCount;
	countFail.textContent = failCount;
	summary.classList.add('show');
});

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

// 1. O que acontece quando clica no botão
document.getElementById('extractBtn').addEventListener('click', () => {
  const channelUrl = document.getElementById('channelUrl').value.trim();
  const statusDiv = document.getElementById('extractStatus');
  
  if (!channelUrl.includes('youtube.com/')) {
    statusDiv.textContent = 'Por favor, insira uma URL de canal válida.';
    return;
  }

  statusDiv.textContent = 'Extraindo vídeos em segundo plano... Pode demorar, não feche o navegador.';
  document.getElementById('extractBtn').disabled = true;

  // Apenas envia a ordem, não espera a resposta aqui!
  chrome.runtime.sendMessage({ action: 'extractChannelVideos', url: channelUrl });
});

// 2. O ouvinte que fica esperando o background avisar que terminou
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const statusDiv = document.getElementById('extractStatus');
  const urlsTextarea = document.getElementById('urlInput');

  if (request.action === 'extractionComplete') {
    document.getElementById('extractBtn').disabled = false;
    statusDiv.textContent = `${request.videos.length} vídeos extraídos com sucesso!`;
    
    const urls = request.videos.map(id => `https://www.youtube.com/watch?v=${id}`);
    const currentText = urlsTextarea.value.trim();
    urlsTextarea.value = currentText ? currentText + '\n' + urls.join('\n') : urls.join('\n');
    
    // Limpa o backup
    chrome.storage.local.remove('lastExtractedVideos');
  }

  if (request.action === 'extractionError') {
    document.getElementById('extractBtn').disabled = false;
    statusDiv.textContent = `Erro: ${request.error}`;
  }
});

// 3. Recupera caso o usuário feche e abra o popup no meio do processo
chrome.storage.local.get(['lastExtractedVideos'], (result) => {
  if (result.lastExtractedVideos && result.lastExtractedVideos.length > 0) {
    const urlsTextarea = document.getElementById('urlInput');
    const statusDiv = document.getElementById('extractStatus');
    
    const urls = result.lastExtractedVideos.map(id => `https://www.youtube.com/watch?v=${id}`);
    const currentText = urlsTextarea.value.trim();
    urlsTextarea.value = currentText ? currentText + '\n' + urls.join('\n') : urls.join('\n');
    
    if (statusDiv) {
      statusDiv.textContent = `${result.lastExtractedVideos.length} vídeos recuperados da extração anterior!`;
    }
    
    chrome.storage.local.remove('lastExtractedVideos');
  }
});