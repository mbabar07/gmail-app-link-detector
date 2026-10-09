(() => {
  'use strict';
  if (window.__mailScopeLinkedApps) return;

  const origin = 'https://myaccount.google.com';
  let requestId = Math.floor(Math.random() * 900000) + 100000;

  function accountPrefix() {
    const match = location.pathname.match(/^\/u\/(\d+)\//);
    return match ? `/u/${match[1]}/` : '/';
  }

  function sourcePath() {
    return location.pathname.includes('/linkedapps') ? '/linkedapps' : '/connections';
  }

  function alternateSourcePath(path) {
    return path === '/linkedapps' ? '/connections' : '/linkedapps';
  }

  function canRetrySource(response) {
    return response?.status === 400 || response?.status === 404 || /unsupported response/i.test(response?.error || '');
  }

  function buildUrl(rpcId, source) {
    const data = window.WIZ_global_data || {};
    requestId += 100000;
    const query = new URLSearchParams({
      rpcids: rpcId,
      'source-path': source || sourcePath(),
      'f.sid': data.FdrFJe || '',
      bl: data.cfb2h || '',
      hl: document.documentElement.lang || 'en',
      'soc-app': '1',
      'soc-platform': '1',
      'soc-device': '1',
      _reqid: String(requestId),
      rt: 'c'
    });
    return `${origin}${accountPrefix()}_/AccountSettingsUi/data/batchexecute?${query}`;
  }

  function parsePayload(text, rpcId) {
    const marker = `"wrb.fr","${rpcId}","`;
    const index = text.indexOf(marker);
    if (index === -1) {
      return text.includes(`"wrb.fr","${rpcId}","[]"`) ? [] : null;
    }

    let cursor = index + marker.length - 1;
    let end = cursor + 1;
    let encoded = '';
    while (end < text.length) {
      const character = text[end];
      if (character === '\\') {
        encoded += text[end] + (text[end + 1] || '');
        end += 2;
        continue;
      }
      if (character === '"') break;
      encoded += character;
      end += 1;
    }

    try {
      return JSON.parse(JSON.parse(`"${encoded}"`));
    } catch {
      return null;
    }
  }

  async function batch(rpcId, args, source, extraParam = '1') {
    const data = window.WIZ_global_data || {};
    if (!data.SNlM0e) return { ok: false, error: 'Google security token is not available. Reload the Linked apps page and try again.' };

    const request = JSON.stringify([[[rpcId, JSON.stringify(args), null, extraParam]]]);
    const body = new URLSearchParams({ 'f.req': request, at: data.SNlM0e });
    let response;
    try {
      response = await fetch(buildUrl(rpcId, source), {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString()
      });
    } catch {
      return { ok: false, error: 'Could not reach Google Account. Check your connection and sign-in.' };
    }

    const text = await response.text();
    const payload = parsePayload(text, rpcId);
    if (!response.ok) return { ok: false, status: response.status, error: `Google request failed (HTTP ${response.status}).` };
    if (payload === null) return { ok: false, error: 'Google returned an unsupported response. Reload the Linked apps page and retry.' };
    return { ok: true, payload };
  }

  async function scan() {
    const primaryPath = sourcePath();
    let response = await batch('DLeR6d', [], primaryPath);
    if (!response.ok && canRetrySource(response)) {
      response = await batch('DLeR6d', [], alternateSourcePath(primaryPath));
    }
    if (!response.ok) return response;

    const entries = Array.isArray(response.payload?.[0]) ? response.payload[0] : [];
    const apps = entries.flatMap(entry => {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') return [];
      const details = entry[1] || [];
      const id = entry[0];
      return [{
        id,
        name: typeof details[0] === 'string' && details[0] ? details[0] : 'Unknown app',
        iconUrl: typeof details[2] === 'string' ? details[2] : '',
        home: typeof details[5] === 'string' ? details[5] : '',
        manageUrl: `${origin}${accountPrefix()}linkedapps/overview/${encodeURIComponent(id)}`
      }];
    });
    return { ok: true, apps };
  }

  function extractRevokePairs(payload) {
    const pairs = [];
    for (const group of payload?.[2] || []) {
      if (!Array.isArray(group) || typeof group[7] !== 'string') continue;
      for (const grant of group[6] || []) {
        if (Array.isArray(grant) && typeof grant[2] === 'string' && grant[2].startsWith('AB3d1B')) {
          pairs.push([group[7], grant[2]]);
        }
      }
    }
    return pairs;
  }

  async function unlinkOne(appId) {
    if (typeof appId !== 'string' || !/^[A-Za-z0-9_-]{12,512}$/.test(appId)) {
      return { ok: false, error: 'Invalid linked app id.' };
    }
    const primaryPath = sourcePath();
    const detailPath = path => `${path}/overview/${encodeURIComponent(appId)}`;
    let detailSource = primaryPath;
    let detail = await batch('WocjKc', [appId], detailPath(detailSource));
    if ((!detail.ok && canRetrySource(detail)) || (detail.ok && (!Array.isArray(detail.payload) || detail.payload.length === 0))) {
      detailSource = alternateSourcePath(primaryPath);
      detail = await batch('WocjKc', [appId], detailPath(detailSource));
    }
    if (!detail.ok) return detail;
    if (!Array.isArray(detail.payload) || detail.payload.length === 0) {
      return { ok: false, error: 'Google did not return app access details. No changes were made.' };
    }

    const canonicalId = typeof detail.payload[0] === 'string' ? detail.payload[0] : appId;
    const revokePairs = extractRevokePairs(detail.payload);
    if (!revokePairs.length) return { ok: false, error: 'Google returned no removable access grants. No changes were made.' };

    let revoked = await batch('gFsZ9b', [canonicalId, 0, null, revokePairs], detailSource, 'generic');
    if (!revoked.ok && canRetrySource(revoked)) {
      revoked = await batch('gFsZ9b', [canonicalId, 0, null, revokePairs], alternateSourcePath(detailSource), 'generic');
    }
    if (!revoked.ok) return revoked;
    return { ok: true, id: canonicalId };
  }

  Object.defineProperty(window, '__mailScopeLinkedApps', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ scan, unlinkOne })
  });
})();
