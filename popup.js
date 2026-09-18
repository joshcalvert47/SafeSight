// popup.js
const ADMIN_PASSWORD = "admin123";

const showRatingsCheck = document.getElementById('showRatings');
const skinFilterCheck = document.getElementById('skinFilter');
const blurAllCheck = document.getElementById('blurAll');
const adminModeBtn = document.getElementById('adminMode');
const sensitivityRange = document.getElementById('sensitivity');
const sensitivityVal = document.getElementById('sensitivityVal');
const statScanned = document.getElementById('statScanned');
const statBlocked = document.getElementById('statBlocked');

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

adminModeBtn.onclick = () => {
    chrome.storage.local.get(['adminUnlocked'], (res) => {
        if (res.adminUnlocked) return;

        const pass = prompt("Enter Admin Password:");
        if (pass === ADMIN_PASSWORD) {
            chrome.storage.local.set({ adminUnlocked: true });
            adminModeBtn.innerText = "Admin Settings Unlocked";
            adminModeBtn.style.background = "rgba(34, 197, 94, 0.1)";
            adminModeBtn.style.color = "#22c55e";
        } else if (pass !== null) {
            alert("Incorrect Password");
        }
    });
};