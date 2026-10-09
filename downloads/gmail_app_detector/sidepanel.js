const $ = s => document.querySelector(s);
const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'profile'
];
const MAIL_CATEGORIES = [
  { id: 'primary', label: 'Primary', query: 'in:inbox category:primary' },
  { id: 'promotions', label: 'Promotions', query: 'in:inbox category:promotions' },
  { id: 'updates', label: 'Updates', query: 'in:inbox category:updates' },
  { id: 'social', label: 'Social', query: 'in:inbox category:social' },
  { id: 'spam', label: 'Spam', query: 'in:spam' }
];
const mailsByCategory = Object.fromEntries(MAIL_CATEGORIES.map(category => [category.id, []]));
const selectedMailIds = Object.fromEntries(MAIL_CATEGORIES.map(category => [category.id, new Set()]));
const mailCategoryErrors = Object.fromEntries(MAIL_CATEGORIES.map(category => [category.id, '']));
const SCAN_CREDIT_STORAGE_KEY = 'scanCreditsByAccount';
let token = null, apps = [], linkedApps = [], mails = [], appScanMails = [];
let currentTab = 'appsTab';
let activeMailCategory = 'primary';
let appSource = 'linked';
let appCategoryFilter = 'all';
let scopeRefreshPromise = null;
let activeCreditAccount = null;
let remainingScanCredits = null;
let scanInProgress = false;

const MULTIPART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz',
  'com.br', 'com.mx', 'com.cn', 'com.hk', 'com.sg', 'com.tr', 'co.in', 'firm.in',
  'co.jp', 'co.kr', 'co.za', 'com.tw', 'com.ar', 'com.my',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'herokuapp.com', 'pages.dev',
  'workers.dev', 'web.app', 'firebaseapp.com', 'blogspot.com', 'wordpress.com',
  'wixsite.com', 'azurewebsites.net'
]);
const IGNORED_DOMAIN_ROOTS = [
  'google.com', 'googleapis.com', 'googleusercontent.com', 'gstatic.com', 'ggpht.com',
  'googleadservices.com', 'googlesyndication.com', 'doubleclick.net', 'googletagmanager.com',
  'youtube.com', 'youtu.be'
];
const TRACKING_HOSTS = [
  'safelinks.protection.outlook.com', 'urldefense.proofpoint.com', 'linkprotect.cudasvc.com',
  'clicktime.symantec.com', 'url.emailprotection.link', 'click.pstmrk.it', 'bit.ly', 't.co',
  'tinyurl.com', 'lnkd.in', 'ow.ly'
];
const GAME_DOMAIN_ROOTS = [
  'steampowered.com', 'steamcommunity.com', 'epicgames.com', 'roblox.com', 'riotgames.com',
  'xbox.com', 'playstation.com', 'ea.com', 'ubisoft.com', 'battle.net', 'blizzard.com',
  'minecraft.net', 'supercell.com', 'itch.io', 'gog.com', 'nintendo.com', 'twitch.tv'
];
const GAME_NAME_MARKERS = /\b(game|games|pvp|shooter|cricket|football|soccer|free fire|pubg|bullet echo|dream cricket|gangstar|roblox|fortnite|minecraft)\b/i;

function toast(t) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const d = document.createElement('div');
  d.className = 'toast';
  d.textContent = t;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2800);
}

function updateCreditsHover() {
  const wrapper = $('.profile-menu-wrap');
  const tooltip = $('#creditsHover');
  const ready = Boolean(activeCreditAccount) && Number.isFinite(remainingScanCredits);
  wrapper.classList.toggle('has-credits', ready);
  tooltip.setAttribute('aria-hidden', String(!ready));
  if (ready) $('#creditsRemaining').textContent = String(remainingScanCredits);
  updateScanButtonLabel();
}

async function initializeAccountCredits(emailAddress) {
  const accountKey = String(emailAddress || '').trim().toLowerCase();
  if (!accountKey) throw Error('Google did not return an account email for credit tracking.');
  const stored = await chrome.storage.local.get(SCAN_CREDIT_STORAGE_KEY);
  const accounts = stored[SCAN_CREDIT_STORAGE_KEY] && typeof stored[SCAN_CREDIT_STORAGE_KEY] === 'object'
    ? stored[SCAN_CREDIT_STORAGE_KEY]
    : {};
  if (!Object.prototype.hasOwnProperty.call(accounts, accountKey)) {
    accounts[accountKey] = { credits: 3, createdAt: Date.now() };
  }
  const credits = Math.max(0, Math.floor(Number(accounts[accountKey].credits) || 0));
  accounts[accountKey] = { ...accounts[accountKey], credits };
  await chrome.storage.local.set({ [SCAN_CREDIT_STORAGE_KEY]: accounts });
  activeCreditAccount = accountKey;
  remainingScanCredits = credits;
  updateCreditsHover();
}

async function consumeScanCredit() {
  if (!activeCreditAccount) {
    toast('Google account load nahi hua. Pehle Google mein sign in karein.');
    return false;
  }
  const stored = await chrome.storage.local.get(SCAN_CREDIT_STORAGE_KEY);
  const accounts = stored[SCAN_CREDIT_STORAGE_KEY] || {};
  const account = accounts[activeCreditAccount] || { credits: remainingScanCredits ?? 0 };
  const credits = Math.max(0, Math.floor(Number(account.credits) || 0));
  if (credits === 0) {
    remainingScanCredits = 0;
    updateCreditsHover();
    toast('Scan credits khatam hain. Is account se ab scan nahi ho sakta.');
    return false;
  }
  remainingScanCredits = credits - 1;
  accounts[activeCreditAccount] = { ...account, credits: remainingScanCredits };
  await chrome.storage.local.set({ [SCAN_CREDIT_STORAGE_KEY]: accounts });
  updateCreditsHover();
  if (remainingScanCredits === 0) toast('Yeh aapka aakhri scan credit tha. Agla scan 0 credits par block hoga.');
  return true;
}

