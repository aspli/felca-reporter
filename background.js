// FELCA Reporter — background.js (v17 — usa /flag/flag com flagAction, suporte a subOpções)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  
  // 1. Denúncia individual (Ainda precisa de resposta assíncrona)
  if (msg.action === 'reportVideo') {
    handleReport(msg.url, msg.reasonData, msg.userComment)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // Mantém a porta aberta apenas para esta função
  }

  // 2. Extração de Canal
  if (msg.action === 'extractChannelVideos') {
    // Inicia o processo em background solto, sem prender o popup
    extractViaBackgroundTab(msg.url)
      .then(videos => {
        chrome.storage.local.set({ lastExtractedVideos: videos });
        chrome.runtime.sendMessage({ 
          action: 'extractionComplete', 
          videos: videos 
        }).catch(() => {});
      })
      .catch(error => {
        chrome.runtime.sendMessage({ 
          action: 'extractionError', 
          error: error.message 
        }).catch(() => {});
      });

    sendResponse({ status: "started" }); 
    return false; // Diz ao Chrome para fechar a porta de comunicação na hora
  }

  // 3. Fila de Denúncias em Lote
  if (msg.action === 'startReportBatch') {
    // Inicia a fila gigante no background sem prender o popup
    handleReportBatch(msg.jobId, msg.urls, msg.reasonData, msg.userComment)
      .catch(err => console.error("Erro no batch:", err));
      
    sendResponse({ status: "started" });
    return false; // Fecha a porta de comunicação na hora
  }

  if (msg.action === 'resumeBatch') {
    chrome.storage.local.get('reportJob', (res) => {
      if (res.reportJob && !res.reportJob.cancelled) {
        handleReportBatch(res.reportJob.jobId, res.reportJob.urls, res.reportJob.reasonData, res.reportJob.userComment, res.reportJob.done || 0);
      }
    });
    sendResponse({ status: "resuming" });
    return false;
  }

});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'respawnBatch') {
    chrome.storage.local.get('reportJob', (res) => {
      if (res.reportJob && res.reportJob.running && !res.reportJob.paused && !res.reportJob.cancelled) {
        console.log("⏰ Alarme tocou! Retomando a fila do vídeo: " + res.reportJob.done);
        handleReportBatch(res.reportJob.jobId, res.reportJob.urls, res.reportJob.reasonData, res.reportJob.userComment, res.reportJob.done || 0);
      }
    });
  }
});

