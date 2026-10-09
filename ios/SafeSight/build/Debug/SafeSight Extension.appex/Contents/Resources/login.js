const WORKER_URL = "https://safesight.funbyte.net";

const regForm = document.getElementById('regForm');
const submitBtn = document.getElementById('submitBtn');
const btnText = document.getElementById('btnText');
const spinner = document.getElementById('spinner');
const messageEl = document.getElementById('message');
const inviteInput = document.getElementById('invite');

const ACCOUNT_KEYS = ['clientId', 'deviceId', 'accountEmail', 'accountName', 'accountReady', 'accountStatus'];
const STATUS_POLL_MS = 12000;

let lastPin = null;
let pollTimer = null;

function showMessage(el, text, type) {
    el.textContent = text;
    el.className = type === 'error' ? 'msg-error' : type === 'info' ? 'msg-info' : 'msg-success';
    el.style.display = 'block';
}

function showSection(id) {
    ['regView', 'pendingView', 'pinView', 'manageView'].forEach((v) => {
        const el = document.getElementById(v);
        if (el) el.classList.toggle('active', v === id);
    });
}

function statusText(status) {
    if (status === 'approved') return 'Approved';
    if (status === 'pending') return 'Waiting for approval';
    return 'Locked';
}

function statusClass(status) {
    if (status === 'approved') return 'v status-approved';
    return 'v status-pending';
}

if (inviteInput) {
    inviteInput.addEventListener('input', () => {
        inviteInput.value = inviteInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    });
}

async function getAccount() {
    return chrome.storage.local.get(ACCOUNT_KEYS.concat(['deviceCount', 'deviceLimit']));
}

async function saveAccount(fields) {
    await chrome.storage.local.set(fields);
}

function setBusy(busy, label) {
    submitBtn.disabled = busy;
    spinner.style.display = busy ? 'inline-block' : 'none';
    if (label) btnText.textContent = label;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
async function handleRegister(e) {
    e.preventDefault();

    const accountName = document.getElementById('accountName').value.trim();
    const email = document.getElementById('email').value.trim().toLowerCase();
    const invite = inviteInput.value.trim().toUpperCase();

    if (!accountName || !email || !invite) {
        showMessage(messageEl, 'All fields are required.', 'error');
        return;
    }

    setBusy(true, 'Registering…');
    messageEl.style.display = 'none';

    const id = crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now().toString(36);
    const ua = navigator.userAgent;
    const device = 'Safari / ' + (ua.includes('Mac') ? 'macOS' : ua.includes('Windows') ? 'Windows' : ua.includes('Linux') ? 'Linux' : 'iOS');

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

        const j = await r.json().catch(() => ({}));

        if (r.ok && j.id) {
            const status = j.status || 'approved';
            await saveAccount({
                clientId: j.id,
                deviceId: id,
                accountEmail: j.email || email,
                accountName: j.accountName || accountName,
                accountReady: true,
                accountStatus: status,
                deviceCount: j.devices || 1,
                deviceLimit: j.deviceLimit || null
            });

            if (status !== 'approved') {
                showSection('pendingView');
                startPendingPolling();
            } else if (j.pin) {
                showPin(j.pin, j.rejoined
                    ? 'Welcome back — this device is reconnected to your account.'
                    : 'Registration successful. Save this somewhere safe.');
            } else {
                fillManage();
                showSection('manageView');
                showMessage(document.getElementById('manageMessage'),
                    'Welcome back — this device is reconnected. Your PIN stays with your family admin.', 'info');
            }
            return;
        }

        if (j.error === 'invite_required') {
            showMessage(messageEl, 'A valid invite code is required for the first device on an account. Ask your SafeSight admin.', 'error');
        } else if (j.error === 'account_name_mismatch') {
            showMessage(messageEl, 'This email is already registered under a different account name. Use the exact name on the account, or ask the admin.', 'error');
        } else if (j.error === 'device_limit') {
            showMessage(messageEl, 'Device limit reached (' + (j.devices || '?') + '/' + (j.deviceLimit || 2) + '). Remove a device in the admin console, then try again.', 'error');
        } else if (j.error === 'invalid_email') {
            showMessage(messageEl, 'Please enter a valid email address.', 'error');
        } else if (j.error === 'account_name_required') {
            showMessage(messageEl, 'An account name is required.', 'error');
        } else if (j.error === 'rate_limited') {
            showMessage(messageEl, 'Too many attempts — wait a minute and try again.', 'error');
        } else {
            showMessage(messageEl, 'Registration failed' + (j.error ? ' (' + j.error + ')' : '') + '. Please try again.', 'error');
        }
    } catch (err) {
        showMessage(messageEl, 'Could not reach the SafeSight server. Check your connection and try again.', 'error');
        console.error('Registration error:', err);
    } finally {
        setBusy(false, 'Register Device');
    }
}

if (regForm) regForm.onsubmit = handleRegister;

// ---------------------------------------------------------------------------
// Pending approval polling
// ---------------------------------------------------------------------------
function stopPendingPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function startPendingPolling() {
    stopPendingPolling();
    pollTimer = setInterval(() => checkPending(false), STATUS_POLL_MS);
}

// Surfaces poll results in whichever view is on screen: the pending view
// keeps its own note, the manage view reports through its message box.
function setPollNote(text) {
    const note = document.getElementById('pendingNote');
    if (note) note.textContent = text;
    const manageView = document.getElementById('manageView');
    const msg = document.getElementById('manageMessage');
    if (msg && manageView && manageView.classList.contains('active')) {
        showMessage(msg, text, 'info');
    }
}