function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'GET_TOKEN', interactive, scopes: REQUIRED_SCOPES }, response => {
      if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function loginUser() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'LOGIN_USER' }, response => {
      if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function clearCachedToken(cachedToken) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'CLEAR_TOKEN', token: cachedToken }, response => {
      if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function isInsufficientScope(responseBody) {
  return /insufficient (?:authentication )?scopes?|insufficientpermissions/i.test(responseBody);
}

async function refreshTokenForScopes() {
  if (!scopeRefreshPromise) {
    scopeRefreshPromise = (async () => {
      const cachedToken = token;
      token = null;
      await clearCachedToken(cachedToken);
      const response = await loginUser();
      if (response?.error || !response?.token) {
        throw Error('Gmail modify permission is required. Approve the Google access prompt. If it does not appear, remove MailScope from your Google Account connections and sign in again.');
      }
      token = response.token;
      return token;
    })().finally(() => {
      scopeRefreshPromise = null;
    });
  }
  return scopeRefreshPromise;
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function retryDelay(response, attempt) {
  const retryAfter = response.headers.get('Retry-After');
  const seconds = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const retryAt = Date.parse(retryAfter || '');
  if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  return Math.min(8000, 500 * (2 ** attempt));
}

async function api(url, opts = {}, retriedForScope = false, retryAttempt = 0) {
  let res;
  try {
    res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  } catch (error) {
    if (retryAttempt >= 3) throw Error(`Could not reach Gmail. Check your connection and try again. ${error.message}`);
    await wait(500 * (2 ** retryAttempt));
    return api(url, opts, retriedForScope, retryAttempt + 1);
  }
  if (res.status === 401) {
    chrome.runtime.sendMessage({ type: 'CLEAR_TOKEN', token });
    token = null;
    clearProfileDisplay();
    throw Error('Google session expired. Sign in again.');
  }
  if (!res.ok) {
    const responseBody = await res.text();
    if (res.status === 403 && isInsufficientScope(responseBody)) {
      if (opts.method === 'DELETE') {
        throw Error('Permanent Gmail deletion requires the restricted mail.google.com scope. This extension only requests gmail.modify and moves messages to Trash.');
      }
      if (retriedForScope) {
        throw Error('Google has not granted Gmail modify permission. Reconnect the extension and approve Gmail access before deleting emails.');
      }
      await refreshTokenForScopes();
      return api(url, opts, true);
    }
    const retryable = [429, 500, 502, 503, 504].includes(res.status) ||
      /rateLimitExceeded|userRateLimitExceeded|backendError/i.test(responseBody);
    if (retryable && retryAttempt < 4) {
      await wait(retryDelay(res, retryAttempt));
      return api(url, opts, retriedForScope, retryAttempt + 1);
    }
    let detail = responseBody.slice(0, 200);
    try { detail = JSON.parse(responseBody).error?.message || detail; } catch {}
    throw Error(`Gmail API ${res.status}: ${detail}`);
  }
  return res.status === 204 ? null : res.json();
}

async function signIn() {
  try {
    const r = await loginUser();
    if (r?.error) return toast(r.error);
    token = r.token;
    await loadProfile();
    if (token) toast('Google connected successfully');
  } catch (e) {
    toast(e.message);
  }
}

function clearProfileDisplay() {
  $('#profileToggle').classList.remove('connected');
  $('#accountPhoto').removeAttribute('src');
  $('#accountPhoto').hidden = true;
  $('#accountInitial').hidden = true;
  $('#accountSilhouette').hidden = false;
  $('#heroSection').classList.remove('hidden');
  activeCreditAccount = null;
  remainingScanCredits = null;
  updateCreditsHover();
}

async function loadProfile() {
  try {
    const p = await api('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    await initializeAccountCredits(p.emailAddress);
    $('#profileToggle').classList.add('connected');
    $('#accountInitial').textContent = p.emailAddress[0]?.toUpperCase() || 'G';
    $('#accountInitial').hidden = false;
    $('#accountSilhouette').hidden = true;
    $('#heroSection').classList.add('hidden');
    try {
      const info = await api('https://openidconnect.googleapis.com/v1/userinfo');
      const picture = new URL(info.picture);
      if (picture.protocol === 'https:' && picture.hostname.endsWith('.googleusercontent.com')) {
        const image = $('#accountPhoto');
        const initial = $('#accountInitial');
        image.onload = () => {
          image.hidden = false;
          initial.hidden = true;
        };
        image.onerror = () => {
          image.hidden = true;
          initial.hidden = false;
        };
        image.src = picture.href;
      }
    } catch {
      $('#accountPhoto').hidden = true;
      $('#accountInitial').hidden = false;
    }
  } catch (e) {
    toast(e.message);
  }
}

function decode(b) {
  try { return atob(b.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; }
}

function walk(parts, out) {
  for (const p of parts || []) {
    if (p.mimeType === 'text/html' && p.body?.data) out.push(decode(p.body.data));
    else if (p.mimeType === 'text/plain' && p.body?.data) out.push(decode(p.body.data));
    if (p.parts) walk(p.parts, out);
  }
}

function extract(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const as = [...parsed.querySelectorAll('a[href]')];
  return as.map(a => ({ url: a.href, text: (a.textContent || '').trim() })).filter(x => /^https?:/i.test(x.url));
}

function host(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, ''); } catch { return ''; }
}

function isUnderDomain(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isGoogleHost(hostname) {
  return IGNORED_DOMAIN_ROOTS.some(domain => isUnderDomain(hostname, domain)) || hostname === 'g.co';
}

function isTrackingHost(hostname) {
  return TRACKING_HOSTS.some(domain => isUnderDomain(hostname, domain));
}

function unwrapTrackingUrl(rawUrl) {
  let value = rawUrl;
  const redirectKeys = ['url', 'u', 'target', 'dest', 'destination', 'redirect', 'redirect_url', 'r'];
  for (let attempt = 0; attempt < 3; attempt++) {
    let parsed;
    try { parsed = new URL(value); } catch { return ''; }
    if (!isTrackingHost(parsed.hostname)) return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '';
    const target = redirectKeys.map(key => parsed.searchParams.get(key)).find(Boolean);
    if (!target) return '';
    try { value = new URL(target, parsed).href; } catch { return ''; }
  }
  return '';
}

function registrableDomain(hostname) {
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const lastTwo = labels.slice(-2).join('.');
  return MULTIPART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

function appName(h) {
  return h.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) || h;
}

function appCategory(domain) {
  return GAME_DOMAIN_ROOTS.some(root => isUnderDomain(domain, root)) ? 'game' : 'app';
}

function appLogoUrl(domain) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

function gameCategoryForName(name) {
  return GAME_NAME_MARKERS.test(name) ? 'game' : 'app';
}

function requestLinkedAppsPermission() {
  return new Promise(resolve => {
    chrome.permissions.request({ origins: ['https://myaccount.google.com/*'] }, resolve);
  });
}

async function findOrOpenGoogleLinkedAppsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://myaccount.google.com/*' });
  let tab = tabs.find(candidate => {
    try {
      const path = new URL(candidate.url).pathname;
      return path.includes('/linkedapps') || path.includes('/connections');
    } catch {
      return false;
    }
  });
  if (!tab) tab = await chrome.tabs.create({ url: 'https://myaccount.google.com/linkedapps' });
  if (!tab?.id) throw Error('Could not open Google Linked apps.');

  await waitForTabLoad(tab.id);
  const loadedTab = await chrome.tabs.get(tab.id);
  const page = new URL(loadedTab.url);
  if (page.origin !== 'https://myaccount.google.com' || !/\/(linkedapps|connections)(\/|$)/.test(page.pathname)) {
    throw Error('Sign in to Google in the opened tab, then choose Sync linked apps again.');
  }
  return tab.id;
}

async function callLinkedAppsEngine(tabId, method, args = []) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['linkedapps-engine.js']
  });
  void injection;
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [method, args],
    func: async (methodName, methodArgs) => {
      const engine = window.__mailScopeLinkedApps;
      if (!engine || typeof engine[methodName] !== 'function') {
        return { ok: false, error: 'Google linked-app engine did not load. Reload the Google page and retry.' };
      }
      return engine[methodName](...methodArgs);
    }
  });
  return result?.result;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      error ? reject(error) : resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish();
    };
    const timeout = setTimeout(() => finish(Error('Google Linked apps page took too long to load.')), 30000);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError) finish(Error(chrome.runtime.lastError.message));
      else if (tab.status === 'complete') finish();
    });
  });
}

