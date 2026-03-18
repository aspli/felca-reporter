// FELCA Reporter — background.js
//
// Fluxo confirmado via DevTools (dois flow calls):
//   1. get_panel          → obtém tokens por categoria
//   2. flow (1º call)     → seleciona o motivo — SEM texto
//   3. flow (2º call)     → tela de comentário — COM o texto do usuário
//   4. feedback           → envia a denúncia final

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
    await sleep(4000);

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runReportFlow,
      args: [videoId, reasonData.key, userComment || '']
    });

    return results?.[0]?.result || { success: false, error: 'Sem retorno do script' };
  } finally {
    if (tab) {
      await sleep(500);
      try { await chrome.tabs.remove(tab.id); } catch (_) {}
    }
  }
}

async function runReportFlow(videoId, reasonKey, userComment) {
  const REASON_KEYWORDS = {
    violent:     ['violento', 'repulsivo', 'violent'],
    sexual:      ['sexual'],
    child_abuse: ['infantil', 'child', 'criança', 'menor', 'abuse'],
    harmful:     ['perigoso', 'nocivo', 'harmful', 'dangerous', 'perigosos']
  };
  const keywords = REASON_KEYWORDS[reasonKey] || REASON_KEYWORDS.violent;

  try {
    // Extrai config InnerTube da página
    const cfg = window.ytcfg?.data_ || {};
    let apiKey = cfg.INNERTUBE_API_KEY;
    let clientVersion = cfg.INNERTUBE_CLIENT_VERSION;
    let visitorData = cfg.VISITOR_DATA || '';

    if (!apiKey || !clientVersion) {
      for (const s of document.querySelectorAll('script:not([src])')) {
        const t = s.textContent;
        if (!apiKey) { const m = t.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]{10,})"/); if (m) apiKey = m[1]; }
        if (!clientVersion) { const m = t.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/); if (m) clientVersion = m[1]; }
        if (!visitorData) { const m = t.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/); if (m) visitorData = m[1]; }
        if (apiKey && clientVersion) break;
      }
    }
    if (!apiKey) return { success: false, error: 'API key não encontrada — verifique login' };

    // SAPISIDHASH: confirmado formato SHA-1("{ts} {sapisid} {origin}")_u
    const getCookie = (name) => {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    };
    const sapisid  = getCookie('SAPISID')           || getCookie('__Secure-3PAPISID') || '';
    const sapisid1 = getCookie('__Secure-1PAPISID') || sapisid;
    const sapisid3 = getCookie('__Secure-3PAPISID') || sapisid;
    if (!sapisid) return { success: false, error: 'Sessão não encontrada — faça login no YouTube' };

    const sha1 = async (str) => {
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    };

    const ts = Math.floor(Date.now() / 1000);
    const origin = 'https://www.youtube.com';
    const authHeader = [
      `SAPISIDHASH ${ts}_${await sha1(`${ts} ${sapisid} ${origin}`)}_u`,
      `SAPISID1PHASH ${ts}_${await sha1(`${ts} ${sapisid1} ${origin}`)}_u`,
      `SAPISID3PHASH ${ts}_${await sha1(`${ts} ${sapisid3} ${origin}`)}_u`
    ].join(' ');

    const context = {
      client: {
        clientName: 'WEB', clientVersion,
        hl: 'pt', gl: 'BR', visitorData,
        userAgent: navigator.userAgent,
        utcOffsetMinutes: -180
      }
    };

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'X-Origin': origin,
      'X-Goog-AuthUser': '0',
      'X-Goog-Visitor-Id': visitorData,
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': clientVersion,
      'X-Youtube-Bootstrap-Logged-In': 'true'
    };

    // Utilitário para percorrer a resposta e coletar tokens
    const collectTokens = (o, result = [], depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 20) return result;
      if (Array.isArray(o)) { o.forEach(v => collectTokens(v, result, depth + 1)); return result; }
      if (o.submitActionToken) {
        const label = (o.title?.runs?.[0]?.text || o.text?.runs?.[0]?.text || o.label || '').toLowerCase();
        result.push({ token: o.submitActionToken, label });
      }
      Object.values(o).forEach(v => collectTokens(v, result, depth + 1));
      return result;
    };

    // ── get_panel: obtém o formulário com os tokens por categoria ──────────
    let chosenToken = null;

    const panelPayloads = [
      { context, subject: { videoId } },
      { context, videoId },
      { context, videoId, flaggedContentType: 'VIDEO' }
    ];

    for (const payload of panelPayloads) {
      try {
        const resp = await fetch('/youtubei/v1/get_panel?prettyPrint=false', {
          method: 'POST', credentials: 'include', headers,
          body: JSON.stringify(payload)
        });
        if (!resp.ok) continue;

        const tokens = collectTokens(await resp.json());
        if (!tokens.length) continue;

        chosenToken = tokens.find(t => keywords.some(kw => t.label.includes(kw)))?.token
                   || tokens[0].token;
        break;
      } catch (_) { continue; }
    }

    // ── flow 1º call: seleciona o motivo — sem texto ───────────────────────
    // Confirmado nos DevTools: primeiro flow não carrega userComment
    let commentToken = null;

    if (chosenToken) {
      try {
        const resp = await fetch('/youtubei/v1/flow?prettyPrint=false', {
          method: 'POST', credentials: 'include', headers,
          body: JSON.stringify({ context, subject: { videoId }, submitActionToken: chosenToken })
        });
        if (resp.ok) {
          const tokens = collectTokens(await resp.json());
          // O próximo token é o da tela de comentário
          commentToken = tokens.find(t => t.token !== chosenToken)?.token || null;
        }
      } catch (_) {}
    }

    // ── flow 2º call: tela de comentário — aqui entra o texto ─────────────
    // Confirmado nos DevTools: segundo flow carrega o campo com o texto
    let finalToken = commentToken || chosenToken;

    if (commentToken) {
      try {
        const body = {
          context,
          subject: { videoId },
          submitActionToken: commentToken
        };
        // O texto vai neste call — campo userComment observado no protocolo
        if (userComment) body.userComment = userComment;

        const resp = await fetch('/youtubei/v1/flow?prettyPrint=false', {
          method: 'POST', credentials: 'include', headers,
          body: JSON.stringify(body)
        });
        if (resp.ok) {
          const tokens = collectTokens(await resp.json());
          const next = tokens.find(t => t.token !== commentToken)?.token;
          if (next) finalToken = next;
        }
      } catch (_) {}
    }

    // ── feedback: envia a denúncia final ──────────────────────────────────
    const feedbackBody = {
      context,
      feedbackTokens: [finalToken],
      isFlagAction: true
    };
    if (userComment) feedbackBody.userComment = userComment;

    const feedbackResp = await fetch('/youtubei/v1/feedback?prettyPrint=false', {
      method: 'POST', credentials: 'include', headers,
      body: JSON.stringify(feedbackBody)
    });

    if (feedbackResp.ok || feedbackResp.status === 204) return { success: true };

    const errTxt = await feedbackResp.text().catch(() => '');
    return { success: false, error: `HTTP ${feedbackResp.status}: ${errTxt.slice(0, 200)}` };

  } catch (err) {
    return { success: false, error: err.message };
  }
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    if (u.hostname.includes('youtube.com')) return u.searchParams.get('v');
  } catch (_) {}
  return null;
}

function openTab(url) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }, 15000);
      function listener(id, changeInfo) {
        if (id === tab.id && changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
