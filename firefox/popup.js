// popup.js

const skinFilterCheck = document.getElementById('skinFilter');
const blurAllCheck = document.getElementById('blurAll');
const resetStatsBtn = document.getElementById('resetStats');
const sensitivityRange = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivityVal');
const statScanned = document.getElementById('statScanned');
const statBlocked = document.getElementById('statBlocked');

// ---------------------------------------------------------------------------
// Blocked sites — hard navigation block.
// Defaults ship in blocklist.json; user additions live in blocklistUser and
// user removals of defaults in blocklistRemoved. Storage holds the edits,
// content scripts + background enforce them.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Admin server (Cloudflare Worker): PIN-gated destructive changes.
// The PIN lives only in the worker's KV — never on the device. Removing
// blocked sites or disabling filters requires a server-side /api/verify check.
// ---------------------------------------------------------------------------
const WORKER_URL = "https://safesight.funbyte.net"; // TODO: your deployed worker

// Accounts are keyed by email: one email covers up to MAX_DEVICES devices —
// this browser plus the app on your phone or Mac — and they all share the
// account's single PIN. Keep in step with MAX_DEVICES in worker.js.
const MAX_DEVICES = 2;

// Stable per-install id, so reinstalling (or this popup reopening with cleared
// storage) reclaims its own slot instead of spending the account's second one.
function deviceId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

async function ensureRegistered() {
    const res = await chrome.storage.local.get(['clientId', 'deviceId', 'accountEmail', 'accountName', 'accountReady', 'accountStatus']);
    if (res.clientId && res.accountReady) {
        await refreshAccountStatus();
        return res.clientId;
    }

    const accountName = (prompt('Welcome to SafeSight!\n\nWhat is the account name?') || '').trim();
    if (!accountName) {
        alert('An account name is required to use SafeSight.');
        return null;
    }

    const email = (prompt('Which email should this account use?\n\nOne email covers up to ' + MAX_DEVICES + ' devices — they all share the same PIN.') || '').trim().toLowerCase();
    if (!email) return null;

    const invite = (prompt('Invite code from your admin\n\nRegistration is invite-only: ask the SafeSight admin to create a code for you. The account stays locked until they approve it.') || '').trim();
    if (!invite) return null;

    const id = res.deviceId || deviceId();
    const ua = navigator.userAgent;
    const device = 'Firefox / ' + (ua.includes('Mac') ? 'macOS' : ua.includes('Windows') ? 'Windows' : ua.includes('Linux') ? 'Linux' : 'other');
    try {
        const r = await fetch(WORKER_URL + '/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email,
                accountName,
                invite,
                deviceId: id,
                device,
                version: chrome.runtime.getManifest().version,
                ua: ua.slice(0, 160)
            })
        });
        const j = await r.json();
        if (j.id) {
            const status = j.status || 'approved';
            await chrome.storage.local.set({
                clientId: j.id,
                deviceId: id,
                accountEmail: j.email || email,
                accountName: j.accountName || accountName,
                accountReady: true,
                accountStatus: status
            });
            applyAccountLock(status);
            if (status !== 'approved') {
                alert('Registered — but this account is waiting for admin approval.\n\nSafeSight stays locked (no settings can be weakened) until the admin approves it in the console.');
            } else if (j.pin) {
                alert('Welcome to SafeSight!\n\nYour SafeSight PIN is:\n\n' + j.pin + '\n\nWrite it down — it\'s required to remove blocked sites or turn filters off. The same PIN works on your other device, and the admin can see it in the console.');
            } else if (!j.rejoined) {
                alert('Browser added to the ' + (j.email || email) + ' account.\n\nUse the PIN you set up on your other device.');
            }
            return j.id;
        }
        if (j.error === 'invite_required') {
            alert('A valid invite code is required to create an account.\n\nAsk the SafeSight admin for a code, then try again.');
        } else if (j.error === 'rate_limited') {
            alert('Too many attempts from this network — try again in a few minutes.');
        } else if (j.error === 'device_limit') {
            alert('That email already has ' + (j.deviceLimit || MAX_DEVICES) + ' devices.\n\nRemove one in the admin console, or register with a different email.');
        } else if (j.error === 'invalid_email') {
            alert('That doesn\'t look like an email address — try again.');
        } else if (j.error === 'account_name_required' || j.error === 'account_name_mismatch') {
            alert(j.error === 'account_name_mismatch'
                ? 'That account name does not match the existing account.'
                : 'An account name is required.');
        }
    } catch (e) { /* offline — retry next popup open */ }
    return null;
}