async function syncGoogleLinkedApps() {
  if (scanInProgress) return;
  if (!activeCreditAccount) return toast('Linked apps scan se pehle Google mein sign in karein.');
  if (remainingScanCredits === 0) return toast('Scan credits khatam hain. Is account se ab scan nahi ho sakta.');
  scanInProgress = true;
  updateScanButtonLabel();
  try {
    const granted = await requestLinkedAppsPermission();
    if (!granted) return toast('Allow access to myaccount.google.com to import your linked apps.');
    if (!token) await signIn();
    if (!token || !activeCreditAccount) return;
    if (!(await consumeScanCredit())) return;
    $('#scanBtn').textContent = 'Reading linked apps...';
    const tabId = await findOrOpenGoogleLinkedAppsTab();
    const result = await callLinkedAppsEngine(tabId, 'scan');
    if (!result?.ok) throw Error(result?.error || 'Google linked apps scan failed.');
    linkedApps = result.apps.map(app => ({ ...app, category: gameCategoryForName(app.name), links: [], emails: [] }));
    await chrome.storage.local.set({ googleLinkedApps: linkedApps, googleLinkedAppsSyncedAt: Date.now() });
    render();
    toast(`${linkedApps.length} Google linked app(s) loaded`);
  } catch (e) {
    toast(e.message);
  } finally {
    scanInProgress = false;
    updateScanButtonLabel();
  }
}

