import { initializeApp } from "./firebase/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithCredential } from "./firebase/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAJ79A9ZSXT-MLyTlSlPC5bWk2x2eo2qAo",
  authDomain: "safesight-3b61f.firebaseapp.com",
  projectId: "safesight-3b61f",
  storageBucket: "safesight-3b61f.firebasestorage.app",
  messagingSenderId: "816580635380",
  appId: "1:816580635380:web:738203cf7a5900034f8ca1"
};

// Firebase Auth is initialized for token verification,
// but Google Sign-In uses chrome.identity.launchWebAuthFlow in MV3.
const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);

const WORKER_URL = "https://safesight.funbyte.net";

// Google OAuth via chrome.identity (Chrome MV3)
const GOOGLE_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

// Required by Google when the OAuth client type is "Web application". Copy the
// Client secret from Google Cloud Console -> APIs & Services -> Credentials and
// paste it here. Leave empty for client types that use PKCE only (Chrome app).
const GOOGLE_OAUTH_CLIENT_SECRET = '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';

const googleBtn = document.getElementById('googleBtn');
const googleView = document.getElementById('googleView');
const loginMessage = document.getElementById('loginMessage');

const ACCOUNT_KEYS = ['clientId', 'deviceId', 'accountEmail', 'accountName', 'accountReady', 'firebaseUid'];

const pinBox = document.getElementById('pinBox');
const pinSubtitle = document.getElementById('pinSubtitle');
const copyPinBtn = document.getElementById('copyPinBtn');
const pinDoneBtn = document.getElementById('pinDoneBtn');
const mgName = document.getElementById('mgName');
const mgEmail = document.getElementById('mgEmail');
const mgDevices = document.getElementById('mgDevices');
const mgForget = document.getElementById('mgForget');
const mgClose = document.getElementById('mgClose');
const manageMessage = document.getElementById('manageMessage');

function showMessage(el, text, type) {
    el.textContent = text;
    el.className = type === 'error' ? 'msg-error' : type === 'info' ? 'msg-info' : 'msg-success';
    el.style.display = 'block';
}

function showSection(id) {        ['googleView', 'pinView', 'manageView'].forEach((v) => {
        const el = document.getElementById(v);
        if (el) el.classList.toggle('active', v === id);
    });
}

async function getAccount() {
    return chrome.storage.local.get(ACCOUNT_KEYS);
}

async function saveAccount(fields) {
    await chrome.storage.local.set(fields);
}

function setBusy(busy, label, btn, textEl, spinEl) {
    btn.disabled = busy;
    spinEl.style.display = busy ? 'inline-block' : 'none';
    if (label) textEl.textContent = label;
}

