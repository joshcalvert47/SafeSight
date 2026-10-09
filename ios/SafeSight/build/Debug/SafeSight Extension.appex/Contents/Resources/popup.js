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
    if (!btn) return;
    const signedIn = !!(res && res.accountReady);
    btn.classList.toggle('is-signed-in', signedIn);
    if (signedIn) {
        btn.textContent = res.accountName || 'Account';
        btn.title = 'Signed in' + (res.accountEmail ? ' as ' + res.accountEmail : '') + ' — open account settings';
    } else {
        btn.textContent = 'Sign in';
        btn.title = 'Register or manage this device';
    }
}

async function openLogin() {
    // Relative path with no leading slash: Chrome normalises
    // runtime.getURL('/login.html'), Safari does not guarantee it.
    const loginUrl = chrome.runtime.getURL('login.html');
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
        const status = await getStorage([...STATUS_KEYS, 'accountEmail', 'accountName', 'accountReady', 'accountStatus', 'clientId']);
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

async function ensureRegistered() {
    try {
        const res = await chrome.storage.local.get(['clientId', 'accountReady']);
        if (res.clientId && res.accountReady) {
            await refreshAccountStatus();
            return res.clientId;
        }

        // Use a relative path and try multiple opening methods
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

let accountStatus = 'approved';

async function refreshAccountStatus() {
    try {
        const res = await chrome.storage.local.get(['clientId', 'accountStatus']);
        accountStatus = res.accountStatus || 'approved';
        if (!res.clientId || accountStatus === 'approved') {
            applyAccountLock(accountStatus);
            return accountStatus;
        }
        const r = await fetch(WORKER_URL + '/api/account-status?id=' + encodeURIComponent(res.clientId));
        const j = await r.json();
        if (j.ok) {
            accountStatus = j.status || 'approved';
            await chrome.storage.local.set({ accountStatus });
            if (accountStatus === 'approved' && j.pin) {
                alert('Your SafeSight account was approved by the admin.\n\nYour PIN is:\n\n' + j.pin + '\n\nWrite it down — it\'s required to remove blocked sites or turn filters off.');
            }
        }
    } catch (e) { }
    applyAccountLock(accountStatus);
    return accountStatus;
}

function accountLocked() {
    return accountStatus !== 'approved';
}

function applyAccountLock(status) {
    const banner = document.getElementById('pendingBanner');
    if (banner) banner.style.display = status === 'approved' ? 'none' : 'block';
    if (sensitivityRange) sensitivityRange.disabled = status !== 'approved';
}

async function lockedAlert() {
    alert('Locked: this account is waiting for admin approval.\n\nNothing that weakens SafeSight can change until the admin approves it in the console.');
    return false;
}

async function guardDestructive(action) {
    if (accountLocked()) return lockedAlert();
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
        const pin = prompt('Enter the admin PIN to ' + action + ':');
        if (!pin) return false;
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
// Startup
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
        if (accountBtn) accountBtn.onclick = openLogin;

        await initStatusPanel();
        await refreshAccountStatus();

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

        if (!isIOS) await ensureRegistered();

    } catch (e) {
        console.error('Critical failure in popup startup:', e);
    }
}

document.addEventListener('DOMContentLoaded', start);