async function listAllMessageIds(query) {
  const ids = [];
  const pageTokens = new Set();
  let pageToken = '';
  do {
    const parameters = new URLSearchParams({ maxResults: '500', q: query });
    if (query === 'in:spam') parameters.set('includeSpamTrash', 'true');
    if (pageToken) parameters.set('pageToken', pageToken);
    const result = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${parameters}`);
    ids.push(...(result.messages || []));
    pageToken = result.nextPageToken || '';
    if (pageToken && pageTokens.has(pageToken)) throw Error('Gmail returned a repeated page token. Scan stopped to avoid looping.');
    if (pageToken) pageTokens.add(pageToken);
  } while (pageToken);
  return ids;
}

async function mapWithConcurrency(items, concurrency, task) {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      await task(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function getMailDetails(message, category) {
  const headers = message.payload?.headers || [];
  const headerValue = name => headers.find(header => header.name?.toLowerCase() === name)?.value || '';
  const subject = headerValue('subject') || 'No Subject';
  const sender = headerValue('from') || 'Unknown Sender';
  const precedence = headerValue('precedence');
  const autoSubmitted = headerValue('auto-submitted');
  const isBulk = Boolean(headerValue('list-unsubscribe')) || /bulk|list/i.test(precedence) ||
    (Boolean(autoSubmitted) && !/^no$/i.test(autoSubmitted)) ||
    /unsubscribe|newsletter|no-reply|notification|alert|update|support|billing|receipt/i.test(sender + ' ' + subject);
  return {
    id: message.id,
    subject,
    sender,
    date: headerValue('date'),
    snippet: message.snippet || '',
    isBulk,
    category,
    internalDate: Number(message.internalDate || 0),
    isUnread: (message.labelIds || []).includes('UNREAD'),
    isStarred: (message.labelIds || []).includes('STARRED')
  };
}

async function scan() {
  if (scanInProgress) return;
  if (remainingScanCredits === 0) return toast('Scan credits khatam hain. Is account se ab scan nahi ho sakta.');
  scanInProgress = true;
  updateScanButtonLabel();
  try {
    if (!token) await signIn();
    if (!token) return;
    if (!activeCreditAccount) await loadProfile();
    if (!(await consumeScanCredit())) return;
    if (currentTab === 'mailsTab') await scanAllMailCategories();
    else await scanInboxApps();
  } catch (error) {
    toast(error.message);
  } finally {
    scanInProgress = false;
    updateScanButtonLabel();
  }
}

async function scanAllMailCategories() {
  for (const category of MAIL_CATEGORIES) {
    mailsByCategory[category.id] = [];
    selectedMailIds[category.id].clear();
    mailCategoryErrors[category.id] = '';
    document.querySelector(`[data-mail-list="${category.id}"]`).innerHTML = `<div class="loading">Finding all ${category.label} messages...</div>`;
  }
  updateMails();

  const listingResults = await Promise.all(MAIL_CATEGORIES.map(async category => {
    try {
      const messages = await listAllMessageIds(category.query);
      mailCategoryErrors[category.id] = '';
      document.querySelector(`[data-mail-list="${category.id}"] .loading`).textContent = `Loading ${messages.length} ${category.label} messages...`;
      return { category, messages };
    } catch (error) {
      mailCategoryErrors[category.id] = error.message;
      document.querySelector(`[data-mail-list="${category.id}"]`).innerHTML = `<div class="empty"><h3>${escapeHtml(category.label)} scan failed</h3><p>${escapeHtml(error.message)}</p></div>`;
      return { category, messages: [], error };
    }
  }));

  const tasks = [];
  const seenIds = new Set();
  for (const result of listingResults) {
    for (const message of result.messages) {
      if (seenIds.has(message.id)) continue;
      seenIds.add(message.id);
      tasks.push({ messageId: message.id, category: result.category });
    }
  }

  let completed = 0;
  let failed = 0;
  const failedByCategory = Object.fromEntries(MAIL_CATEGORIES.map(category => [category.id, 0]));
  const completedByCategory = Object.fromEntries(MAIL_CATEGORIES.map(category => [category.id, 0]));
  const failedCategories = listingResults.filter(result => result.error).length;
  $('#scanBtn').textContent = `Loading 0/${tasks.length}`;
  await mapWithConcurrency(tasks, 5, async task => {
    try {
      const parameters = new URLSearchParams({ format: 'metadata' });
      for (const header of ['From', 'Subject', 'Date', 'List-Unsubscribe', 'Precedence', 'Auto-Submitted']) {
        parameters.append('metadataHeaders', header);
      }
      const message = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(task.messageId)}?${parameters}`);
      mailsByCategory[task.category.id].push(getMailDetails(message, task.category.id));
      completedByCategory[task.category.id]++;
    } catch (error) {
      failed++;
      failedByCategory[task.category.id]++;
      if (failed === 1) console.warn('Some Gmail messages could not be loaded:', error.message);
    }
    completed++;
    if (completed % 20 === 0 || completed === tasks.length) {
      $('#scanBtn').textContent = `Loading ${completed}/${tasks.length}`;
      for (const category of MAIL_CATEGORIES) {
        const status = document.querySelector(`[data-mail-list="${category.id}"] .loading`);
        if (status) status.textContent = `Loading ${completedByCategory[category.id]} of ${listingResults.find(result => result.category.id === category.id)?.messages.length || 0} ${category.label} messages...`;
      }
    }
  });

  for (const category of MAIL_CATEGORIES) {
    mailsByCategory[category.id].sort((first, second) => second.internalDate - first.internalDate);
    if (failedByCategory[category.id]) {
      mailCategoryErrors[category.id] = `${failedByCategory[category.id]} message(s) could not load. Scan again to retry.`;
    }
  }
  updateMails();
  render();
  const total = tasks.length;
  const problemCount = failed + failedCategories;
  toast(problemCount
    ? `Loaded ${total - failed} messages. ${failed} message request(s) and ${failedCategories} category query(s) failed; try scanning again.`
    : `Scan complete: ${total} messages loaded across all Gmail categories`);
}