// ---------------------------------------------------------------------------
// Google Sign-In via chrome.identity (Chrome MV3)
// ---------------------------------------------------------------------------
async function googleSignInViaIdentity() {
    const manifest = chrome.runtime.getManifest();
    const oauth2 = manifest.oauth2;
    if (!oauth2 || !oauth2.client_id || oauth2.client_id.includes('YOUR_GOOGLE_OAUTH')) {
        throw new Error('Google OAuth client ID not configured in manifest. Replace YOUR_GOOGLE_OAUTH_CLIENT_ID with your actual OAuth 2.0 Client ID from Google Cloud Console.');
    }

    // PKCE: RFC 7636 requires a 43-128 char verifier, and the S256 challenge
    // must be BASE64URL(SHA-256(verifier)). Google rejects hex-encoded
    // challenges or short verifiers with "Invalid code verifier".
    const codeVerifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    const state = crypto.randomUUID ? crypto.randomUUID() : 'state-' + Date.now().toString(36);
    const redirectUri = chrome.identity.getRedirectURL();
    const redirectHint = ' If Google shows Error 400: redirect_uri_mismatch, add "' + redirectUri + '" exactly (with the trailing slash) to "Authorized redirect URIs" for this OAuth client in Google Cloud Console -> APIs & Services -> Credentials.';

    const authUrl = new URL(GOOGLE_OAUTH_AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', oauth2.client_id);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', oauth2.scopes.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    const token = await new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
            { url: authUrl.toString(), interactive: true },
            (redirectUrl) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message + redirectHint));
                    return;
                }
                if (!redirectUrl) {
                    reject(new Error('No redirect URL returned.' + redirectHint));
                    return;
                }
                // Parse the authorization code from the redirect
                const url = new URL(redirectUrl);
                const code = url.searchParams.get('code');
                if (!code) {
                    reject(new Error('No authorization code in redirect'));
                    return;
                }
                // Exchange authorization code for tokens
                const tokenBody = new URLSearchParams({
                    code,
                    client_id: oauth2.client_id,
                    redirect_uri: redirectUri,
                    grant_type: 'authorization_code',
                    code_verifier: codeVerifier
                });
                if (GOOGLE_OAUTH_CLIENT_SECRET) tokenBody.set('client_secret', GOOGLE_OAUTH_CLIENT_SECRET);
                fetch(GOOGLE_OAUTH_TOKEN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: tokenBody
                })
                .then(async (r) => {
                    const json = await r.json().catch(() => ({}));
                    if (!r.ok || json.error) {
                        const detail = json.error_description || json.error || ('HTTP ' + r.status);
                        let hint = '';
                        if (json.error === 'unauthorized_client' || json.error === 'invalid_client') {
                            hint = ' Copy the Client secret for this OAuth client (Google Cloud Console -> APIs & Services -> Credentials) into GOOGLE_OAUTH_CLIENT_SECRET at the top of chrome/login.js.';
                        }
                        throw new Error('Google rejected the sign-in: ' + detail + hint);
                    }
                    resolve(json);
                })
                .catch(reject);
            }
        );
    });

    if (!token.access_token) {
        throw new Error('No access token received from Google');
    }

    // Fetch user profile
    const profileRes = await fetch(GOOGLE_USERINFO_URL, {
        headers: { 'Authorization': 'Bearer ' + token.access_token }
    });
    if (!profileRes.ok) {
        throw new Error('Failed to fetch user profile');
    }
    const profile = await profileRes.json();

    return {
        accessToken: token.access_token,
        idToken: token.id_token,
        email: profile.email.toLowerCase(),
        displayName: profile.name || profile.email.split('@')[0],
        photoURL: profile.picture || '',
        uid: profile.sub || 'google-' + profile.sub
    };
}

