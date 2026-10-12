// popup.js
//
// Entirely local: there is no account, no sign-in and no server. This file used
// to import the Firebase SDK from gstatic on every popup open, which was a
// remote request per open and a blank panel when offline.
const skinFilterCheck = document.getElementById('skinFilter');
const blurAllCheck = document.getElementById('blurAll');
const resetStatsBtn = document.getElementById('resetStats');
const sensitivityRange = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivityVal');
const statScanned = document.getElementById('statScanned');
const statBlocked = document.getElementById('statBlocked');

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


// The stored value is a strictness level: 1 is the most permissive, 9 the most
// aggressive, and the model's 0-10 score is blurred at `10 - level`. The readout
// reports the level, so it rises with the slider instead of falling as the
// cutoff does. Kept in step with the Chrome build.
function sensitivityCutoff(level) {
    return 10 - parseInt(level);
}

function sensitivityBand(level) {
    const val = parseInt(level);
    if (isNaN(val) || val <= 3) return 'Relaxed';
    if (val <= 6) return 'Standard';
    return 'Strict';
}

function getSensitivityLabel(level) {
    const val = parseInt(level);
    if (isNaN(val)) return 'Standard · 6/9';
    return `${sensitivityBand(val)} · ${val}/9`;
}

function renderSensitivity(level) {
    sensitivityRange.value = level;
    sensitivityVal.innerText = getSensitivityLabel(level);
    sensitivityVal.title = `${sensitivityBand(level)} ${level}/9: images scoring ${sensitivityCutoff(level)} or more are blurred.`;
}

chrome.storage.local.get(['skinFilter', 'blurAll', 'sensitivity', 'scannedCount', 'blockedCount'], (res) => {
    skinFilterCheck.checked = !!res.skinFilter;
    blurAllCheck.checked = !!res.blurAll;
    const sens = res.sensitivity ?? 6;
    renderSensitivity(sens);
    statScanned.innerText = res.scannedCount || 0;
    statBlocked.innerText = res.blockedCount || 0;
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.scannedCount) statScanned.innerText = changes.scannedCount.newValue;
    if (changes.blockedCount) statBlocked.innerText = changes.blockedCount.newValue;
    // Without this the readout keeps the level it was opened with, because the
    // stored setting can change from another window or from an update.
    if (changes.sensitivity && changes.sensitivity.newValue != null) renderSensitivity(changes.sensitivity.newValue);
});

skinFilterCheck.onchange = () => {
    chrome.storage.local.set({ skinFilter: skinFilterCheck.checked });
};

blurAllCheck.onchange = () => {
    chrome.storage.local.set({ blurAll: blurAllCheck.checked });
};

sensitivityRange.oninput = () => {
    sensitivityVal.innerText = getSensitivityLabel(sensitivityRange.value);
    sensitivityVal.title = `${sensitivityBand(sensitivityRange.value)} ${sensitivityRange.value}/9: images scoring ${sensitivityCutoff(sensitivityRange.value)} or more are blurred.`;
};

sensitivityRange.onchange = () => {
    chrome.storage.local.set({ sensitivity: parseInt(sensitivityRange.value) });
};

if (resetStatsBtn) {
    resetStatsBtn.onclick = async () => {
        chrome.runtime.sendMessage({ type: 'RESET_STATS' });
        statScanned.innerText = 0;
        statBlocked.innerText = 0;
    };
}

