// popup.js
//
// Entirely local: there is no account, no sign-in and no server. Everything the
// panel can change is a chrome.storage.local key that the content script and the
// service worker read directly.
const aiFilterCheck = document.getElementById('aiFilter');
const skinFilterCheck = document.getElementById('skinFilter');
const blurAllCheck = document.getElementById('blurAll');
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


// The stored value is a strictness level, not the score cutoff: 1 is the most
// permissive, 9 the most aggressive. The model scores an image 0-10, so the
// level maps to the score at which an image gets blurred.
function sensitivityCutoff(level) {
    return 10 - parseInt(level);
}

function sensitivityBand(level) {
    const val = parseInt(level);
    if (isNaN(val) || val <= 3) return 'Relaxed';
    if (val <= 6) return 'Standard';
    return 'Strict';
}

// The readout reports the strictness LEVEL, so both halves move the same way as
// the slider. Printing the score cutoff here was a mistake: the cutoff falls as
// strictness rises, so dragging toward "Strict" made the number go *down* and
// the control read as reversed even when the behaviour was correct.
function getSensitivityLabel(level) {
    const val = parseInt(level);
    if (isNaN(val)) return 'Standard · 6/9';
    return `${sensitivityBand(val)} · ${val}/9`;
}

// One place that turns a level into what the popup shows, so the readout and
// the live drag can never disagree.
function renderSensitivity(level) {
    sensitivityRange.value = level;
    sensitivityVal.innerText = getSensitivityLabel(level);
    sensitivityVal.title = `${sensitivityBand(level)} ${level}/9: images scoring ${sensitivityCutoff(level)} or more are blurred.`;
}

function statusClass(status) {
    return 'status-dot';
}

// ---------------------------------------------------------------------------
// Network filtering (the declarativeNetRequest lane)
//
// The popup is a thin view over the service worker's filter-manager: it asks
// for state and sends intents, so there is exactly one place that owns the
// ruleset and dynamic-rule reconciliation.
// ---------------------------------------------------------------------------
const filterAdult = document.getElementById('filterAdult');
const filterMalware = document.getElementById('filterMalware');
const filterAds = document.getElementById('filterAds');
const siteStateText = document.getElementById('siteStateText');
const siteToggle = document.getElementById('siteToggle');
const zapBtn = document.getElementById('zapBtn');
const filterNote = document.getElementById('filterNote');
const statAdsHidden = document.getElementById('statAdsHidden');
const staleNotice = document.getElementById('staleNotice');
const staleReload = document.getElementById('staleReload');

let filterStatus = null;

// Must match FILTER_CONTRACT in content.js. Reloading the extension does not
// re-inject content scripts into tabs that are already open, so those tabs keep
// filtering by the old rules while this popup shows the new ones. Asking the
// page for its contract is how the popup can tell the difference and say so.
const FILTER_CONTRACT = 2;

async function contentScriptContract() {
    const tab = await activeTab();
    if (!tab || typeof tab.id !== 'number') return 'absent';
    if (!/^https?:/.test(tab.url || '')) return 'absent';
    try {
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'FILTER_CONTRACT' });
        // A listener that answers nothing is a build that predates the contract.
        if (!reply || Number(reply.contract) < FILTER_CONTRACT) return 'stale';
        return 'current';
    } catch (e) {
        // Nothing is listening: a restricted page, an excluded host, or a tab
        // that has never had the content script. Nothing to warn about.
        return 'absent';
    }
}

async function refreshContractNotice() {
    if (!staleNotice) return;
    const state = await contentScriptContract();
    staleNotice.hidden = state !== 'stale';
    return state;
}

if (staleReload) {
    staleReload.onclick = async () => {
        staleNotice.hidden = true;
        const tab = await activeTab();
        if (!tab || typeof tab.id !== 'number') return;
        chrome.tabs.reload(tab.id);
    };
}

// Nothing in the popup animates until this runs. The stored values land after
// the defaults have already been painted, so without the gate every switch
// visibly slid into position while the popup was opening.
let readyMarked = false;
function markReady() {
    if (readyMarked) return;
    readyMarked = true;
    document.documentElement.classList.add('ready');
}

function activeTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs && tabs[0]));
    });
}

async function loadFilterStatus() {
    refreshContractNotice();
    const tab = await activeTab();
    const url = (tab && tab.url) || '';
    let status = null;
    try {
        status = await chrome.runtime.sendMessage({ type: 'GET_FILTER_STATUS', url });
    } catch (e) {
        filterNote.textContent = 'Filtering service is starting — reopen the popup.';
        return;
    }
    if (!status) return;
    filterStatus = status;

    filterAdult.checked = !!status.categories.adult;
    filterMalware.checked = !!status.categories.malware;
    filterAds.checked = !!status.categories.ads;
    statAdsHidden.innerText = status.cosmeticHidden || 0;
    markReady();

    const rest = Array.isArray(status.enabledRulesets) ? status.enabledRulesets : [];
    const unexpected = ['adult', 'malware', 'ads'].filter((id) => status.categories[id] && !rest.includes(id));
    filterNote.textContent = unexpected.length
        ? 'Could not enable: ' + unexpected.join(', ') + ' — try updating SafeSight.'
        : 'Blocked requests are counted on the toolbar badge.';

    const host = status.host;
    if (!host || !/^https?:/.test(url)) {
        siteStateText.textContent = 'Not available on this page';
        siteToggle.disabled = true;
        zapBtn.disabled = true;
        return;
    }
    zapBtn.disabled = false;
    siteToggle.disabled = false;
    siteStateText.textContent = status.siteOff ? 'Network filtering is OFF here' : 'Network filtering is on';
    siteToggle.textContent = status.siteOff ? 'Turn on here' : 'Turn off here';
}

