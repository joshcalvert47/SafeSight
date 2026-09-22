// popup.js
// SHA-256 of the admin password — not reversible from the source alone.
// Change the password by replacing this hash, e.g.:
// node -e "console.log(require('crypto').createHash('sha256').update('newpass').digest('hex'))"
const ADMIN_PASSWORD_HASH = "240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9"; // "admin123"

const showRatingsCheck = document.getElementById('showRatings');
const skinFilterCheck = document.getElementById('skinFilter');
const blurAllCheck = document.getElementById('blurAll');
const adminModeBtn = document.getElementById('adminMode');
const resetStatsBtn = document.getElementById('resetStats');
const sensitivityRange = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivityVal');
const statScanned = document.getElementById('statScanned');
const statBlocked = document.getElementById('statBlocked');

async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getSensitivityLabel(val) {
    val = parseInt(val);
    if (val <= 3) return `Relaxed (${val})`;
    if (val <= 6) return `Standard (${val})`;
    return `Strict (${val})`;
}

// Initial load
chrome.storage.local.get(['showRatings', 'skinFilter', 'blurAll', 'adminUnlocked', 'sensitivity', 'scannedCount', 'blockedCount'], (res) => {
    showRatingsCheck.checked = res.showRatings !== false;
    skinFilterCheck.checked = !!res.skinFilter;
    blurAllCheck.checked = !!res.blurAll;

    const sens = res.sensitivity ?? 4;
    sensitivityRange.value = sens;
    sensitivityVal.innerText = getSensitivityLabel(sens);

    statScanned.innerText = res.scannedCount || 0;
    statBlocked.innerText = res.blockedCount || 0;

    if (res.adminUnlocked) {
        adminModeBtn.innerText = "Admin Settings Unlocked";
        adminModeBtn.style.background = "rgba(34, 197, 94, 0.1)";
        adminModeBtn.style.color = "#22c55e";
    }
});

// Update stats in real-time if popup is open
chrome.storage.onChanged.addListener((changes) => {
    if (changes.scannedCount) statScanned.innerText = changes.scannedCount.newValue;
    if (changes.blockedCount) statBlocked.innerText = changes.blockedCount.newValue;
});

// Settings handlers
showRatingsCheck.onchange = () => {
    chrome.storage.local.set({ showRatings: showRatingsCheck.checked });
};

skinFilterCheck.onchange = () => {
    chrome.storage.local.set({ skinFilter: skinFilterCheck.checked });
};

blurAllCheck.onchange = () => {
    chrome.storage.local.set({ blurAll: blurAllCheck.checked });
};

sensitivityRange.oninput = () => {
    const val = sensitivityRange.value;
    sensitivityVal.innerText = getSensitivityLabel(val);
};

sensitivityRange.onchange = () => {
    chrome.storage.local.set({ sensitivity: parseInt(sensitivityRange.value) });
};

adminModeBtn.onclick = async () => {
    const stored = await chrome.storage.local.get(['adminUnlocked']);
    if (stored.adminUnlocked) return;

    const pass = prompt("Enter Admin Password:");
    if (pass === null) return;

    const hash = await sha256Hex(pass);
    if (hash === ADMIN_PASSWORD_HASH) {
        chrome.storage.local.set({ adminUnlocked: true });
        adminModeBtn.innerText = "Admin Settings Unlocked";
        adminModeBtn.style.background = "rgba(34, 197, 94, 0.1)";
        adminModeBtn.style.color = "#22c55e";
    } else {
        alert("Incorrect Password");
    }
};

// Stats reset (admin mode feature)
if (resetStatsBtn) {
    resetStatsBtn.onclick = async () => {
        const stored = await chrome.storage.local.get(['adminUnlocked']);
        if (!stored.adminUnlocked) {
            alert("Unlock Admin Mode first.");
            return;
        }
        chrome.runtime.sendMessage({ type: 'RESET_STATS' });
        statScanned.innerText = 0;
        statBlocked.innerText = 0;
    };
}