async function handleGoogleSignIn(user) {
    // Convert Google OAuth tokens to a Firebase credential
    const credential = GoogleAuthProvider.credential(
        user.accessToken,
        user.idToken
    );
    let firebaseUser;
    try {
        firebaseUser = await signInWithCredential(auth, credential);
    } catch (err) {
        // User may already exist with a different provider — still proceed with profile data
        console.warn('Firebase credential sign-in issue (non-fatal):', err.message);
        firebaseUser = null;
    }

    const email = user.email.toLowerCase();
    const accountName = user.displayName || email.split('@')[0];
    const firstName = (user.displayName || '').split(' ')[0] || '';
    const lastName = ((user.displayName || '').split(' ').slice(1).join(' ') || '').trim() || '';
    const photoURL = user.photoURL || '';
    const firebaseUid = (firebaseUser && firebaseUser.user?.uid) || user.uid || 'chrome-identity-' + Date.now().toString(36);

    setBusy(true, 'Signing in…', googleBtn, googleBtn.querySelector('span'), googleBtn.querySelector('i'));

    try {
        // Register or get account on the server
        const id = crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now().toString(36);
        const ua = navigator.userAgent;
        const device = 'Chrome / ' + (ua.includes('Mac') ? 'macOS' : ua.includes('Windows') ? 'Windows' : ua.includes('Linux') ? 'Linux' : 'other');
        let version = '0.0.0';
        try { version = chrome?.runtime?.getManifest?.().version || '0.0.0'; } catch(e) {}

        const r = await fetch(WORKER_URL + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                accountName,
                firstName,
                lastName,
                phone: '',
                password: '',
                deviceId: id,
                device,
                version,
                ua: ua.slice(0, 160),
                firebaseUid,
                googleSignIn: true,
                firebaseToken: firebaseUser ? (await firebaseUser.user.getIdToken()) : null
            })
        });

        const j = await r.json().catch(() => ({}));

        if (r.ok && j.id) {
            await saveAccount({
                clientId: j.id,
                deviceId: id,
                accountEmail: j.email || email,
                accountName: j.accountName || accountName,
                accountReady: true,
                firebaseUid: firebaseUid
            });

            if (j.pin) {
                showPin(j.pin, j.rejoined
                    ? 'Welcome back — this device is reconnected to your account.'
                    : 'Account created. Save this PIN somewhere safe — you\'ll need it to manage blocked sites.');
            } else {
                fillManage();
                showSection('manageView');
                showMessage(manageMessage,
                    'Signed in successfully. SafeSight is now active on this browser.', 'success');
            }
            return true;
        }

        if (j.error === 'rate_limited') {
            showMessage(loginMessage, 'Too many attempts — wait a minute and try again.', 'error');
        } else {
            showMessage(loginMessage, 'Could not sign in. Please try again.', 'error');
        }
    } catch (err) {
        showMessage(loginMessage, 'Could not reach the SafeSight server. Check your connection and try again.', 'error');
        console.error('Google sign-in error:', err);
    } finally {
        setBusy(false, 'Sign in with Google', googleBtn, googleBtn.querySelector('span'), googleBtn.querySelector('i'));
    }
    return false;
}

googleBtn.onclick = async () => {
    try {
        // Use chrome.identity for Google OAuth in MV3
        const user = await googleSignInViaIdentity();
        await handleGoogleSignIn(user);
    } catch (err) {
        if (err.message.includes('User cancelled') || err.message.includes('cancel')) {
            // User closed the auth dialog — silent fail
            return;
        }
        showMessage(loginMessage, 'Sign in failed: ' + (err.message || 'Please try again.'), 'error');
        console.error('Google sign-in error:', err);
    }
};

// ---------------------------------------------------------------------------
// PIN reveal
// ---------------------------------------------------------------------------
function showPin(pin, subtitle) {
    pinBox.textContent = pin;
    pinSubtitle.textContent = subtitle || 'Write this down — it\'s required to manage blocked sites or change filters.';
    copyPinBtn.textContent = 'Copy PIN';
    showSection('pinView');
}

if (copyPinBtn) {
    copyPinBtn.onclick = async () => {
        try {
            await navigator.clipboard.writeText(pinBox.textContent);
            copyPinBtn.textContent = 'Copied!';
        } catch (e) {
            copyPinBtn.textContent = 'Select and copy manually';
        }
    };
}

if (pinDoneBtn) {
    pinDoneBtn.onclick = async () => {
        window.close();
        setTimeout(async () => {
            await fillManage();
            showSection('manageView');
        }, 150);
    };
}

// ---------------------------------------------------------------------------
// Manage account view
// ---------------------------------------------------------------------------
async function fillManage() {
    const res = await getAccount();
    mgName.textContent = res.accountName || '—';
    mgEmail.textContent = res.accountEmail || '—';
    const devices = res.deviceCount;
    mgDevices.textContent =
        (devices != null) ? devices + (res.deviceLimit ? ' / ' + res.deviceLimit : '') : '—';
}

if (mgForget) {
    mgForget.onclick = async () => {
        if (!confirm('Forget SafeSight on this device?\n\nFilters keep running, but you will need to sign in again to manage them.')) return;
        await chrome.storage.local.remove(ACCOUNT_KEYS);
        location.hash = '';
        location.reload();
    };
}

if (mgClose) mgClose.onclick = () => window.close();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async function init() {
    const res = await getAccount();
    const signedIn = !!res.accountReady;
    if (signedIn) {
        await fillManage();
        showSection('manageView');
    } else {
        showSection('googleView');
    }
})();