async function scanInboxApps() {
  apps = [];
  appScanMails = [];
  $('#appList').innerHTML = '<div class="loading">Finding every message in your inbox...</div>';
  const messageIds = await listAllMessageIds('in:inbox');
  const appMap = new Map();
  const scannedMails = [];
  let completed = 0;
  let failed = 0;

  $('#scanBtn').textContent = `Scanning 0/${messageIds.length}`;
  await mapWithConcurrency(messageIds, 5, async item => {
    try {
      const message = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`);
      const mail = getMailDetails(message, 'primary');
      scannedMails.push(mail);
      const html = [];
      walk(message.payload?.parts || [message.payload], html);
      const links = html.flatMap(extract).map(link => ({ ...link, url: unwrapTrackingUrl(link.url) })).filter(link => link.url);
      const uniqueLinks = [...new Map(links.map(link => [link.url, link])).values()];
      for (const link of uniqueLinks) {
        const linkedHost = host(link.url);
        if (!linkedHost || isGoogleHost(linkedHost)) continue;
        const domain = registrableDomain(linkedHost);
        if (!appMap.has(domain)) appMap.set(domain, { id: domain, name: appName(domain), domain, category: appCategory(domain), emails: new Set(), links: new Map() });
        const app = appMap.get(domain);
        app.emails.add(message.id);
        app.links.set(link.url, link.text || link.url);
      }
    } catch (error) {
      failed++;
      if (failed === 1) console.warn('Some inbox messages could not be scanned for links:', error.message);
    }
    completed++;
    if (completed % 20 === 0 || completed === messageIds.length) $('#scanBtn').textContent = `Scanning ${completed}/${messageIds.length}`;
  });

  apps = [...appMap.values()].map(app => ({
    ...app,
    emails: [...app.emails],
    links: [...app.links].map(([url, text]) => ({ url, text }))
  })).sort((first, second) => first.name.localeCompare(second.name, undefined, { sensitivity: 'base' }) || first.domain.localeCompare(second.domain));
  appScanMails = scannedMails.sort((first, second) => second.internalDate - first.internalDate);
  render();
  toast(failed
    ? `Found ${apps.length} services. ${failed} message(s) could not be scanned.`
    : `Inbox scan complete: ${messageIds.length} messages and ${apps.length} services scanned`);
}

function updateMails() {
  mails = MAIL_CATEGORIES.flatMap(category => mailsByCategory[category.id]);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderAppCard(a) {
  const linkedAccount = Boolean(a.manageUrl);
  const logoUrl = a.iconUrl || (a.domain ? appLogoUrl(a.domain) : '');
  return `
    <article class="card">
      <div class="card-top">
        <div class="app-icon service-icon">
          <span class="app-fallback">${escapeHtml(a.name[0]?.toUpperCase() || '?')}</span>
          ${logoUrl ? `<img class="service-logo" src="${escapeHtml(logoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        </div>
        <div class="meta">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="domain">${escapeHtml(linkedAccount ? 'Google Account linked' : a.domain)}</div>
        </div>
        <div class="count-badge">${linkedAccount ? 'Google linked' : `${a.emails.length} related`}</div>
      </div>
      ${linkedAccount ? '' : `<div class="links">
        ${a.links.slice(0, 3).map(l => `<div class="link"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.text || l.url)}</a></div>`).join('')}
        ${a.links.length > 3 ? `<div class="link">+${a.links.length - 3} more linked URLs</div>` : ''}
      </div>`}
      <div class="card-actions">
        ${linkedAccount
          ? `<a class="action-btn" href="${escapeHtml(a.manageUrl)}" target="_blank" rel="noopener">Open details</a><button class="action-btn danger-action" data-remove-linked-app="${escapeHtml(a.id)}">Remove access</button>`
          : `<a class="action-btn" href="https://myaccount.google.com/linkedapps" target="_blank" rel="noopener">Open Google list</a><button class="action-btn danger-action" data-delete-app="${escapeHtml(a.id)}">Move related mail to Trash</button>`}
      </div>
    </article>
  `;
}

function formatMailDate(timestamp) {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const options = date.toDateString() === now.toDateString()
    ? { hour: 'numeric', minute: '2-digit' }
    : date.getFullYear() === now.getFullYear()
      ? { month: 'short', day: 'numeric' }
      : { year: 'numeric', month: 'short', day: 'numeric' };
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function render() {
  const q = $('#search').value.toLowerCase().trim();
  
  // Update stats
  const sourceApps = appSource === 'linked' ? linkedApps : apps;
  $('#appCount').textContent = sourceApps.length;
  $('#appCountLabel').textContent = appSource === 'linked' ? 'Linked Apps' : 'Email Services';
  const statMails = currentTab === 'appsTab' ? appScanMails : mails;
  $('#bulkCount').textContent = statMails.filter(mail => mail.isBulk).length;
  $('#emailCount').textContent = statMails.length;
  $('#bulkAccessPanel').hidden = currentTab !== 'appsTab' || appSource !== 'linked';
  $('#removeAllAccessBtn').disabled = linkedApps.length === 0;

  if (currentTab === 'appsTab') {
    const visible = sourceApps.filter(a =>
      (appCategoryFilter === 'all' || a.category === appCategoryFilter) &&
      (a.name + ' ' + (a.domain || '') + ' ' + (a.links || []).map(x => x.text + ' ' + x.url).join(' ')).toLowerCase().includes(q)
    );
    const appCounts = {
      all: sourceApps.length,
      app: sourceApps.filter(app => app.category === 'app').length,
      game: sourceApps.filter(app => app.category === 'game').length
    };
    document.querySelectorAll('[data-app-source]').forEach(button => {
      const selected = button.dataset.appSource === appSource;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    $('#appSourceNote').textContent = appSource === 'linked'
      ? 'Google Account links. Remove one app at a time or review the warning to remove all.'
      : 'Services found in email URLs. These are not verified Google Account links.';
    $('#scanBtn').textContent = appSource === 'linked' ? 'Sync linked apps' : 'Scan email links';
    document.querySelectorAll('[data-app-filter]').forEach(button => {
      const category = button.dataset.appFilter;
      button.classList.toggle('active', category === appCategoryFilter);
      button.setAttribute('aria-pressed', String(category === appCategoryFilter));
      button.textContent = `${category === 'all' ? 'All' : category === 'game' ? 'Games' : 'Apps'} ${appCounts[category]}`;
    });
    
    if (!visible.length) {
      const emptyTitle = appSource === 'linked' ? 'No linked apps imported' : 'No email services found';
      const emptyMessage = appSource === 'linked'
        ? 'Choose Sync linked apps to read the list from your Google Account.'
        : 'Try a different search query or scan Gmail links.';
      $('#appList').innerHTML = `<div class="empty"><span class="empty-icon service-mark" aria-hidden="true"></span><h3>${emptyTitle}</h3><p>${emptyMessage}</p></div>`;
      updateSelection();
      return;
    }

    const categories = appCategoryFilter === 'all' ? ['app', 'game'] : [appCategoryFilter];
    $('#appList').innerHTML = categories.map(category => {
      const group = visible.filter(app => app.category === category);
      if (!group.length) return '';
      const title = category === 'game' ? 'Games' : 'Apps';
      return `<section class="service-group"><header class="group-heading"><h3>${title}</h3><span>${group.length} · A to Z</span></header>${group.map(renderAppCard).join('')}</section>`;
    }).join('');

    document.querySelectorAll('[data-delete-app]').forEach(btn => {
      btn.onclick = () => deleteAppEmails([btn.dataset.deleteApp]);
    });
    document.querySelectorAll('[data-remove-linked-app]').forEach(btn => {
      btn.onclick = () => removeGoogleLinkedApp(btn.dataset.removeLinkedApp);
    });
    document.querySelectorAll('.service-logo').forEach(image => {
      image.addEventListener('load', () => {
        if (image.naturalWidth > 0) image.parentElement.classList.add('has-logo');
      }, { once: true });
      image.addEventListener('error', () => image.remove(), { once: true });
    });

  } else {
    for (const category of MAIL_CATEGORIES) {
      const categoryMails = mailsByCategory[category.id] || [];
      const visible = categoryMails.filter(mail =>
        (mail.subject + ' ' + mail.sender + ' ' + mail.snippet).toLowerCase().includes(q)
      );
      const list = document.querySelector(`[data-mail-list="${category.id}"]`);
      if (!visible.length) {
        const message = mailCategoryErrors[category.id] || (categoryMails.length
          ? 'No messages match this search.'
          : `Choose Scan all mail to load messages from Gmail.`);
        list.innerHTML = `<div class="empty"><span class="empty-icon mail-mark" aria-hidden="true"></span><h3>${mailCategoryErrors[category.id] ? 'Scan incomplete' : categoryMails.length ? 'No matching messages' : category.label}</h3><p>${escapeHtml(message)}</p></div>`;
      } else {
        list.innerHTML = visible.map(mail => `
          <article class="card mail-card ${mail.isUnread ? 'unread' : ''}">
            <div class="card-top">
              <input class="check" type="checkbox" data-mail-checkbox="${category.id}" data-id="${escapeHtml(mail.id)}" aria-label="Select ${escapeHtml(mail.subject)}" ${selectedMailIds[category.id].has(mail.id) ? 'checked' : ''}>
              <div class="app-icon ${mail.isBulk ? 'bulk-icon' : 'mail-icon'}" aria-hidden="true"></div>
              <div class="meta">
                <div class="name">${mail.isStarred ? '<span class="mail-star" aria-label="Starred">★</span> ' : ''}${escapeHtml(mail.subject)}</div>
                <div class="mail-meta-line"><span class="domain">${escapeHtml(mail.sender)}</span><time class="mail-date">${escapeHtml(formatMailDate(mail.internalDate))}</time></div>
              </div>
              <div class="count-badge ${mail.isBulk ? 'bulk-tag' : ''}">${mail.isBulk ? 'Bulk / Auto' : category.label}</div>
            </div>
            <div class="preview">${escapeHtml(mail.snippet)}</div>
            <div class="card-actions">
              <a class="action-btn" href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(mail.id)}" target="_blank" rel="noopener">Open in Gmail ↗</a>
              <button class="action-btn danger-action" data-delete-mail="${escapeHtml(mail.id)}" data-mail-category="${category.id}">Move to Trash</button>
            </div>
          </article>
        `).join('');
      }
      updateCategorySelection(category.id, visible);
    }

    document.querySelectorAll('[data-delete-mail]').forEach(button => {
      button.onclick = () => deleteIndividualMails([button.dataset.deleteMail], button.dataset.mailCategory, button);
    });
  }

  document.querySelectorAll('[data-mail-checkbox]').forEach(input => {
    input.onchange = () => {
      const selection = selectedMailIds[input.dataset.mailCheckbox];
      input.checked ? selection.add(input.dataset.id) : selection.delete(input.dataset.id);
      updateSelection();
    };
  });
  updateSelection();
}

function updateSelection() {
  if (currentTab !== 'mailsTab') return;
  for (const category of MAIL_CATEGORIES) {
    const visible = [...document.querySelectorAll(`[data-mail-checkbox="${category.id}"]`)].map(input => input.dataset.id);
    updateCategorySelection(category.id, visible);
  }
}

function updateCategorySelection(category, visibleIds) {
  const selection = selectedMailIds[category];
  const selectAll = document.querySelector(`[data-select-category="${category}"]`);
  const selectedCount = document.querySelector(`[data-selected-count="${category}"]`);
  const deleteSelected = document.querySelector(`[data-delete-selected="${category}"]`);
  const deleteAll = document.querySelector(`[data-delete-all="${category}"]`);
  if (!selectAll || !selectedCount || !deleteSelected || !deleteAll) return;
  const selectedVisible = visibleIds.filter(id => selection.has(id)).length;
  selectedCount.textContent = `${selection.size} selected`;
  selectAll.checked = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visibleIds.length;
  deleteSelected.disabled = selection.size === 0;
  deleteAll.disabled = mailsByCategory[category].length === 0;
}

async function moveMessagesToTrash(messageIds, context, category, progressButton) {
  if (!token) return toast('Sign in first');
  const ids = [...new Set(messageIds)];
  if (!ids.length) return toast('No related emails found');
  if (!confirm(`Move ${ids.length} email(s)${context} to Gmail Trash? You can restore them from Trash.`)) return;

  const originalLabel = progressButton?.textContent;
  const deleteAllButton = category ? document.querySelector(`[data-delete-all="${category}"]`) : null;
  const deleteSelectedButton = category ? document.querySelector(`[data-delete-selected="${category}"]`) : null;
  if (deleteAllButton) deleteAllButton.disabled = true;
  if (deleteSelectedButton) deleteSelectedButton.disabled = true;
  if (progressButton) progressButton.disabled = true;
  const deletedIds = [];
  const failures = [];
  try {
    for (let i = 0; i < ids.length; i += 5) {
      const batch = ids.slice(i, i + 5);
      const results = await Promise.allSettled(batch.map(id =>
        api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`, { method: 'POST' })
      ));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') deletedIds.push(batch[index]);
        else failures.push(result.reason);
      });
      if (progressButton) progressButton.textContent = `Moving ${Math.min(i + batch.length, ids.length)}/${ids.length}`;
    }
    const deleted = new Set(deletedIds);
    for (const categoryInfo of MAIL_CATEGORIES) {
      mailsByCategory[categoryInfo.id] = mailsByCategory[categoryInfo.id].filter(mail => !deleted.has(mail.id));
      deletedIds.forEach(id => selectedMailIds[categoryInfo.id].delete(id));
    }
    updateMails();
    appScanMails = appScanMails.filter(mail => !deleted.has(mail.id));
    apps = apps.map(app => ({ ...app, emails: app.emails.filter(id => !deleted.has(id)) }))
      .filter(app => app.emails.length > 0);
    render();
    updateSelection();
    if (failures.length) toast(`${deletedIds.length} moved to Trash; ${failures.length} failed. ${failures[0].message}`);
    else toast(`${deletedIds.length} email(s) moved to Trash`);
  } catch (e) {
    toast(e.message);
  } finally {
    if (progressButton) {
      progressButton.textContent = originalLabel;
      progressButton.disabled = false;
    }
    if (deleteAllButton) deleteAllButton.disabled = mailsByCategory[category].length === 0;
    if (deleteSelectedButton) deleteSelectedButton.disabled = selectedMailIds[category].size === 0;
  }
  updateSelection();
}

function deleteAppEmails(appIds) {
  const messageIds = apps.filter(app => appIds.includes(app.id)).flatMap(app => app.emails);
  return moveMessagesToTrash(messageIds, ' linked from the selected detected service(s)');
}

async function removeGoogleLinkedApp(appId) {
  const app = linkedApps.find(item => item.id === appId);
  if (!app) return toast('This linked app is no longer in the list. Sync again.');
  if (!confirm(`Remove Google Account access for "${app.name}"? This will stop sharing account data with this app.`)) return;

  const granted = await new Promise(resolve => {
    chrome.permissions.contains({ origins: ['https://myaccount.google.com/*'] }, resolve);
  });
  if (!granted) return toast('Choose Sync linked apps first to grant Google page access.');

  try {
    const tabId = await findOrOpenGoogleLinkedAppsTab();
    const result = await callLinkedAppsEngine(tabId, 'unlinkOne', [appId]);
    if (!result?.ok) throw Error(result?.error || 'Google could not remove access. No changes were made.');

    linkedApps = linkedApps.filter(item => item.id !== appId);
    await chrome.storage.local.set({ googleLinkedApps: linkedApps, googleLinkedAppsSyncedAt: Date.now() });
    render();
    toast(`Google Account access removed for ${app.name}`);
  } catch (e) {
    toast(e.message);
  }
}

async function removeAllGoogleLinkedApps() {
  const dialog = $('#bulkRemoveDialog');
  const confirmButton = $('#bulkRemoveConfirm');
  const skipButton = $('#bulkRemoveSkip');
  const progress = $('#bulkRemoveProgress');
  const bulkButton = $('#removeAllAccessBtn');
  confirmButton.disabled = true;
  skipButton.disabled = true;
  bulkButton.disabled = true;
  progress.hidden = false;

  let succeeded = 0;
  const failures = [];
  try {
    progress.textContent = 'Checking your current Google linked apps...';
    const granted = await requestLinkedAppsPermission();
    if (!granted) throw Error('Google Account access was not granted. No apps were removed.');

    const tabId = await findOrOpenGoogleLinkedAppsTab();
    const scanResult = await callLinkedAppsEngine(tabId, 'scan');
    if (!scanResult?.ok) throw Error(scanResult?.error || 'Could not refresh the Google linked apps list. No apps were removed.');

    linkedApps = scanResult.apps.map(app => ({ ...app, category: gameCategoryForName(app.name), links: [], emails: [] }));
    await chrome.storage.local.set({ googleLinkedApps: linkedApps, googleLinkedAppsSyncedAt: Date.now() });
    render();

    const appsToRemove = [...linkedApps];
    if (!appsToRemove.length) {
      progress.textContent = 'No linked apps were found. Nothing needed to be removed.';
    } else {
      for (let index = 0; index < appsToRemove.length; index++) {
        const app = appsToRemove[index];
        progress.textContent = `Removing ${index + 1} of ${appsToRemove.length}: ${app.name}`;
        confirmButton.textContent = `Removing ${index + 1}/${appsToRemove.length}`;
        try {
          const result = await callLinkedAppsEngine(tabId, 'unlinkOne', [app.id]);
          if (!result?.ok) throw Error(result?.error || 'Google did not confirm this removal.');
          linkedApps = linkedApps.filter(item => item.id !== app.id);
          succeeded++;
          render();
          try {
            await chrome.storage.local.set({ googleLinkedApps: linkedApps, googleLinkedAppsSyncedAt: Date.now() });
          } catch (storageError) {
            console.warn('Could not update the local linked-app cache:', storageError.message);
          }
        } catch (error) {
          failures.push(`${app.name}: ${error.message}`);
        }
      }

      progress.textContent = failures.length
        ? `${succeeded} app(s) removed. ${failures.length} could not be removed and remain in the list. ${failures.slice(0, 3).join(' ')}${failures.length > 3 ? ' More failures are listed in the app view.' : ''}`
        : `${succeeded} app(s) no longer have access to your Google Account.`;
    }

    dialog.dataset.complete = 'true';
    confirmButton.textContent = 'Done';
    confirmButton.disabled = false;
    skipButton.hidden = true;
    toast(failures.length
      ? `${succeeded} app(s) removed; ${failures.length} failed and remain linked.`
      : `${succeeded} linked app(s) removed`);
  } catch (error) {
    progress.textContent = error.message;
    confirmButton.textContent = 'Try again';
    confirmButton.disabled = false;
    skipButton.disabled = false;
    bulkButton.disabled = linkedApps.length === 0;
    toast(error.message);
  }
}

async function deleteIndividualMails(mailIds, category, progressButton) {
  return moveMessagesToTrash(mailIds, '', category, progressButton);
}

function updateScanButtonLabel() {
  if (remainingScanCredits === 0) {
    $('#scanBtn').textContent = 'No scan credits';
    $('#scanBtn').disabled = true;
    return;
  }
  $('#scanBtn').textContent = currentTab === 'mailsTab'
    ? 'Scan all mail'
    : appSource === 'linked' ? 'Sync linked apps' : 'Scan email links';
  $('#scanBtn').disabled = scanInProgress;
}

document.querySelectorAll('.tab-btn').forEach(button => {
  button.onclick = () => {
    currentTab = button.dataset.tab;
    document.querySelectorAll('.tab-btn').forEach(tab => tab.classList.toggle('active', tab === button));
    document.querySelectorAll('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === currentTab));
    $('#workspaceTrack').dataset.view = currentTab;
    updateScanButtonLabel();
    render();
  };
});

document.querySelectorAll('[data-mail-category]').forEach(button => {
  button.onclick = () => {
    activeMailCategory = button.dataset.mailCategory;
    $('#mailPanels').dataset.activeCategory = activeMailCategory;
    document.querySelectorAll('[data-mail-category]').forEach(tab => {
      const active = tab === button;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('[data-mail-panel]').forEach(panel => {
      panel.setAttribute('aria-hidden', String(panel.dataset.mailPanel !== activeMailCategory));
    });
    updateScanButtonLabel();
    render();
  };
});

document.querySelectorAll('[data-select-category]').forEach(checkbox => {
  checkbox.onchange = () => {
    const category = checkbox.dataset.selectCategory;
    const visibleIds = [...document.querySelectorAll(`[data-mail-checkbox="${category}"]`)].map(input => input.dataset.id);
    if (checkbox.checked) visibleIds.forEach(id => selectedMailIds[category].add(id));
    else visibleIds.forEach(id => selectedMailIds[category].delete(id));
    render();
  };
});

document.querySelectorAll('[data-delete-selected]').forEach(button => {
  button.onclick = () => {
    const category = button.dataset.deleteSelected;
    const categoryInfo = MAIL_CATEGORIES.find(item => item.id === category);
    return moveMessagesToTrash([...selectedMailIds[category]], ` selected from ${categoryInfo.label}`, category, button);
  };
});

document.querySelectorAll('[data-delete-all]').forEach(button => {
  button.onclick = async () => {
    const category = button.dataset.deleteAll;
    const categoryInfo = MAIL_CATEGORIES.find(item => item.id === category);
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = 'Loading...';
    try {
      const messageIds = await getAllCategoryMessageIds(categoryInfo, button);
      await moveMessagesToTrash(messageIds, ` from ${categoryInfo.label}`, category, button);
    } catch (error) {
      toast(error.message);
    } finally {
      button.textContent = originalLabel;
      updateSelection();
    }
  };
});

async function getAllCategoryMessageIds(category, progressButton) {
  const messageIds = [];
  let pageToken = '';
  do {
    const parameters = new URLSearchParams({ maxResults: '500', q: category.query });
    if (category.id === 'spam') parameters.set('includeSpamTrash', 'true');
    if (pageToken) parameters.set('pageToken', pageToken);
    const result = await api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${parameters}`);
    messageIds.push(...(result.messages || []).map(message => message.id));
    if (progressButton) progressButton.textContent = `Found ${messageIds.length}...`;
    pageToken = result.nextPageToken || '';
  } while (pageToken);
  return messageIds;
}

function closeProfileMenu() {
  $('#profileMenu').hidden = true;
  $('#profileToggle').setAttribute('aria-expanded', 'false');
  $('.profile-menu-wrap').classList.remove('menu-open');
}

$('#profileToggle').onclick = () => {
  const open = $('#profileMenu').hidden;
  $('#profileMenu').hidden = !open;
  $('#profileToggle').setAttribute('aria-expanded', String(open));
  $('.profile-menu-wrap').classList.toggle('menu-open', open);
};

document.querySelector('[data-profile-action="settings"]').onclick = () => {
  closeProfileMenu();
  $('#settingsDialog').showModal();
};

$('#removeAllAccessBtn').onclick = () => {
  if (!linkedApps.length) return toast('Sync linked apps before removing access.');
  $('#bulkRemoveCount').textContent = `${linkedApps.length} linked app(s) will lose access to your Google Account.`;
  $('#bulkRemoveProgress').hidden = true;
  $('#bulkRemoveProgress').textContent = '';
  $('#bulkRemoveConfirm').textContent = 'Continue and remove';
  $('#bulkRemoveConfirm').disabled = false;
  $('#bulkRemoveSkip').textContent = 'Skip';
  $('#bulkRemoveSkip').hidden = false;
  $('#bulkRemoveSkip').disabled = false;
  $('#bulkRemoveDialog').dataset.complete = 'false';
  $('#bulkRemoveDialog').showModal();
};

$('#bulkRemoveSkip').onclick = () => $('#bulkRemoveDialog').close();
$('#bulkRemoveDialog').addEventListener('cancel', event => {
  if ($('#bulkRemoveSkip').disabled) event.preventDefault();
});
$('#bulkRemoveConfirm').onclick = () => {
  if ($('#bulkRemoveDialog').dataset.complete === 'true') $('#bulkRemoveDialog').close();
  else return removeAllGoogleLinkedApps();
};

document.querySelector('[data-profile-action="logout"]').onclick = logoutUser;
$('#settingsDone').onclick = () => $('#settingsDialog').close();

document.addEventListener('click', event => {
  if (!event.target.closest('.profile-menu-wrap')) closeProfileMenu();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeProfileMenu();
});
document.addEventListener('contextmenu', event => event.preventDefault());

document.addEventListener('pointerdown', event => {
  const target = event.target.closest('button:not(:disabled), a, [role="tab"]');
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const ripple = document.createElement('span');
  ripple.className = 'tap-ripple';
  ripple.style.left = `${event.clientX - rect.left}px`;
  ripple.style.top = `${event.clientY - rect.top}px`;
  target.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
});

async function logoutUser() {
  closeProfileMenu();
  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'LOGOUT_USER' }, response => {
        if (chrome.runtime.lastError) reject(Error(chrome.runtime.lastError.message));
        else if (response?.error) reject(Error(response.error));
        else resolve(response);
      });
    });
    token = null;
    apps = [];
    linkedApps = [];
    appScanMails = [];
    for (const category of MAIL_CATEGORIES) {
      mailsByCategory[category.id] = [];
      selectedMailIds[category.id].clear();
      mailCategoryErrors[category.id] = '';
    }
    updateMails();
    clearProfileDisplay();
    await chrome.storage.local.remove(['googleLinkedApps', 'googleLinkedAppsSyncedAt']);
    render();
    toast('Signed out of Google');
  } catch (error) {
    toast(error.message);
  }
}

$('#signInBtn').onclick = signIn;
$('#scanBtn').onclick = () => {
  if (currentTab === 'appsTab' && appSource === 'linked') syncGoogleLinkedApps();
  else scan();
};
$('#search').oninput = render;
document.querySelectorAll('[data-app-source]').forEach(button => {
  button.onclick = () => {
    appSource = button.dataset.appSource;
    updateScanButtonLabel();
    render();
  };
});
document.querySelectorAll('[data-app-filter]').forEach(button => {
  button.onclick = () => {
    appCategoryFilter = button.dataset.appFilter;
    render();
  };
});

function setLinkedApps(importedApps) {
  linkedApps = (Array.isArray(importedApps) ? importedApps : []).map(app => ({
    ...app,
    category: gameCategoryForName(app.name),
    links: [],
    emails: []
  })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  render();
}

chrome.storage.local.get(['googleLinkedApps'], stored => {
  setLinkedApps(stored?.googleLinkedApps || []);
});

getToken(false).then(response => {
  if (response?.token) {
    token = response.token;
    return loadProfile();
  }
}).catch(() => {});