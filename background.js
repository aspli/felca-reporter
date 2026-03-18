// FELCA Reporter — background.js (v15 — params gerado do videoId, sem ytInitialData)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'reportVideo') {
    handleReport(msg.url, msg.reasonData, msg.userComment)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.action === 'startReportBatch') {
    handleReportBatch(msg.jobId, msg.urls, msg.reasonData, msg.userComment)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleReport(url, reasonData, userComment) {
  const videoId = extractVideoId(url);
  if (!videoId) return { success: false, error: 'URL inválida' };

  let tab = null;
  try {
    tab = await openTab(`https://www.youtube.com/watch?v=${videoId}`);
    await sleep(5000);

    // Confirma que a aba carregou o vídeo certo
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

async function handleReportBatch(jobId, urls, reasonData, userComment) {
  if (!Array.isArray(urls) || !urls.length) {
    return { success: false, error: 'Nenhuma URL para processar' };
  }

  await setReportJobState(jobId, {
    running: true,
    paused: false,
    cancelled: false,
    total: urls.length,
    done: 0,
    okCount: 0,
    failCount: 0,
    currentUrl: '',
    status: 'Iniciando...'
  });

  let okCount = 0;
  let failCount = 0;

  for (let index = 0; index < urls.length; index++) {
    const gate = await waitForBatchGate(jobId);
    if (gate === 'cancelled') {
      const cancelledJob = await setReportJobState(jobId, {
        running: false,
        paused: false,
        cancelled: true,
        status: 'Cancelado',
        currentUrl: '',
        done: index,
        okCount,
        failCount,
        finishedAt: Date.now()
      });
      return {
        success: false,
        cancelled: true,
        jobId,
        total: urls.length,
        okCount,
        failCount,
        reportJob: cancelledJob
      };
    }

    const url = urls[index];
    const step = index + 1;

    await setReportJobState(jobId, {
      currentUrl: url,
      status: `Processando ${step} de ${urls.length}...`,
      done: index,
      okCount,
      failCount,
      running: true,
      cancelled: false
    });

    const result = await handleReport(url, reasonData, userComment);
    if (result.success) okCount++;
    else failCount++;

    await saveToHistory(url, !!result.success, reasonData.label, result.error);

    await setReportJobState(jobId, {
      currentUrl: url,
      status: result.success ? 'Denúncia enviada' : 'Falha na denúncia',
      done: step,
      okCount,
      failCount,
      running: true,
      cancelled: false,
      lastError: result.success ? null : result.error,
      lastMessage: result.success ? 'Concluído com sucesso' : result.error
    });
  }

  const finalJob = await setReportJobState(jobId, {
    running: false,
    currentUrl: '',
    status: 'Finalizado',
    done: urls.length,
    okCount,
    failCount,
    finishedAt: Date.now()
  });

  return {
    success: true,
    jobId,
    total: urls.length,
    okCount,
    failCount,
    reportJob: finalJob
  };
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
  console.log(`🛡️ FELCA v15 — denunciando: ${expectedVideoId}`);

  // Validação: garante que esta aba é o vídeo certo
  const pageVideoId = new URLSearchParams(window.location.search).get('v');
  if (pageVideoId !== expectedVideoId) {
    return { success: false, error: `Página errada! Esperado: ${expectedVideoId}, Atual: ${pageVideoId}` };
  }

  const REASON_KEYWORDS = {
    violent:     ['violento', 'repulsivo', 'violent', 'graphic'],
    sexual:      ['sexual', 'nudez', 'nude'],
    child_abuse: ['infantil', 'child', 'criança', 'menor', 'abuse', 'exploração'],
    harmful:     ['perigoso', 'nocivo', 'harmful', 'dangerous', 'automutilação']
  };
  const keywords = REASON_KEYWORDS[reasonKey] || REASON_KEYWORDS.violent;

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

    // ── GERA O PARAMS A PARTIR DO VIDEOID ────────────────────────────────
    // O params é um protobuf binário codificado em base64.
    // Estrutura: field 2 (tag 0x12) + comprimento + videoId UTF-8 + sufixo fixo.
    // Sufixo fixo confirmado por engenharia reversa dos params reais do YouTube.
    const buildParams = (videoId) => {
      const idBytes = new TextEncoder().encode(videoId);
      const suffix  = new Uint8Array([0x40,0x01,0x58,0x00,0x70,0x01,0x78,0x01,0xd8,0x01,0x00,0xe8,0x01,0x00]);
      const buf     = new Uint8Array(2 + idBytes.length + suffix.length);
      buf[0] = 0x12;                          // field 2, wire type 2
      buf[1] = idBytes.length;               // comprimento do videoId
      buf.set(idBytes, 2);                   // bytes do videoId
      buf.set(suffix, 2 + idBytes.length);   // sufixo fixo
      return btoa(String.fromCharCode(...buf));
    };

    const reportParams = buildParams(expectedVideoId);
    console.log(`📌 [${expectedVideoId}] Params gerado: ${reportParams}`);

    // ── COLETA DE TOKENS ─────────────────────────────────────────────────
    const collectTokens = (o, res = { flow: [], feedback: [] }, depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 25) return res;
      if (Array.isArray(o)) { o.forEach(v => collectTokens(v, res, depth + 1)); return res; }

      if (o.submitActionToken) {
        const label = (
          o.title?.runs?.[0]?.text ||
          o.text?.runs?.[0]?.text  ||
          o.label || ''
        ).toLowerCase();
        res.flow.push({ token: o.submitActionToken, label });
      }
      if (o.feedbackEndpoint?.feedbackToken) res.feedback.push(o.feedbackEndpoint.feedbackToken);
      else if (typeof o.feedbackToken === 'string') res.feedback.push(o.feedbackToken);
      else if (Array.isArray(o.feedbackTokens))     res.feedback.push(...o.feedbackTokens);

      Object.values(o).forEach(v => collectTokens(v, res, depth + 1));
      return res;
    };

    // ── PASSO 1: BUSCAR FORMULÁRIO ────────────────────────────────────────
    console.log(`🚀 [${expectedVideoId}] Buscando formulário...`);
    const formResp = await fetch(`/youtubei/v1/flag/get_form?key=${apiKey}&prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ context, params: reportParams })
    });

    if (!formResp.ok) {
      const errText = await formResp.text().catch(() => '');
      console.error(`❌ Formulário HTTP ${formResp.status}:`, errText.slice(0, 300));
      return { success: false, error: `Erro no formulário: HTTP ${formResp.status}` };
    }

    const formJson = await formResp.json();
    const tokens   = collectTokens(formJson);
    console.log(`🎫 [${expectedVideoId}] Tokens:`, tokens);

    let chosenToken        = null;
    let finalFeedbackToken = tokens.feedback[0] || null;

    if (!finalFeedbackToken && tokens.flow.length > 0) {
      chosenToken = tokens.flow.find(t => keywords.some(kw => t.label.includes(kw)))?.token
                   ?? tokens.flow[0].token;
      console.log(`🎯 [${expectedVideoId}] Motivo: "${chosenToken}"`);
    }

    if (!chosenToken && !finalFeedbackToken) {
      return { success: false, error: 'Formulário sem opções de denúncia.' };
    }

    // ── PASSO 2: SELECIONAR MOTIVO ────────────────────────────────────────
    let commentToken = null;
    if (chosenToken && !finalFeedbackToken) {
      console.log(`➡️ [${expectedVideoId}] Selecionando motivo...`);
      const flow1Resp = await fetch(`/youtubei/v1/flow?key=${apiKey}&prettyPrint=false`, {
        method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({
          context,
          subject:           { videoId: expectedVideoId },
          submitActionToken: chosenToken
        })
      });
      if (flow1Resp.ok) {
        const f1 = collectTokens(await flow1Resp.json());
        console.log(`🎫 [${expectedVideoId}] Tokens flow1:`, f1);
        if (f1.feedback.length > 0) finalFeedbackToken = f1.feedback[0];
        else commentToken = f1.flow.find(t => t.token !== chosenToken)?.token ?? f1.flow[0]?.token ?? null;
      }
    }

    // ── PASSO 3: COMENTÁRIO ───────────────────────────────────────────────
    if (commentToken && !finalFeedbackToken) {
      console.log(`📝 [${expectedVideoId}] Enviando comentário...`);
      const flow2Resp = await fetch(`/youtubei/v1/flow?key=${apiKey}&prettyPrint=false`, {
        method: 'POST', credentials: 'include', headers,
        body: JSON.stringify({
          context,
          subject:           { videoId: expectedVideoId },
          submitActionToken: commentToken,
          userComment
        })
      });
      if (flow2Resp.ok) {
        const f2 = collectTokens(await flow2Resp.json());
        if (f2.feedback.length > 0) finalFeedbackToken = f2.feedback[0];
      }
    }

    if (!finalFeedbackToken) {
      return { success: false, error: 'Token de confirmação não obtido.' };
    }

    // ── PASSO 4: ENVIO FINAL ──────────────────────────────────────────────
    console.log(`🎯 [${expectedVideoId}] Enviando denúncia final...`);
    const feedbackBody = {
      context,
      feedbackTokens: [finalFeedbackToken],
      isFlagAction:   true,
    };
    if (userComment) feedbackBody.userComment = userComment;

    const feedbackResp = await fetch(`/youtubei/v1/feedback?key=${apiKey}&prettyPrint=false`, {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify(feedbackBody)
    });

    if (feedbackResp.ok || feedbackResp.status === 204) {
      console.log(`✅ [${expectedVideoId}] Denúncia enviada!`);
      return { success: true };
    }

    const errBody = await feedbackResp.text().catch(() => '');
    return { success: false, error: `Erro no envio final: HTTP ${feedbackResp.status}` };

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

// Listener filtrado por tabId — sem condição de corrida
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
