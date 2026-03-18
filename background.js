// FELCA Reporter — background.js (v17 — usa /flag/flag com flagAction, suporte a subOpções)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'reportVideo') {
    handleReport(msg.url, msg.reasonData, msg.userComment)
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }