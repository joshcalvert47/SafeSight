// popup.js

import { initializeApp } from "./firebase/firebase-app.js";
import { getAuth, signOut, onAuthStateChanged, getIdToken } from "./firebase/firebase-auth.js";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyAJ79A9ZSXT-MLyTlSlPC5bWk2x2eo2qAo",
  authDomain: "safesight-3b61f.firebaseapp.com",
  projectId: "safesight-3b61f",
  storageBucket: "safesight-3b61f.firebasestorage.app",
  messagingSenderId: "816580635380",
  appId: "1:816580635380:web:738203cf7a5900034f8ca1"
};

const app = initializeApp(FIREBASE_CONFIG);
const auth = getAuth(app);
const skinFilterCheck = document.getElementById('skinFilter');
const blurAllCheck = document.getElementById('blurAll');
const sensitivityRange = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivityVal');
const statScanned = document.getElementById('statScanned');
const statBlocked = document.getElementById('statBlocked');
const profileBtn = document.getElementById('profileBtn');
const signInBtn = document.getElementById('signInBtn');
const profileMenu = document.getElementById('profileMenu');
const userName = document.getElementById('userName');
const userAvatar = document.getElementById('userAvatar');
const userStatusDot = document.getElementById('userStatusDot');

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
const WORKER_URL = "https://safesight.funbyte.net";
const ACCOUNT_KEYS = ['clientId', 'deviceId', 'accountEmail', 'accountName', 'accountReady', 'firebaseUid'];

let currentUser = null;
let idToken = null;

async function refreshToken() {
    if (currentUser) {
        idToken = await getIdToken(currentUser, true);
    }
    return idToken;
}

onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (!user) {
        idToken = null;
        return;
    }
    idToken = await getIdToken(user, true);
    // Auto-register account on server after Google sign-in
    await registerWithGoogle(user);
    renderAccountUI();
});

async function registerWithGoogle(user) {
    const res = await chrome.storage.local.get(ACCOUNT_KEYS);
    if (res.accountReady) return; // Already registered

    const email = user.email.toLowerCase();
    const accountName = user.displayName || email.split('@')[0];
    const firstName = (user.displayName || '').split(' ')[0] || '';
    const lastName = ((user.displayName || '').split(' ').slice(1).join(' ') || '').trim() || '';

    try {
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
    const res = await chrome.storage.local.get(['clientId', 'accountReady']);
    if (res.clientId && res.accountReady) {
        return res.clientId;
    }
    // Don't open login page — let the user click the sign-in button in the popup
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
                const r = await fetch(WORKER_URL + '/api/verify', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + idToken
                    },
                    body: JSON.stringify({ id: (await chrome.storage.local.get('clientId'))?.clientId || '', action })
                });
                const j = await r.json();
                if (j.ok) return true;
                // If token verification fails, fall back to PIN
            } catch (e) {
                // Fall back to PIN
            }
        }
    }

    // Fallback: PIN verification
    const res = await chrome.storage.local.get(['clientId', 'accountReady']);
    if (!res.clientId || !res.accountReady) {
        alert('Registration is required first.');
        chrome.tabs.create({ url: chrome.runtime.getURL('login.html') });
        return false;
    }
    const pin = prompt('Enter your PIN to ' + action + ':');
    if (!pin) return false;
    try {
        const r = await fetch(WORKER_URL + '/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: res.clientId, pin: pin.trim(), action })
        });
        const j = await r.json();
        if (j.ok) return true;
        if (j.error === 'account_pending') return lockedAlert();
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
const blockSiteInput = document.getElementById('blockSiteInput');
const blockSiteAdd = document.getElementById('blockSiteAdd');
const blockSiteList = document.getElementById('blockSiteList');
const blocklistNote = document.getElementById('blocklistNote');
let blockDefaults = [];
let blockDefaultsLoaded = false;
let blockUser = [];
let blockRemoved = [];

