# MailScope — Gmail App & Link Detector

A Manifest V3 Chrome extension with a dark magenta and royal-purple glass side panel. It imports the actual Google Linked apps list from the user's Google Account page, shows each app's official name/icon and individual manage link, and scans every Gmail result page across Primary, Promotions, Updates, Social, and Spam in one action. Each category has isolated selection and confirmed Trash actions; Delete All also paginates the complete category before moving messages. The profile menu contains Settings and Logout, and the UI keeps message data on the device.

Detected links are normalized to their site domain, Google-owned hosts and known email-security redirects are filtered, and results are sorted alphabetically into Apps and heuristic Games groups. This is a useful-mail-links scan, not a complete app inventory.

## Important limitation

The Google Linked apps list is loaded only after the user chooses **Sync linked apps** and grants optional access to `myaccount.google.com`. It uses the Google Account page's current internal `batchexecute` RPCs to fetch the list and revoke one app at a time after confirmation. Google does not document these RPCs as a public API, so a Google page/API change may require an update. The extension uses the Google session already signed in to the user's Chrome profile; it does not require a separate Webmatrices signup. Gmail link detections remain a separate list.

## Setup

1. Open Google Cloud Console and create/select a project.
2. Enable the **Gmail API**.
3. Configure the OAuth consent screen for your intended users.
4. Set up the OAuth consent screen and add tester accounts while the project is in testing mode.
5. Keep a stable extension ID for all testers (normally by distributing the same Chrome Web Store item). The login flow uses `chrome.identity.getRedirectURL('oauth2')`, which returns `https://<extension-id>.chromiumapp.org/oauth2`.
6. Authorize that exact extension callback URI for the OAuth client in Google Cloud Console. The supplied bare `https://chromiumapp.org` redirect is not the URL Chrome Identity listens for and will cause `redirect_uri_mismatch` unless the client setup is corrected.
7. Never put an OAuth client secret in the extension. It is a public package and every user can extract it. Rotate any client secret that has been pasted into chat or source control.
8. In Chrome open `chrome://extensions`.
9. Enable **Developer mode** → **Load unpacked** → select this folder.
10. Click **Sign in with Google**, choose the account, and approve the requested scopes.

## Permissions

- `identity`: Google sign-in/token handling.
- `gmail.readonly`: read Gmail messages for link detection.
- `gmail.modify`: move selected messages to Trash. Permanent Gmail deletion requires the broader restricted `https://mail.google.com/` scope and is not requested.
- `openid` and `profile`: show the signed-in Google account's basic profile photo when available.
- `scripting` and optional `https://myaccount.google.com/*`: import the Linked apps page only after the user requests the sync and grants access.
- `sidePanel`: full-height Chrome side panel UI.
- `identity`: `launchWebAuthFlow` login with `prompt=select_account`; short-lived access tokens are stored locally until expiry.

## Safety notes

- The extension does not send email contents to an external server.
- App logos are fetched from Google's favicon service using the detected domain only; email content is not included in those requests.
- OAuth tokens are handled by Chrome's identity API.
- The requested implicit `response_type=token` flow does not issue a refresh token; users must sign in again when the access token expires. Google recommends authorization-code + PKCE for production OAuth clients.
- Messages moved to Trash can be restored until the user empties Trash.
- App/service entries are inferred from Gmail links; moving related messages to Trash does not unlink or delete the third-party account.
- Apps are reviewed one card at a time; mail selection and bulk Trash actions are isolated to each Gmail category panel.
- The imported linked-app names, icon URLs, and Google management links are cached locally with `chrome.storage.local`.
- Users need to be signed in to the Google Account they want to manage in Chrome; no developer's Gmail account is hardcoded for linked-app operations.
- Chrome icon sizes are generated from `icons/output-onlinepngtools.png` by `scripts/generate-icons.ps1`.
- The supplied logo is background-cleared into a transparent PNG and used directly by the extension; the current MV3 side panel uses native HTML/CSS/JavaScript, so no remote React/Tailwind/Framer Motion runtime is loaded.
- Review the OAuth consent screen/scopes before publishing or distributing the extension.
