// popup.js

// Element references - defined globally but initialized in start()
let skinFilterCheck, blurAllCheck, resetStatsBtn, sensitivityRange, sensitivityVal, statScanned, statBlocked;

// ---------------------------------------------------------------------------
// Platform split
// ---------------------------------------------------------------------------
let isIOS = null;

async function detectIOS() {
    if (isIOS !== null) return isIOS;
    
    const iosUserAgent = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    
    try {
        const info = await chrome.runtime.getPlatformInfo();
        const platform = String(info?.os || '').toLowerCase();
        isIOS = iosUserAgent || platform === 'ios';
    } catch (e) {
        isIOS = iosUserAgent;
    }
    return isIOS;
}

function getStorage(keys) {
    return new Promise((resolve) => {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
    });
}

function sendToBackground(message) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage(message, (response) => {
                void chrome.runtime.lastError;
                resolve(response || null);
            });
        } catch (e) { resolve(null); }
    });
}

async function saveSetting(values) {
    try {
        const res = await sendToBackground({ type: 'PUSH_SETTINGS', values });
        if (res && res.ok) return;
    } catch (e) { }
    await chrome.storage.local.set(values);
}

// ---------------------------------------------------------------------------
// Status panel
// ---------------------------------------------------------------------------
const ACCOUNT_KEYS = ['clientId', 'deviceId', 'accountEmail', 'accountName', 'accountReady', 'firebaseUid'];

const STATUS_KEYS = [
    'skinFilter', 'blurAll', 'sensitivity',
    'blocklistUser', 'blocklistDefaults',
    'filtersEnabled',
    'scannedCount', 'blockedCount'
];

function setStatusText(id, text) {
    const element = document.getElementById(id);
    if (element) element.textContent = text;
}

function renderStatus(res) {
    const blur = !!res.blurAll;
    const active = res.filtersEnabled !== false;
    const parts = ['NSFW'];
    if (blur) parts.push('blur all');

    const dot = document.getElementById('statusDot');
    if (dot) dot.classList.toggle('is-on', active);
    setStatusText('statusTitle', active ? 'Filtering in Safari' : 'Filtering is off');

    setStatusText('stFilter', active ? 'On — ' + parts.join(' + ') : 'Off');
    setStatusText('stSkin', res.skinFilter ? 'On' : 'Off');
    setStatusText('stSensitivity', getSensitivityLabel(res.sensitivity ?? 4));

    const userSites = Array.isArray(res.blocklistUser) ? res.blocklistUser.length : 0;
    const builtIn = Array.isArray(res.blocklistDefaults) ? res.blocklistDefaults.length : 0;
    setStatusText('stSites', builtIn ? userSites + ' + ' + builtIn + ' built-in' : String(userSites));

    setStatusText('stStats', (res.scannedCount || 0) + ' / ' + (res.blockedCount || 0));

    renderAccountButton(res);
}

// Corner account entry: unregistered devices get "Sign in" (opens
// login.html); registered ones show who this device belongs to and open the
// same page in its manage-account view.
function renderAccountButton(res) {
    const btn = document.getElementById('accountBtn');
    const resetBtn = document.getElementById('resetPwdBtn');
    if (!btn) return;
    const signedIn = !!(res && res.accountReady);
    btn.classList.toggle('is-signed-in', signedIn);
    if (signedIn) {
        btn.textContent = res.accountName || 'Account';
        btn.title = 'Signed in' + (res.accountEmail ? ' as ' + res.accountEmail : '') + ' — open account settings';
        if (resetBtn) resetBtn.style.display = 'inline-block';
    } else {
        btn.textContent = 'Sign in';
        btn.title = 'Register or manage this device';
        if (resetBtn) resetBtn.style.display = 'none';
    }
}

async function handleSignIn() {
    try {
        await signInWithPopup(firebaseAuth, googleProvider);
    } catch (err) {
        if (err.code !== 'auth/popup-closed-by-user') {
            console.error('Sign in error:', err);
            alert('Sign in failed. Please try again.');
        }
    }
}

async function openResetPassword() {
    const loginUrl = chrome.runtime.getURL('login.html') + '#reset';
    try {
        const created = chrome.tabs.create({ url: loginUrl });
        if (created && typeof created.then === 'function') await created;
    } catch (e) {
        window.open(loginUrl, '_blank');
    }
}

function syncControls(res) {
    if (skinFilterCheck) skinFilterCheck.checked = !!res.skinFilter;
    if (blurAllCheck) blurAllCheck.checked = !!res.blurAll;
    const sens = res.sensitivity ?? 4;
    if (sensitivityRange) sensitivityRange.value = sens;
    if (sensitivityVal) sensitivityVal.innerText = getSensitivityLabel(sens);
}

