chrome.runtime.onInstalled.addListener(async () => {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel?.open && tab?.windowId) {
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch (_) {}
  }
});

const GOOGLE_OAUTH_CLIENT_ID = '872614472427-28n10cjavgg0k2u5749aa7q2aa41b4b7.apps.googleusercontent.com';
const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'profile'
];
const GOOGLE_SESSION_KEY = 'googleSession';

function createOAuthState() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function loginWithGoogle() {
  const redirectUri = chrome.identity.getRedirectURL('oauth2');
  const state = createOAuthState();
  const parameters = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    prompt: 'select_account',
    include_granted_scopes: 'true',
    state
  });

  let resultUrl;
  try {
    resultUrl = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${parameters.toString()}`,
      interactive: true
    });
  } catch (error) {
    throw Error(`${error.message || 'Google sign-in failed.'} In Google Cloud Console, authorize this exact redirect URI: ${redirectUri}. The bare https://chromiumapp.org URI does not match this extension.`);
  }
  if (!resultUrl) throw Error('Google sign-in was cancelled.');

  const result = new URL(resultUrl);
  const redirect = new URL(redirectUri);
  if (result.origin !== redirect.origin || !result.pathname.startsWith(redirect.pathname)) {
    throw Error('Google returned to an unexpected OAuth redirect. Check the extension redirect URI in Google Cloud Console.');
  }

  const response = new URLSearchParams(result.hash.slice(1));
  if (response.get('state') !== state) throw Error('Google sign-in state did not match. Please try again.');
  if (response.has('error')) {
    throw Error(response.get('error_description') || `Google sign-in failed: ${response.get('error')}`);
  }

  const accessToken = response.get('access_token');
  const expiresIn = Number(response.get('expires_in'));
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw Error('Google did not return a valid access token.');
  }

  const session = {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    tokenType: response.get('token_type') || 'Bearer',
    grantedScopes: response.get('scope') || ''
  };
  await chrome.storage.local.set({ [GOOGLE_SESSION_KEY]: session });
  return { token: accessToken, expiresAt: session.expiresAt, grantedScopes: session.grantedScopes };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === 'LOGIN_USER') {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ error: 'Only this extension can start Google sign-in.' });
      return false;
    }
    loginWithGoogle().then(sendResponse).catch(error => sendResponse({ error: error.message || 'Google sign-in failed.' }));
    return true;
  }
  if (msg?.type === 'GET_TOKEN') {
    chrome.storage.local.get([GOOGLE_SESSION_KEY], result => {
      const session = result[GOOGLE_SESSION_KEY];
      if (!session?.accessToken || session.expiresAt <= Date.now() + 30_000) {
        chrome.storage.local.remove(GOOGLE_SESSION_KEY, () => sendResponse({ error: 'Google session expired. Sign in again.' }));
        return;
      }
      sendResponse({ token: session.accessToken, expiresAt: session.expiresAt, grantedScopes: session.grantedScopes });
    });
    return true;
  }
  if (msg?.type === 'CLEAR_TOKEN') {
    chrome.storage.local.remove(GOOGLE_SESSION_KEY, () => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'LOGOUT_USER') {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ error: 'Only this extension can sign out the current user.' });
      return false;
    }
    chrome.storage.local.remove(GOOGLE_SESSION_KEY, () => sendResponse({ ok: true }));
    return true;
  }
});
