import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut, onAuthStateChanged, getIdToken } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

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
const provider = new GoogleAuthProvider();

const WORKER_URL = "https://safesight.funbyte.net";

const googleBtn = document.getElementById('googleBtn');
const googleView = document.getElementById('googleView');
const loginForm = document.getElementById('loginForm');
const loginSubmitBtn = document.getElementById('loginSubmitBtn');
const loginBtnText = document.getElementById('loginBtnText');
const loginSpinner = document.getElementById('loginSpinner');
const loginMessage = document.getElementById('loginMessage');
const tabSignUp = document.getElementById('tabSignUp');
const tabSignIn = document.getElementById('tabSignIn');

const ACCOUNT_KEYS = ['clientId', 'deviceId', 'accountEmail', 'accountName', 'accountReady', 'firebaseUid'];

const resetRequestForm = document.getElementById('resetRequestForm');
const resetRequestBtn = document.getElementById('resetRequestBtn');
const resetRequestBtnText = document.getElementById('resetRequestBtnText');
const resetRequestSpinner = document.getElementById('resetRequestSpinner');
const resetMessage = document.getElementById('resetMessage');

const resetCodeForm = document.getElementById('resetCodeForm');
const resetTokenInput = document.getElementById('resetToken');
const newPasswordInput = document.getElementById('newPassword');
const resetConfirmBtn = document.getElementById('resetConfirmBtn');
const resetConfirmBtnText = document.getElementById('resetConfirmBtnText');
const resetConfirmSpinner = document.getElementById('resetConfirmSpinner');
const resetCodeMessage = document.getElementById('resetCodeMessage');

const forgotPwdBtn = document.getElementById('forgotPwdBtn');

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

function showSection(id) {
    ['googleView', 'loginView', 'resetView', 'resetCodeView', 'pinView', 'manageView'].forEach((v) => {
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
// Firebase auth state
// ---------------------------------------------------------------------------
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
    // Auto-save account info on successful Google sign-in
    await handleGoogleSignIn(user);
});

// ---------------------------------------------------------------------------
// Google Sign-In
// ---------------------------------------------------------------------------
async function handleGoogleSignIn(user) {
    const email = user.email.toLowerCase();
    const accountName = user.displayName || email.split('@')[0];
    const firstName = (user.displayName || '').split(' ')[0] || '';
    const lastName = ((user.displayName || '').split(' ').slice(1).join(' ') || '').trim() || '';
    const photoURL = user.photoURL || '';
    const firebaseUid = user.uid;

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
                googleSignIn: true
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

        if (j.error === 'email_taken') {
            showMessage(loginMessage, 'An account with this email already exists. Try signing in with your password below.', 'error');
            showSection('loginView');
        } else if (j.error === 'rate_limited') {
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
        const result = await signInWithPopup(auth, provider);
        await handleGoogleSignIn(result.user);
    } catch (err) {
        if (err.code !== 'auth/popup-closed-by-user') {
            showMessage(loginMessage, 'Sign in failed: ' + (err.message || 'Please try again.'), 'error');
        }
    }
};

// ---------------------------------------------------------------------------
// Password login (fallback)
// ---------------------------------------------------------------------------
tabSignUp.onclick = () => {
    tabSignUp.classList.add('active');
    tabSignIn.classList.remove('active');
    showSection('googleView');
    loginMessage.style.display = 'none';
};

tabSignIn.onclick = () => {
    tabSignIn.classList.add('active');
    tabSignUp.classList.remove('active');
    showSection('loginView');
    loginMessage.style.display = 'none';
};

loginForm.onsubmit = async (e) => {
    e.preventDefault();

    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;

    if (!email || !password) {
        showMessage(loginMessage, 'Please enter your email and password.', 'error');
        return;
    }

    setBusy(true, 'Signing in…', loginSubmitBtn, loginBtnText, loginSpinner);
    loginMessage.style.display = 'none';

    try {
        const ua = navigator.userAgent;
        const device = 'Chrome / ' + (ua.includes('Mac') ? 'macOS' : ua.includes('Windows') ? 'Windows' : ua.includes('Linux') ? 'Linux' : 'other');
        const id = crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now().toString(36);
        let version = '0.0.0';
        try { version = chrome?.runtime?.getManifest?.().version || '0.0.0'; } catch(e) {}

        const r = await fetch(WORKER_URL + '/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, deviceId: id, device, version, ua: ua.slice(0, 160) })
        });

        const j = await r.json().catch(() => ({}));

        if (r.ok && j.ok && j.id) {
            const accountRes = await chrome.storage.local.get(ACCOUNT_KEYS);
            const deviceId = accountRes.deviceId || (crypto.randomUUID ? crypto.randomUUID() : 'dev-' + Date.now().toString(36));

            await saveAccount({
                clientId: j.id,
                deviceId: deviceId,
                accountEmail: email,
                accountName: j.accountName || '',
                accountReady: true
            });

            fillManage();
            showSection('manageView');
            showMessage(manageMessage,
                'Signed in successfully. SafeSight is now active on this browser.', 'success');
            return;
        }

        if (j.error === 'invalid_credentials') {
            showMessage(loginMessage, 'Incorrect email or password. Please try again.', 'error');
        } else if (j.error === 'not_found') {
            showMessage(loginMessage, 'No account found with that email. Sign in with Google to create one.', 'error');
        } else if (j.error === 'rate_limited') {
            showMessage(loginMessage, 'Too many attempts — wait a minute and try again.', 'error');
        } else {
            showMessage(loginMessage, 'Could not sign in. Please try again.', 'error');
        }
    } catch (err) {
        showMessage(loginMessage, 'Could not reach the SafeSight server. Check your connection and try again.', 'error');
        console.error('Login error:', err);
    } finally {
        setBusy(false, 'Sign In', loginSubmitBtn, loginBtnText, loginSpinner);
    }
};

// ---------------------------------------------------------------------------
// Forgot password flow
// ---------------------------------------------------------------------------
forgotPwdBtn.onclick = () => {
    showSection('resetView');
    resetMessage.style.display = 'none';
    resetTokenInput.value = '';
    newPasswordInput.value = '';
};

resetRequestForm.onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('resetEmail').value.trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showMessage(resetMessage, 'Please enter a valid email address.', 'error');
        return;
    }

    setBusy(true, 'Sending…', resetRequestBtn, resetRequestBtnText, resetRequestSpinner);
    resetMessage.style.display = 'none';

    try {
        const r = await fetch(WORKER_URL + '/api/reset-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const j = await r.json().catch(() => ({}));

        if (r.ok && j.ok) {
            showMessage(resetMessage, 'If an account exists for that email, a reset code has been sent. Copy the code from your email and enter it below.', 'info');
            showSection('resetCodeView');
        } else if (j.error === 'rate_limited') {
            showMessage(resetMessage, 'Too many attempts — wait a minute and try again.', 'error');
        } else {
            showMessage(resetMessage, 'Could not request a reset. Please try again.', 'error');
        }
    } catch (err) {
        showMessage(resetMessage, 'Could not reach the SafeSight server. Check your connection and try again.', 'error');
        console.error('Reset request error:', err);
    } finally {
        setBusy(false, 'Send Reset Link', resetRequestBtn, resetRequestBtnText, resetRequestSpinner);
    }
};

resetCodeForm.onsubmit = async (e) => {
    e.preventDefault();
    const token = document.getElementById('resetToken').value.trim();
    const newPassword = document.getElementById('newPassword').value;

    if (!token) {
        showMessage(resetCodeMessage, 'Please enter the reset code from your email.', 'error');
        return;
    }
    if (!newPassword || newPassword.length < 8) {
        showMessage(resetCodeMessage, 'Password must be at least 8 characters.', 'error');
        return;
    }

    setBusy(true, 'Resetting…', resetConfirmBtn, resetConfirmBtnText, resetConfirmSpinner);
    resetCodeMessage.style.display = 'none';

    try {
        const r = await fetch(WORKER_URL + '/api/reset-confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, password: newPassword })
        });
        const j = await r.json().catch(() => ({}));

        if (r.ok && j.ok) {
            showMessage(resetCodeMessage, 'Your password has been reset. You can now sign in with your new password.', 'success');
            setTimeout(() => {
                tabSignIn.click();
                document.getElementById('loginEmail').value = '';
                document.getElementById('loginPassword').value = '';
            }, 1500);
        } else if (j.error === 'invalid_token') {
            showMessage(resetCodeMessage, 'That reset code is invalid. Request a new one.', 'error');
        } else if (j.error === 'token_expired') {
            showMessage(resetCodeMessage, 'That reset code has expired. Request a new one.', 'error');
        } else if (j.error === 'rate_limited') {
            showMessage(resetCodeMessage, 'Too many attempts — wait a minute and try again.', 'error');
        } else {
            showMessage(resetCodeMessage, 'Could not reset your password. Please try again.', 'error');
        }
    } catch (err) {
        showMessage(resetCodeMessage, 'Could not reach the SafeSight server. Check your connection and try again.', 'error');
        console.error('Reset confirm error:', err);
    } finally {
        setBusy(false, 'Reset Password', resetConfirmBtn, resetConfirmBtnText, resetConfirmSpinner);
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
    if (location.hash === '#reset') {
        showSection('resetView');
        resetMessage.style.display = 'none';
        return;
    }
    if (signedIn) {
        await fillManage();
        showSection('manageView');
    } else {
        showSection('googleView');
    }
})();