async function checkPending(manual) {
    const res = await chrome.storage.local.get(['clientId']);
    if (!res.clientId) { stopPendingPolling(); return; }

    if (manual) setPollNote('Checking…');
    try {
        const r = await fetch(WORKER_URL + '/api/account-status?id=' + encodeURIComponent(res.clientId));
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'status failed');

        const status = j.status || 'pending';
        await saveAccount({ accountStatus: status });

        if (status === 'approved') {
            stopPendingPolling();
            if (j.pin) {
                showPin(j.pin, 'Your account was approved by the admin.');
            } else {
                fillManage();
                showSection('manageView');
                showMessage(document.getElementById('manageMessage'), 'Your account was approved.', 'success');
            }
            return;
        }
        if (manual) await fillManage();
        setPollNote('Still waiting for the admin. Checking again automatically.');
    } catch (err) {
        setPollNote(manual
            ? 'Could not reach the SafeSight server — check your connection and try again.'
            : 'Could not reach the server — will keep retrying.');
    }
}

const pendingCheckBtn = document.getElementById('pendingCheckBtn');
if (pendingCheckBtn) pendingCheckBtn.onclick = () => checkPending(true);

const pendingCloseBtn = document.getElementById('pendingCloseBtn');
if (pendingCloseBtn) {
    pendingCloseBtn.onclick = async () => {
        window.close();
        // Tabs we didn't open can't be closed by script — fall back to the
        // account view instead of leaving the page stuck on the spinner.
        setTimeout(async () => {
            await fillManage();
            showSection('manageView');
        }, 150);
    };
}

// ---------------------------------------------------------------------------
// PIN reveal
// ---------------------------------------------------------------------------
function showPin(pin, subtitle) {
    lastPin = pin;
    document.getElementById('pinBox').textContent = pin;
    document.getElementById('pinSubtitle').textContent = subtitle || 'Write this down — it\'s required to change filters or blocked sites.';
    document.getElementById('copyPinBtn').textContent = 'Copy PIN';
    showSection('pinView');
}

const copyPinBtn = document.getElementById('copyPinBtn');
if (copyPinBtn) {
    copyPinBtn.onclick = async () => {
        if (!lastPin) return;
        try {
            await navigator.clipboard.writeText(lastPin);
            copyPinBtn.textContent = 'Copied!';
        } catch (e) {
            copyPinBtn.textContent = 'Select and copy manually';
        }
    };
}

const pinDoneBtn = document.getElementById('pinDoneBtn');
if (pinDoneBtn) {
    pinDoneBtn.onclick = async () => {
        window.close();
        // Same fallback: if the tab can't close, show the account view.
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
    const status = res.accountStatus || 'approved';
    document.getElementById('mgName').textContent = res.accountName || '—';
    document.getElementById('mgEmail').textContent = res.accountEmail || '—';
    const statusEl = document.getElementById('mgStatus');
    statusEl.textContent = statusText(status);
    statusEl.className = statusClass(status);
    const devices = (res.deviceCount != null) ? res.deviceCount : null;
    document.getElementById('mgDevices').textContent =
        (devices != null) ? devices + (res.deviceLimit ? ' / ' + res.deviceLimit : '') : '—';
}

const mgRefresh = document.getElementById('mgRefresh');
if (mgRefresh) {
    mgRefresh.onclick = async () => {
        const msg = document.getElementById('manageMessage');
        msg.style.display = 'none';
        mgRefresh.disabled = true;
        const original = mgRefresh.textContent;
        mgRefresh.textContent = 'Checking…';

        const res = await chrome.storage.local.get(['clientId']);
        if (!res.clientId) {
            showMessage(msg, 'This device is not registered.', 'error');
        } else {
            try {
                const r = await fetch(WORKER_URL + '/api/account-status?id=' + encodeURIComponent(res.clientId));
                const j = await r.json();
                if (!j.ok) throw new Error(j.error || 'status failed');
                const status = j.status || 'pending';
                await saveAccount({ accountStatus: status });
                await fillManage();
                if (status === 'approved') {
                    stopPendingPolling();
                    if (j.pin) {
                        showPin(j.pin, 'Your account was approved by the admin.');
                        return;
                    }
                    showMessage(msg, 'Your account is approved.', 'success');
                } else {
                    startPendingPolling();
                    showMessage(msg, 'Still waiting for admin approval. This page re-checks automatically.', 'info');
                }
            } catch (e) {
                showMessage(msg, 'Could not reach the SafeSight server — try again later.', 'error');
            }
        }
        mgRefresh.disabled = false;
        mgRefresh.textContent = original;
    };
}

const mgForget = document.getElementById('mgForget');
if (mgForget) {
    mgForget.onclick = async () => {
        if (!confirm('Forget SafeSight on this device?\n\nFilters keep running, but you will need a new invite code to manage this device again.')) return;
        await chrome.storage.local.remove(ACCOUNT_KEYS.concat(['deviceCount', 'deviceLimit']));
        location.hash = '';
        location.reload();
    };
}

const mgClose = document.getElementById('mgClose');
if (mgClose) mgClose.onclick = () => window.close();

// ---------------------------------------------------------------------------
// Boot: already registered -> manage view; #manage always opens manage
// ---------------------------------------------------------------------------
(async function init() {
    const res = await getAccount();
    // accountReady is the same flag the popup and the content script gate on.
    // Requiring clientId as well made app-synced identities (email + name,
    // clientId still empty) fall back to the registration form.
    const signedIn = !!res.accountReady;
    if (signedIn) {
        await fillManage();
        // '#manage' is what the popup's Account settings menu entry opens;
        // a signed-in device always lands on the manage view.
        showSection('manageView');
        if ((res.accountStatus || 'approved') !== 'approved') startPendingPolling();
    } else {
        showSection('regView');
    }
})();