async function handleReport(url, reasonData, userComment) {
  const videoId = extractVideoId(url);
  if (!videoId) return { success: false, error: 'URL inválida' };

  let tab = null;
  try {
    tab = await openTab(`https://www.youtube.com/watch?v=${videoId}`);
    await sleep(5000);

    const tabInfo = await chrome.tabs.get(tab.id);
    const tabVideoId = extractVideoId(tabInfo.url);
    if (tabVideoId !== videoId) {
      return { success: false, error: `Aba errada (esperado: ${videoId}, carregado: ${tabVideoId})` };
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: runReportFlow,
      args: [videoId, reasonData.key, userComment || '']
    });

    return results?.[0]?.result || { success: false, error: 'Sem retorno do script' };
  } finally {
    if (tab) {
      await sleep(1000);
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

async function handleReportBatch(jobId, urls, reasonData, userComment, startIndex = 0) {
  if (!Array.isArray(urls) || !urls.length) {
    return { success: false, error: 'Nenhuma URL para processar' };
  }

  // 1. Agora nós salvamos a lista 'urls' inteira no banco para evitar amnésia
  await setReportJobState(jobId, {
    urls: urls, 
    reasonData: reasonData,
    userComment: userComment,
    running: true,
    paused: false,
    cancelled: false,
    total: urls.length
  });

  const { reportJob } = await chrome.storage.local.get('reportJob');
  let okCount = reportJob?.okCount || 0;
  let failCount = reportJob?.failCount || 0;
  
  // Marca a hora que o script acordou
  const startTime = Date.now();

  for (let index = startIndex; index < urls.length; index++) {
    
    // 🚨 O PULO DO GATO: Se passou 4 minutos (240.000 ms), ele agenda o renascimento e desliga graciosamente.
    if (Date.now() - startTime > 240000) {
      console.log("⏱️ Limite de tempo do Chrome próximo. Pausando e agendando auto-respawn...");
      chrome.alarms.create('respawnBatch', { delayInMinutes: 0.1 }); // Acorda em ~6 segundos
      return { success: true, status: 'respawning' };
    }

    const gate = await waitForBatchGate(jobId);
    if (gate === 'cancelled') {
      const cancelledJob = await setReportJobState(jobId, {
        running: false, paused: false, cancelled: true, status: 'Cancelado',
        currentUrl: '', done: index, okCount, failCount, finishedAt: Date.now()
      });
      return { success: false, cancelled: true, jobId, total: urls.length, okCount, failCount, reportJob: cancelledJob };
    }

    const url = urls[index];
    const step = index + 1;

    await setReportJobState(jobId, {
      currentUrl: url, status: `Processando ${step} de ${urls.length}...`,
      done: index, okCount, failCount, running: true, cancelled: false
    });

    const result = await handleReport(url, reasonData, userComment);
    if (result.success) okCount++;
    else failCount++;

    await saveToHistory(url, !!result.success, reasonData.label, result.error);

    await setReportJobState(jobId, {
      currentUrl: url, status: result.success ? 'Denúncia enviada' : 'Falha na denúncia',
      done: step, okCount, failCount, running: true, cancelled: false,
      lastError: result.success ? null : result.error, lastMessage: result.success ? 'Concluído com sucesso' : result.error
    });

    // O nosso delay humanizado continua aqui
    await randomSleep(20000, 35000); 
  }

  const finalJob = await setReportJobState(jobId, {
    running: false, currentUrl: '', status: 'Finalizado',
    done: urls.length, okCount, failCount, finishedAt: Date.now()
  });

  return { success: true, jobId, total: urls.length, okCount, failCount, reportJob: finalJob };
}

async function waitForBatchGate(jobId) {
  for (;;) {
    const { reportJob = null } = await chrome.storage.local.get('reportJob');
    if (!reportJob || reportJob.jobId !== jobId) return 'cancelled';
    if (reportJob.cancelled) return 'cancelled';
    if (!reportJob.paused) return 'continue';

    await setReportJobState(jobId, {
      running: true,
      paused: true,
      cancelled: false,
      status: 'Pausado'
    });
    await sleep(500);
  }
}

// ─── Roda DENTRO da aba do YouTube ───────────────────────────────────────
async function runReportFlow(expectedVideoId, reasonKey, userComment) {
  console.log(`🛡️ FELCA v17 — denunciando: ${expectedVideoId}, motivo: ${reasonKey}`);

  const pageVideoId = new URLSearchParams(window.location.search).get('v');
  if (pageVideoId !== expectedVideoId) {
    return { success: false, error: `Página errada! Esperado: ${expectedVideoId}, Atual: ${pageVideoId}` };
  }

  // Normaliza string removendo acentos
  const norm = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  // Keywords para escolher o item principal E a subopção (quando existir).
  // Estrutura: { main: [...], sub: [...] }
  // "sub" é usado para escolher dentro das subopções do item principal escolhido.
  // Se não houver "sub", pega a primeira subopção válida (que tenha flagAction).
  const REASON_KEYWORDS = {
    violent:     { main: ['violento', 'repulsivo'],        sub: [] },
    sexual:      { main: ['sexual'],                       sub: ['explicita', 'nudez', 'sugestivo'] },
    child_abuse: { main: ['abuso infantil', 'infantil'],   sub: [] },
    harmful:     { main: ['perigosos', 'nocivos'],         sub: [] },
    hateful:     { main: ['odio', 'abusivo', 'incitacao'], sub: [] },
    harassment:  { main: ['assedio', 'bullying'],          sub: [] },
    spam:        { main: ['spam', 'enganoso'],             sub: [] },
    terrorism:   { main: ['terrorismo'],                   sub: [] },
    misinfo:     { main: ['desinformacao'],                sub: [] },
    legal:       { main: ['juridico'],                     sub: [] },
    captions:    { main: ['legendas'],                     sub: [] },
  };

  const reasonCfg  = REASON_KEYWORDS[reasonKey] || REASON_KEYWORDS.violent;
  const mainKws    = reasonCfg.main;
  const subKws     = reasonCfg.sub;

  // Extrai flagAction de um renderer (pode estar em submitEndpoint.flagEndpoint.flagAction)
  const getFlagAction = (r) => {
    const fa = r?.submitEndpoint?.flagEndpoint?.flagAction;
    return fa ? decodeURIComponent(fa) : null;
  };

  try {
    // ── CONFIGURAÇÕES ────────────────────────────────────────────────────
    const cfg           = window.ytcfg?.data_ || {};
    const apiKey        = cfg.INNERTUBE_API_KEY;
    const clientVersion = cfg.INNERTUBE_CLIENT_VERSION || '2.20260317.05.00';
    const visitorData   = cfg.VISITOR_DATA || '';
    const sessionIndex  = cfg.SESSION_INDEX !== undefined ? String(cfg.SESSION_INDEX) : '0';
    const pageId        = cfg.DELEGATED_SESSION_ID || '';

    if (!apiKey) return { success: false, error: 'API key não encontrada — faça login no YouTube' };

    // ── AUTENTICAÇÃO ─────────────────────────────────────────────────────
    const getCookie = (name) => {
      const v = `; ${document.cookie}`;
      const p = v.split(`; ${name}=`);
      return p.length === 2 ? decodeURIComponent(p.pop().split(';').shift()) : '';
    };
    const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID');
    if (!sapisid) return { success: false, error: 'Sessão não encontrada — faça login no YouTube' };

    const ts     = Math.floor(Date.now() / 1000);
    const origin = 'https://www.youtube.com';
    const sha1   = async (str) => {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    };
    const hash = await sha1(`${ts} ${sapisid} ${origin}`);

    const headers = {
      'Content-Type':             'application/json',
      'Authorization':            `SAPISIDHASH ${ts}_${hash}`,
      'X-Origin':                 origin,
      'X-Youtube-Client-Name':    '1',
      'X-Youtube-Client-Version': clientVersion,
      'X-Goog-AuthUser':          sessionIndex,
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
    if (pageId)      headers['X-Goog-PageId']     = pageId;

    const context = {
      client: {
        clientName:       'WEB',
        clientVersion:    clientVersion,
        hl:               'pt',
        gl:               'BR',
        userAgent:        navigator.userAgent,
        timeZone:         Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo',
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      }
    };

    // ── PARAMS (sem sufixo = "Denunciar vídeo" com 11 opções) ────────────
    const buildParams = (videoId) => {
      const idBytes = new TextEncoder().encode(videoId);
      const buf     = new Uint8Array(2 + idBytes.length);
      buf[0] = 0x12;
      buf[1] = idBytes.length;
      buf.set(idBytes, 2);
      return btoa(String.fromCharCode(...buf));
    };

    // ── PASSO 1: GET_FORM ─────────────────────────────────────────────────
    console.log(`🚀 [${expectedVideoId}] Buscando formulário...`);
    const formResp = await fetch(`/youtubei/v1/flag/get_form?key=${apiKey}&prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ context, params: buildParams(expectedVideoId) })
    });

    if (!formResp.ok) {
      const errText = await formResp.text().catch(() => '');
      return { success: false, error: `Erro no formulário: HTTP ${formResp.status} — ${errText.slice(0, 200)}` };
    }

    const formJson = await formResp.json();
    const items    = formJson
      ?.actions?.[0]
      ?.openPopupAction?.popup
      ?.reportFormModalRenderer
      ?.optionsSupportedRenderers?.optionsRenderer?.items || [];

    if (items.length === 0) {
      return { success: false, error: 'Formulário sem opções de denúncia.' };
    }

    // ── ESCOLHE ITEM PRINCIPAL ────────────────────────────────────────────
    const mainItem = items
      .map(i => i.optionSelectableItemRenderer || i)
      .find(r => mainKws.some(kw => norm(r.text?.simpleText || '').includes(kw)))
      ?? (items[0].optionSelectableItemRenderer || items[0]);

    console.log(`🎯 [${expectedVideoId}] Item principal: "${mainItem.text?.simpleText}"`);

    // ── RESOLVE flagAction: direto ou via subopção ────────────────────────
    let flagAction = getFlagAction(mainItem);

    if (!flagAction && mainItem.subOptions?.length) {
      // Item tem subopções — escolhe pela keyword "sub", senão pega a primeira válida
      const subRenderers = mainItem.subOptions
        .map(s => s.optionSelectableItemRenderer || s)
        .filter(r => getFlagAction(r)); // só as que têm flagAction

      const chosen = subKws.length
        ? subRenderers.find(r => subKws.some(kw => norm(r.text?.simpleText || '').includes(kw)))
        : null;

      const subItem = chosen ?? subRenderers[0];
      if (subItem) {
        flagAction = getFlagAction(subItem);
        console.log(`📌 [${expectedVideoId}] Subopção escolhida: "${subItem.text?.simpleText}"`);
      }
    }

    if (!flagAction) {
      return { success: false, error: `flagAction não encontrado para "${mainItem.text?.simpleText}"` };
    }

    console.log(`🔑 [${expectedVideoId}] flagAction: ${flagAction.slice(0, 40)}...`);

    // ── PASSO 2: ENVIO via /flag/flag ─────────────────────────────────────
    console.log(`🚀 [${expectedVideoId}] Enviando denúncia...`);
    const flagResp = await fetch(`/youtubei/v1/flag/flag?key=${apiKey}&prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({
        context,
        action:      flagAction,
        userComment: userComment || '',
      })
    });

    if (flagResp.ok || flagResp.status === 204) {
      console.log(`✅ [${expectedVideoId}] Denúncia enviada com sucesso!`);
      return { success: true };
    }

    const errBody = await flagResp.text().catch(() => '');
    return { success: false, error: `Erro no envio: HTTP ${flagResp.status} — ${errBody.slice(0, 200)}` };

  } catch (err) {
    console.error(`❌ [${expectedVideoId}] Exceção:`, err);
    return { success: false, error: err.message };
  }
}

async function setReportJobState(jobId, patch) {
  const { reportJob = {} } = await chrome.storage.local.get('reportJob');
  const next = {
    ...reportJob,
    jobId,
    ...patch,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ reportJob: next });
  return next;
}

async function saveToHistory(url, success, reason, error) {
  const { reportHistory = [] } = await chrome.storage.local.get('reportHistory');
  reportHistory.unshift({ url, success, reason, error: error || null, ts: Date.now() });
  if (reportHistory.length > 200) reportHistory.splice(200);
  await chrome.storage.local.set({ reportHistory });
}

// ─── Utilitários ──────────────────────────────────────────────────────────

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be')          return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
  } catch (_) {}
  return null;
}

function openTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const tabId = tab.id;
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }, 15000);
      function listener(id, changeInfo, updatedTab) {
        if (id !== tabId) return;
        if (changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(updatedTab);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function extractViaBackgroundTab(channelUrl) {
  let url = channelUrl.split('?')[0];
  if (!url.endsWith('/videos')) {
    url += url.endsWith('/') ? 'videos' : '/videos';
  }

  const tab = await chrome.tabs.create({ url, active: false });

  await new Promise((resolve) => {
    chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });

  try {
    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN", 
      func: extractVideosInPageContext
    });

    chrome.tabs.remove(tab.id);

    const result = injectionResults[0].result;
    if (result.error) throw new Error(result.error);
    
    return result.videos;

  } catch (err) {
    chrome.tabs.remove(tab.id); 
    throw err;
  }
}

// ─── Roda DENTRO da aba do YouTube para extrair vídeos ───────────────────
async function extractVideosInPageContext() {
  try {
    const ytInitialData = window.ytInitialData;
    const apiKey = window.ytcfg.get('INNERTUBE_API_KEY');
    const clientName = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_NAME');
    const clientVersion = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION');
    const visitorData = window.ytcfg.get('VISITOR_DATA') || window.ytcfg.get('VISITOR_INFO1_LIVE');

    if (!ytInitialData || !apiKey) {
      return { error: 'Não foi possível ler os dados da página do canal.' };
    }

    let videoIds = [];
    let continuationToken = null;

    const tabs = ytInitialData.contents?.twoColumnBrowseResultsRenderer?.tabs;
    if (!tabs) return { error: 'Estrutura do canal não reconhecida.' };

    let videosTab = tabs.find(tab => tab.tabRenderer?.title === 'Vídeos' || tab.tabRenderer?.title === 'Videos') 
                 || tabs.find(tab => tab.tabRenderer?.content?.richGridRenderer);

    if (!videosTab || !videosTab.tabRenderer?.content) return { error: 'Nenhum vídeo encontrado.' };

    const contents = videosTab.tabRenderer.content.richGridRenderer.contents;

    const processContents = (items) => {
      for (const item of items) {
        if (item.richItemRenderer && item.richItemRenderer.content.videoRenderer) {
          videoIds.push(item.richItemRenderer.content.videoRenderer.videoId);
        } else if (item.continuationItemRenderer) {
          continuationToken = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
        }
      }
    };

    processContents(contents);

    while (continuationToken) {
      const payload = {
        context: {
          client: {
            clientName: clientName,
            clientVersion: clientVersion,
            visitorData: visitorData,
            hl: "pt-BR",
            gl: "BR"
          }
        },
        continuation: continuationToken
      };

      const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': String(clientName),
          'X-YouTube-Client-Version': clientVersion
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      continuationToken = null; 

      if (data && data.onResponseReceivedActions) {
        const appendActions = data.onResponseReceivedActions.find(
          action => action.appendContinuationItemsAction
        );
        
        if (appendActions && appendActions.appendContinuationItemsAction.continuationItems) {
          processContents(appendActions.appendContinuationItemsAction.continuationItems);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 500)); 
    }

    return { videos: videoIds };
  } catch (err) {
    return { error: err.message };
  }
}

