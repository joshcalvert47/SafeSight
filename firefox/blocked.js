// blocked.js — wiring for the SafeSight blocked-site page.
// No inline scripts: extension pages run under script-src 'self'.
(function () {
    const params = new URLSearchParams(window.location.search);
    const site = params.get('site') || '';
    const url = params.get('url') || '';

    if (site) {
        document.getElementById('blockedSite').textContent = site;
        document.title = 'Blocked: ' + site + ' — SafeSight';
    }

    document.getElementById('backBtn').addEventListener('click', () => {
        if (window.history.length > 1) {
            window.history.back();
        } else {
            window.location.replace('about:blank');
        }
    });

    const retryBtn = document.getElementById('retryBtn');
    if (url) {
        retryBtn.addEventListener('click', () => {
            window.location.replace(url);
        });
    } else {
        retryBtn.style.display = 'none';
    }
})();