async function initStatusPanel() {
    try {
        await sendToBackground({ type: 'SYNC_FROM_APP' });
        const status = await getStorage([...STATUS_KEYS, 'accountEmail', 'accountName', 'accountReady', 'clientId']);
        if (isIOS && !status.accountReady) {
            alert('No account on this device yet.\n\nTap "Sign in" in the popup to register it, or create one in the SafeSight app.');
        }
        syncControls(status);
        renderStatus(status);
    } catch (e) {
        console.error('Failed to init status panel', e);
    }
}

// ---------------------------------------------------------------------------
// Admin server
// ---------------------------------------------------------------------------
const WORKER_URL = "https://safesight.funbyte.net";

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, getIdToken, disconnect } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAJ79A9ZSXT-MLyTlSlPC5bWk2x2eo2qAo",
  authDomain: "safesight-3b61f.firebaseapp.com",
  projectId: "safesight-3b61f",
  storageBucket: "safesight-3b61f.firebasestorage.app",
  messagingSenderId: "816580635380",
  appId: "1:816580635380:web:738203cf7a5900034f8ca1"
};

const firebaseApp = initializeApp(FIREBASE_CONFIG);
const firebaseAuth = getAuth(firebaseApp);
const googleProvider = new GoogleAuthProvider();

let currentUser = null;
let idToken = null;

async function refreshToken() {
    if (currentUser) {
        idToken = await getIdToken(currentUser, true);
    }
    return idToken;
}

onAuthStateChanged(firebaseAuth, async (user) => {
    currentUser = user;
    if (!user) {
        idToken = null;
        return;
    }
    idToken = await getIdToken(user, true);
    // Auto-register account on server after Google sign-in
    await registerWithGoogle(user);
    renderAccountButton(await getStorage([...STATUS_KEYS, 'accountEmail', 'accountName', 'accountReady', 'clientId']));
});

async function registerWithGoogle(user) {
    const res = await getStorage(ACCOUNT_KEYS);
    if (res.accountReady) return; // Already registered

    const email = user.email.toLowerCase();
    const accountName = user.displayName || email.split('@')[0];
    const firstName = (user.displayName || '').split(' ')[0] || '';
    const lastName = ((user.displayName || '').split(' ').slice(1).join(' ') || '').trim() || '';

    try {
        const id = crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now().toString(36);
        const ua = navigator.userAgent;
        const device = 'Safari / ' + (ua.includes('Mac') ? 'macOS' : ua.includes('Windows') ? 'Windows' : ua.includes('Linux') ? 'Linux' : 'iOS');
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
                firebaseUid: user.uid,
                googleSignIn: true
            })
        });

        const j = await r.json().catch(() => ({}));

        if (r.ok && j.id) {
            await chrome.storage.local.set({
                clientId: j.id,
                deviceId: id,
                accountEmail: j.email || email,
                accountName: j.accountName || accountName,
                accountReady: true,
                firebaseUid: user.uid
            });
        }
    } catch (err) {
        console.error('Auto-register error:', err);
    }
}

async function ensureRegistered() {
    try {
        const res = await chrome.storage.local.get(['clientId', 'accountReady']);
        if (res.clientId && res.accountReady) {
            return res.clientId;
        }

        const loginUrl = chrome.runtime.getURL('login.html');
        try {
            await chrome.tabs.create({ url: loginUrl });
        } catch (e) {
            window.open(loginUrl, '_blank');
        }
    } catch (e) {
        console.error('Registration check failed', e);
    }
    return null;
}

function accountLocked() {
    return false;
}

async function lockedAlert() {
    return false;
}

async function guardDestructive(action) {
    if (accountLocked()) return lockedAlert();

    // Try Firebase token first
    if (currentUser) {
        await refreshToken();
        if (idToken) {
            try {
                const res = await chrome.storage.local.get('clientId');
                const r = await fetch(WORKER_URL + '/api/verify', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + idToken
                    },
                    body: JSON.stringify({ id: res.clientId || '', action })
                });
                const j = await r.json();
                if (j.ok) return true;
            } catch (e) {
                // Fall back to PIN
            }
        }
    }

    // Fallback: PIN verification
    try {
        const res = await chrome.storage.local.get(['clientId', 'accountReady']);
        if (!res.clientId || !res.accountReady) {
            alert('Registration is required first.');
            const loginUrl = chrome.runtime.getURL('login.html');
            try {
                await chrome.tabs.create({ url: loginUrl });
            } catch (e) {
                window.open(loginUrl, '_blank');
            }
            return false;
        }
        const pin = prompt('Enter your PIN to ' + action + ':');
        if (!pin) return false;
        const r = await fetch(WORKER_URL + '/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: res.clientId, pin: pin.trim(), action })
        });
        const j = await r.json();
        if (j.ok) return true;
        alert(j.locked ? 'Too many attempts — locked for ' + Math.ceil((j.retry || 300) / 60) + ' min.' : 'Incorrect PIN.');
    } catch (e) {
        alert('Could not reach the SafeSight server — try again later.');
    }
    return false;
}