// ---------------------------------------------------------------------------
// Account approval state. A pending account has no PIN to give, so the server
// refuses every /api/verify — the popup mirrors that by locking its controls
// and polling for the approval (which also hands over the PIN).
// ---------------------------------------------------------------------------
let accountStatus = 'approved';

async function refreshAccountStatus() {
    const res = await chrome.storage.local.get(['clientId', 'accountStatus']);
    accountStatus = res.accountStatus || 'approved';
    if (!res.clientId || accountStatus === 'approved') {
        applyAccountLock(accountStatus);
        return accountStatus;
    }
    try {
        const r = await fetch(WORKER_URL + '/api/account-status?id=' + encodeURIComponent(res.clientId));
        const j = await r.json();
        if (j.ok) {
            accountStatus = j.status || 'approved';
            await chrome.storage.local.set({ accountStatus });
            if (accountStatus === 'approved' && j.pin) {
                alert('Your SafeSight account was approved by the admin.\n\nYour PIN is:\n\n' + j.pin + '\n\nWrite it down — it\'s required to remove blocked sites or turn filters off.');
            }
        }
    } catch (e) { /* offline — next open will retry */ }
    applyAccountLock(accountStatus);
    return accountStatus;
}

function accountLocked() {
    return accountStatus !== 'approved';
}

function applyAccountLock(status) {
    const banner = document.getElementById('pendingBanner');
    if (banner) banner.style.display = status === 'approved' ? 'none' : 'block';
    // Locked: the sensitivity slider can only loosen protection, so it goes
    // away entirely until the account is approved.
    if (sensitivityRange) sensitivityRange.disabled = status !== 'approved';
}

async function lockedAlert() {
    alert('Locked: this account is waiting for admin approval.\n\nNothing that weakens SafeSight can change until the admin approves it in the console.');
    return false;
}

// Returns true only when the admin server confirms the PIN for this device.
async function guardDestructive(action) {
    if (accountLocked()) return lockedAlert();
    const id = await ensureRegistered();
    if (!id) { alert('Registration is required first.'); return false; }
    const pin = prompt('Enter the admin PIN to ' + action + ':');
    if (!pin) return false;
    try {
        const r = await fetch(WORKER_URL + '/api/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, pin: pin.trim(), action })
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

ensureRegistered();

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
    s = s.replace(/^\*\.?/, '').replace(/^www\./, '').replace(/\.$/, '');
    return s.includes('.') ? s : null;
}

async function fetchDefaultBlocklist() {
    try {
        const res = await chrome.storage.local.get(['blocklistDefaults']);
        if (Array.isArray(res.blocklistDefaults)) return res.blocklistDefaults;
    } catch (e) { /* fall through to file */ }
    try {
        const resp = await fetch(chrome.runtime.getURL('blocklist.json'));
        const data = await resp.json();
        const list = Array.isArray(data) ? data : ((data && data.sites) || []);
        return list.map(normalizeSite).filter(Boolean);
    } catch (e) {
        return null;
    }
}

function effectiveBlockSites() {
    // Shipped defaults stay hidden and locked: enforced from blocklist.json,
    // but not listed, edited or removable here. Only user-added sites show.
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
    // Only user-added sites can be removed; shipped defaults stay locked.
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
        // Locked: shipped defaults are already blocked and hidden from the list.
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
    } catch (e) { /* keep empty lists */ }
    renderBlocklist();
})();


function getSensitivityLabel(val) {
    val = parseInt(val);
    if (val <= 3) return `Relaxed (${val})`;
    if (val <= 6) return `Standard (${val})`;
    return `Strict (${val})`;
}

// Initial load
chrome.storage.local.get(['skinFilter', 'blurAll', 'sensitivity', 'scannedCount', 'blockedCount'], (res) => {
    skinFilterCheck.checked = !!res.skinFilter;
    blurAllCheck.checked = !!res.blurAll;

    const sens = res.sensitivity ?? 4;
    sensitivityRange.value = sens;
    sensitivityVal.innerText = getSensitivityLabel(sens);

    statScanned.innerText = res.scannedCount || 0;
    statBlocked.innerText = res.blockedCount || 0;

});

// Update stats in real-time if popup is open
chrome.storage.onChanged.addListener((changes) => {
    if (changes.scannedCount) statScanned.innerText = changes.scannedCount.newValue;
    if (changes.blockedCount) statBlocked.innerText = changes.blockedCount.newValue;
});

// Settings handlers
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

if (resetStatsBtn) {
    resetStatsBtn.onclick = async () => {
        chrome.runtime.sendMessage({ type: 'RESET_STATS' });
        statScanned.innerText = 0;
        statBlocked.innerText = 0;
    };
}