function normalizeSite(entry) {
    if (typeof entry !== 'string') return null;
    let s = entry.trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[\/?#]/)[0];
    s = s.split('@').pop().split(':')[0];
    s = s.replace(/^\*\\.?/, '').replace(/^www\./, '').replace(/\.$/, '');
    return s.includes('.') ? s : null;
}

async function fetchDefaultBlocklist() {
    try {
        const res = await chrome.storage.local.get(['blocklistDefaults']);
        if (Array.isArray(res.blocklistDefaults)) return res.blocklistDefaults;
    } catch (e) { }
    try {
        const resp = await fetch(chrome.runtime.getURL('blocklist.json'));
        const data = await resp.json();
        const list = Array.isArray(data) ? data : ((data && data.sites) || []);
        return list.map(normalizeSite).filter(Boolean);
    } catch (e) { { } }
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
    blockSiteList.innerHTML = '';
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
        remove.title = 'Remove from block list';
        remove.onclick = () => removeBlockSite(entry);
        li.appendChild(remove);
        blockSiteList.appendChild(li);
    });
    blocklistNote.textContent = blockDefaultsLoaded
        ? blockSiteList.children.length + ' added • ' + blockDefaults.length + ' default site(s) locked from blocklist.json'
        : 'Could not load blocklist.json';
}

async function saveBlocklist() {
    await chrome.storage.local.set({ blocklistUser: blockUser, blocklistRemoved: blockRemoved });
}

async function removeBlockSite(entry) {
    if (!(await guardDestructive('remove "' + entry.site + '" from the block list'))) return;
    blockUser = blockUser.filter((s) => s !== entry.site);
    await saveBlocklist();
    renderBlocklist();
}

async function addBlockSite() {
    const site = normalizeSite(blockSiteInput.value);
    if (!site) {
        blockSiteInput.value = '';
        blockSiteInput.placeholder = 'e.g. example.com';
        return;
    }
    const coveredByDefault = blockDefaults.some((d) => site === d || site.endsWith('.' + d));
    const inList = blockUser.includes(site);
    if (coveredByDefault || inList) {
        blockSiteInput.value = '';
        blockSiteInput.placeholder = 'Already blocked';
        setTimeout(() => { blockSiteInput.placeholder = 'example.com'; }, 1500);
        return;
    }
    blockUser.push(site);
    blockSiteInput.value = '';
    await saveBlocklist();
    renderBlocklist();
}

if (blockSiteAdd) blockSiteAdd.onclick = addBlockSite;
if (blockSiteInput) {
    blockSiteInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addBlockSite();
    });
}

(async function initBlocklist() {
    if (!blockSiteList) return;
    const defaults = await fetchDefaultBlocklist();
    blockDefaultsLoaded = Array.isArray(defaults);
    blockDefaults = blockDefaultsLoaded ? defaults : [];
    try {
        const res = await chrome.storage.local.get(BLOCKLIST_KEYS);
        blockUser = Array.isArray(res.blocklistUser) ? res.blocklistUser : [];
        blockRemoved = Array.isArray(res.blocklistRemoved) ? res.blocklistRemoved : [];
    } catch (e) { }
    renderBlocklist();
})();


function getSensitivityLabel(val) {
    val = parseInt(val);
    if (isNaN(val)) return 'Standard (4)';
    if (val <= 3) return `Relaxed (${val})`;
    if (val <= 6) return `Standard (${val})`;
    return `Strict (${val})`;
}

function statusClass(status) {
    return 'status-dot';
}

function statusLabel(status) {
    return 'Active';
}

async function renderAccountUI() {
    const res = await chrome.storage.local.get(['clientId', 'accountReady', 'accountName', 'accountEmail']);
    const signedIn = !!(res.clientId && res.accountReady && res.accountName);

    closeProfileMenu();
    if (!signedIn) {
        profileBtn.style.display = 'none';
        signInBtn.style.display = 'inline-flex';
        return;
    }

    signInBtn.style.display = 'none';
    profileBtn.style.display = 'flex';

    const name = res.accountName;
    const initial = name.charAt(0).toUpperCase();

    userName.textContent = name;
    userAvatar.textContent = initial;
    userStatusDot.title = 'Active';

    document.getElementById('menuAvatar').textContent = initial;
    document.getElementById('menuName').textContent = name;
    document.getElementById('menuEmail').textContent = res.accountEmail || '';
    document.getElementById('menuStatusText').textContent = 'Active';
}