// ---------------------------------------------------------------------------
// Blocked sites
// ---------------------------------------------------------------------------
const BLOCKLIST_KEYS = ['blocklistDefaults', 'blocklistUser', 'blocklistRemoved'];
let blockDefaults = [], blockDefaultsLoaded = false, blockUser = [], blockRemoved = [];

function normalizeSite(entry) {
    if (typeof entry !== 'string') return null;
    let s = entry.trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[\/?#]/)[0];
    s = s.split('@').pop().split(':')[0];
    s = s.replace(/^\*\.?/, '').replace(/^www\./, '').replace(/\.$/, '');
    return s.includes('.') ? s : null;
}

async function fetchDefaultBlocklist() {
    try {
        const res = await chrome.storage.local.get(['blocklistDefaults']);
        if (Array.isArray(res.blocklistDefaults)) return res.blocklistDefaults;
        const resp = await fetch(chrome.runtime.getURL('blocklist.json'));
        const data = await resp.json();
        const list = Array.isArray(data) ? data : ((data && data.sites) || []);
        return list.map(normalizeSite).filter(Boolean);
    } catch (e) { return null; }
}

function effectiveBlockSites() {
    const seen = new Set();
    const entries = [];
    blockUser.forEach((site) => {
        if (!seen.has(site)) {
            seen.add(site);
            entries.push({ site, isDefault: false });
        }
    });
    return entries;
}

function renderBlocklist() {
    const listEl = document.getElementById('blockSiteList');
    if (!listEl) return;
    listEl.innerHTML = '';
    effectiveBlockSites().forEach((entry) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'blocklist-site';
        name.textContent = entry.site;
        li.appendChild(name);
        if (entry.isDefault) {
            const tag = document.createElement('span');
            tag.className = 'blocklist-tag';
            tag.textContent = 'default';
            li.appendChild(tag);
        }
        const remove = document.createElement('button');
        remove.className = 'blocklist-remove';
        remove.textContent = '×';
        remove.onclick = () => removeBlockSite(entry);
        li.appendChild(remove);
        listEl.appendChild(li);
    });
    const noteEl = document.getElementById('blocklistNote');
    if (noteEl) {
        noteEl.textContent = blockDefaultsLoaded
            ? listEl.children.length + ' added • ' + blockDefaults.length + ' default site(s) locked from blocklist.json'
            : 'Could not load blocklist.json';
    }
}

async function removeBlockSite(entry) {
    if (!(await detectIOS()) && !(await guardDestructive('remove "' + entry.site + '" from the block list'))) return;
    blockUser = blockUser.filter((s) => s !== entry.site);
    await saveSetting({ blocklistUser: blockUser, blocklistRemoved: blockRemoved });
    renderBlocklist();
}

async function addBlockSite() {
    const input = document.getElementById('blockSiteInput');
    if (!input) return;
    const site = normalizeSite(input.value);
    if (!site) {
        input.value = '';
        return;
    }
    const coveredByDefault = blockDefaults.some((d) => site === d || site.endsWith('.' + d));
    const inList = blockUser.includes(site);
    if (coveredByDefault || inList) {
        input.value = '';
        input.placeholder = 'Already blocked';
        setTimeout(() => { input.placeholder = 'example.com'; }, 1500);
        return;
    }
    blockUser.push(site);
    input.value = '';
    await saveSetting({ blocklistUser: blockUser, blocklistRemoved: blockRemoved });
    renderBlocklist();
}

function getSensitivityLabel(val) {
    val = parseInt(val);
    if (isNaN(val)) return 'Standard (4)';
    if (val <= 3) return `Relaxed (${val})`;
    if (val <= 6) return `Standard (${val})`;
    return `Strict (${val})`;
}