async function setCategory(category, enabled, input) {
    const resp = await chrome.runtime.sendMessage({ type: 'SET_FILTER_CATEGORY', category, enabled });
    if (!resp || !resp.ok) { input.checked = !enabled; }
    loadFilterStatus();
}

if (filterAdult) filterAdult.onchange = () => setCategory('adult', filterAdult.checked, filterAdult);
if (filterMalware) filterMalware.onchange = () => setCategory('malware', filterMalware.checked, filterMalware);
if (filterAds) filterAds.onchange = () => setCategory('ads', filterAds.checked, filterAds);

if (siteToggle) {
    siteToggle.onclick = async () => {
        if (!filterStatus || !filterStatus.host) return;
        siteToggle.disabled = true;
        await chrome.runtime.sendMessage({
            type: 'SET_SITE_OFF',
            host: filterStatus.host,
            off: !filterStatus.siteOff
        });
        siteToggle.disabled = false;
        const tab = await activeTab();
        if (tab && tab.id) chrome.tabs.reload(tab.id);
        loadFilterStatus();
    };
}

if (zapBtn) {
    zapBtn.onclick = async () => {
        const tab = await activeTab();
        if (!tab) return;
        // The injection happens in the page, so the popup closes; the zap is
        // then applied by the service worker when the click result arrives.
        const r = await chrome.runtime.sendMessage({ type: 'START_ELEMENT_TOOL', mode: 'zap', tabId: tab.id });
        if (r && r.ok) window.close();
        else filterNote.textContent = 'Cannot zap on this page (browser pages are off limits).';
    };
}

loadFilterStatus();

// The three ML settings are inert while the master switch is off, so disable
// them rather than leaving switches that appear to do something.
function syncAiSubControls() {
    const off = !aiFilterCheck.checked;
    [skinFilterCheck, blurAllCheck, sensitivityRange].forEach((el) => {
        if (el) el.disabled = off;
    });
    const card = aiFilterCheck.closest('.status-card');
    if (card) card.classList.toggle('lane-off', off);
}

if (aiFilterCheck) {
    aiFilterCheck.onchange = () => {
        syncAiSubControls();
        chrome.storage.local.set({ aiFilter: aiFilterCheck.checked });
        refreshContractNotice();
    };
}

chrome.storage.local.get(['aiFilter', 'skinFilter', 'blurAll', 'sensitivity', 'scannedCount', 'blockedCount', 'cosmeticHiddenCount'], (res) => {
    // Unset means on, matching content.js.
    aiFilterCheck.checked = res.aiFilter !== false;
    syncAiSubControls();
    skinFilterCheck.checked = !!res.skinFilter;
    blurAllCheck.checked = !!res.blurAll;
    const sens = res.sensitivity ?? 6;
    renderSensitivity(sens);
    statScanned.innerText = res.scannedCount || 0;
    statBlocked.innerText = res.blockedCount || 0;
    if (statAdsHidden) statAdsHidden.innerText = res.cosmeticHiddenCount || 0;
    markReady();
});

// If the worker never answers, still release the animation gate so the popup is
// not permanently stuck in its no-transition state.
setTimeout(markReady, 600);

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.scannedCount) statScanned.innerText = changes.scannedCount.newValue;
    if (changes.blockedCount) statBlocked.innerText = changes.blockedCount.newValue;
    if (changes.cosmeticHiddenCount && statAdsHidden) statAdsHidden.innerText = changes.cosmeticHiddenCount.newValue || 0;
    if (changes.aiFilter) { aiFilterCheck.checked = changes.aiFilter.newValue !== false; syncAiSubControls(); }
    // Without this the readout keeps the value it was opened with, because the
    // stored setting can change from another window or from an update.
    if (changes.sensitivity && changes.sensitivity.newValue != null) renderSensitivity(changes.sensitivity.newValue);
    if (changes.filterCategories || changes.filterSiteOff || changes.userCSS) loadFilterStatus();
});

// Changing a setting is exactly when a page running older rules starts to
// disagree with what the popup says, so re-check on every change.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.sensitivity || changes.skinFilter || changes.blurAll || changes.aiFilter) refreshContractNotice();
});

skinFilterCheck.onchange = () => {
    chrome.storage.local.set({ skinFilter: skinFilterCheck.checked });
    refreshContractNotice();
};

blurAllCheck.onchange = () => {
    chrome.storage.local.set({ blurAll: blurAllCheck.checked });
    refreshContractNotice();
};

sensitivityRange.oninput = () => {
    sensitivityVal.innerText = getSensitivityLabel(sensitivityRange.value);
    sensitivityVal.title = `${sensitivityBand(sensitivityRange.value)} ${sensitivityRange.value}/9: images scoring ${sensitivityCutoff(sensitivityRange.value)} or more are blurred.`;
};

sensitivityRange.onchange = () => {
    chrome.storage.local.set({ sensitivity: parseInt(sensitivityRange.value) });
    refreshContractNotice();
};