function closeProfileMenu() {
    if (!profileMenu) return;
    profileMenu.style.display = 'none';
    if (profileBtn) profileBtn.setAttribute('aria-expanded', 'false');
}

if (profileBtn) {
    profileBtn.onclick = async (e) => {
        e.stopPropagation();
        const open = profileMenu.style.display === 'block';
        profileMenu.style.display = open ? 'none' : 'block';
        profileBtn.setAttribute('aria-expanded', String(!open));
    };
}

if (profileMenu) profileMenu.onclick = (e) => e.stopPropagation();
document.addEventListener('click', closeProfileMenu);

if (signInBtn) {
    // MV3 CSP blocks Firebase's signInWithPopup (it loads
    // https://apis.google.com/js/api.js), and an interactive OAuth window would
    // close this popup mid-flow anyway. Sign-in lives on login.html, which runs
    // the flow through chrome.identity; the storage listener below refreshes
    // this UI when the account appears.
    signInBtn.onclick = () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('login.html') });
    };
}

const menuAccount = document.getElementById('menuAccount');
if (menuAccount) {
    menuAccount.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('login.html') });
}

const menuSignOut = document.getElementById('menuSignOut');
if (menuSignOut) {
    menuSignOut.onclick = async () => {
        if (!confirm('Sign out of SafeSight on this device?\n\nFilters keep running, but you will need to sign in again to manage them.')) return;
        await signOut(auth);
        await chrome.storage.local.remove(['clientId', 'deviceId', 'accountEmail', 'accountName', 'accountReady', 'firebaseUid']);
        await renderAccountUI();
    };
}

chrome.storage.local.get(['skinFilter', 'blurAll', 'sensitivity', 'scannedCount', 'blockedCount'], (res) => {
    skinFilterCheck.checked = !!res.skinFilter;
    blurAllCheck.checked = !!res.blurAll;
    const sens = res.sensitivity ?? 4;
    sensitivityRange.value = sens;
    sensitivityVal.innerText = getSensitivityLabel(sens);
    statScanned.innerText = res.scannedCount || 0;
    statBlocked.innerText = res.blockedCount || 0;
});

renderAccountUI();

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.scannedCount) statScanned.innerText = changes.scannedCount.newValue;
    if (changes.blockedCount) statBlocked.innerText = changes.blockedCount.newValue;
    if (changes.accountName || changes.accountEmail || changes.accountReady || changes.clientId) {
        renderAccountUI();
    }
});

skinFilterCheck.onchange = async () => {
    if (!skinFilterCheck.checked) {
        if (accountLocked()) { skinFilterCheck.checked = true; lockedAlert(); return; }
        if (!(await guardDestructive('disable the skin filter'))) { skinFilterCheck.checked = true; return; }
    }
    chrome.storage.local.set({ skinFilter: skinFilterCheck.checked });
};

blurAllCheck.onchange = async () => {
    if (!blurAllCheck.checked) {
        if (accountLocked()) { blurAllCheck.checked = true; lockedAlert(); return; }
        if (!(await guardDestructive('disable blur-all'))) { blurAllCheck.checked = true; return; }
    }
    chrome.storage.local.set({ blurAll: blurAllCheck.checked });
};

sensitivityRange.oninput = () => {
    const val = sensitivityRange.value;
    sensitivityVal.innerText = getSensitivityLabel(val);
};

sensitivityRange.onchange = async () => {
    if (accountLocked()) {
        sensitivityRange.disabled = true;
        sensitivityVal.innerText = getSensitivityLabel(sensitivityRange.value);
        lockedAlert();
        return;
    }
    chrome.storage.local.set({ sensitivity: parseInt(sensitivityRange.value) });
};

(async function start() {
    ensureRegistered();
})();