// ---------------------------------------------------------------------------
async function start() {
    try {
        skinFilterCheck = document.getElementById('skinFilter');
        blurAllCheck = document.getElementById('blurAll');
        resetStatsBtn = document.getElementById('resetStats');
        sensitivityRange = document.getElementById('sensitivity');
        sensitivityVal = document.getElementById('sensitivityVal');
        statScanned = document.getElementById('statScanned');
        statBlocked = document.getElementById('statBlocked');

        isIOS = await detectIOS();
        document.body.classList.add(isIOS ? 'platform-ios' : 'platform-mac');

        const accountBtn = document.getElementById('accountBtn');
        if (accountBtn) accountBtn.onclick = handleSignIn;
        const resetPwdBtn = document.getElementById('resetPwdBtn');
        if (resetPwdBtn) resetPwdBtn.onclick = openResetPassword;

        await initStatusPanel();
        const defaults = await fetchDefaultBlocklist();
        blockDefaultsLoaded = Array.isArray(defaults);
        blockDefaults = blockDefaultsLoaded ? defaults : [];
        const res = await getStorage(BLOCKLIST_KEYS);
        blockUser = Array.isArray(res.blocklistUser) ? res.blocklistUser : [];
        blockRemoved = Array.isArray(res.blocklistRemoved) ? res.blocklistRemoved : [];
        renderBlocklist();

        const config = await getStorage(['skinFilter', 'blurAll', 'sensitivity', 'scannedCount', 'blockedCount']);
        if (skinFilterCheck) skinFilterCheck.checked = !!config.skinFilter;
        if (blurAllCheck) blurAllCheck.checked = !!config.blurAll;
        const sens = config.sensitivity ?? 4;
        if (sensitivityRange) sensitivityRange.value = sens;
        if (sensitivityVal) sensitivityVal.innerText = getSensitivityLabel(sens);
        if (statScanned) statScanned.innerText = config.scannedCount || 0;
        if (statBlocked) statBlocked.innerText = config.blockedCount || 0;

        if (document.getElementById('blockSiteAdd')) {
            document.getElementById('blockSiteAdd').onclick = addBlockSite;
        }
        const siteInput = document.getElementById('blockSiteInput');
        if (siteInput) {
            siteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBlockSite(); });
        }
        if (resetStatsBtn) {
            resetStatsBtn.onclick = async () => {
                chrome.runtime.sendMessage({ type: 'RESET_STATS' });
                if (statScanned) statScanned.innerText = 0;
                if (statBlocked) statBlocked.innerText = 0;
            };
        }

        if (skinFilterCheck) {
            skinFilterCheck.onchange = async () => {
                if (!skinFilterCheck.checked) {
                    if (accountLocked()) { skinFilterCheck.checked = true; await lockedAlert(); return; }
                    if (!(await detectIOS()) && !(await guardDestructive('disable the skin filter'))) { skinFilterCheck.checked = true; return; }
                }
                await saveSetting({ skinFilter: skinFilterCheck.checked });
            };
        }

        if (blurAllCheck) {
            blurAllCheck.onchange = async () => {
                if (!blurAllCheck.checked) {
                    if (accountLocked()) { blurAllCheck.checked = true; await lockedAlert(); return; }
                    if (!(await detectIOS()) && !(await guardDestructive('disable blur-all'))) { blurAllCheck.checked = true; return; }
                }
                await saveSetting({ blurAll: blurAllCheck.checked });
            };
        }

        if (sensitivityRange) {
            sensitivityRange.oninput = () => {
                if (sensitivityVal) sensitivityVal.innerText = getSensitivityLabel(sensitivityRange.value);
            };
            sensitivityRange.onchange = async () => {
                if (accountLocked()) {
                    sensitivityRange.disabled = true;
                    if (sensitivityVal) sensitivityVal.innerText = getSensitivityLabel(sensitivityRange.value);
                    await lockedAlert();
                    return;
                }
                await saveSetting({ sensitivity: parseInt(sensitivityRange.value) });
            };
        }

        chrome.storage.onChanged.addListener((changes) => {
            if (changes.scannedCount && statScanned) statScanned.innerText = changes.scannedCount.newValue;
            if (changes.blockedCount && statBlocked) statBlocked.innerText = changes.blockedCount.newValue;
            if (changes.skinFilter || changes.blurAll || changes.sensitivity ||
                changes.blocklistUser || changes.blocklistDefaults ||
                changes.scannedCount || changes.blockedCount) {
                getStorage([...STATUS_KEYS, 'accountEmail', 'accountName', 'accountReady']).then((res) => {
                    syncControls(res);
                    renderStatus(res);
                });
            }
        });

    } catch (e) {
        console.error('Critical failure in popup startup:', e);
    }
}

document.addEventListener('DOMContentLoaded', start);