// ATENÇÃO: Esta função roda injetada DENTRO da página do YouTube. 
// O escopo dela é isolado, então ela tem acesso ao window e ytcfg reais da página.
async function extractVideosInPageContext() {
  try {
    // Usamos as variáveis globais do próprio YouTube para garantir autorização
    const ytInitialData = window.ytInitialData;
    const apiKey = window.ytcfg.get('INNERTUBE_API_KEY');
    const clientName = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_NAME');
    const clientVersion = window.ytcfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION');
    const visitorData = window.ytcfg.get('VISITOR_DATA') || window.ytcfg.get('VISITOR_INFO1_LIVE');

    if (!ytInitialData || !apiKey) {
      return { error: 'Não foi possível ler os dados da página do canal.' };
    }

    let videoIds = [];
    let continuationToken = null;

    const tabs = ytInitialData.contents?.twoColumnBrowseResultsRenderer?.tabs;
    if (!tabs) return { error: 'Estrutura do canal não reconhecida.' };

    let videosTab = tabs.find(tab => tab.tabRenderer?.title === 'Vídeos' || tab.tabRenderer?.title === 'Videos') 
                 || tabs.find(tab => tab.tabRenderer?.content?.richGridRenderer);

    if (!videosTab || !videosTab.tabRenderer?.content) return { error: 'Nenhum vídeo encontrado.' };

    const contents = videosTab.tabRenderer.content.richGridRenderer.contents;

    const processContents = (items) => {
      for (const item of items) {
        if (item.richItemRenderer && item.richItemRenderer.content.videoRenderer) {
          videoIds.push(item.richItemRenderer.content.videoRenderer.videoId);
        } else if (item.continuationItemRenderer) {
          continuationToken = item.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
        }
      }
    };

    processContents(contents);

    // Paginação real e contínua
    while (continuationToken) {
      const payload = {
        context: {
          client: {
            clientName: clientName,
            clientVersion: clientVersion,
            visitorData: visitorData,
            hl: "pt-BR",
            gl: "BR"
          }
        },
        continuation: continuationToken
      };

      // O fetch agora acontece do domínio www.youtube.com, burlando completamente os bloqueios
      const res = await fetch(`https://www.youtube.com/youtubei/v1/browse?key=${apiKey}&prettyPrint=false`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': String(clientName),
          'X-YouTube-Client-Version': clientVersion
        },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      continuationToken = null; // Reseta por precaução

      if (data && data.onResponseReceivedActions) {
        const appendActions = data.onResponseReceivedActions.find(
          action => action.appendContinuationItemsAction
        );
        
        if (appendActions && appendActions.appendContinuationItemsAction.continuationItems) {
          processContents(appendActions.appendContinuationItemsAction.continuationItems);
        }
      }
      
      await new Promise(resolve => setTimeout(resolve, 500)); // Delay sutil
    }

    return { videos: videoIds };
  } catch (err) {
    return { error: err.message };
  }
}

// Espera um tempo aleatório entre min e max milissegundos
function randomSleep(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  console.log(`⏳ Humanização: Aguardando ${(ms / 1000).toFixed(1)} segundos...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }