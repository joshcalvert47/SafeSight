// blocked.js — wiring for the SafeSight blocked-site page.
// No inline scripts: extension pages run under script-src 'self'.
//
// This page is reached two ways:
//   1. the content script / tabs.update path, which passes ?url=…&site=…
//   2. a declarativeNetRequest redirect, which cannot set a query string on a
//      URL it splices in, so it uses the fragment: #category=adult&url=<url>
//      The attempted URL is always LAST and unencoded, so everything after
//      "url=" is taken verbatim — otherwise the URL's own '&' would split it.
(function () {
    const params = new URLSearchParams(window.location.search);

    let site = params.get('site') || '';
    let url = params.get('url') || '';
    let category = params.get('category') || '';

    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (hash) {
        const at = hash.indexOf('url=');
        const optionPart = at === -1 ? hash : hash.slice(0, at);
        if (at !== -1) url = hash.slice(at + 4);
        const hashParams = new URLSearchParams(optionPart);
        if (!category) category = hashParams.get('category') || '';
        if (!site) site = hashParams.get('site') || '';
    }

    if (!site && url) {
        try { site = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { /* leave blank */ }
    }

    if (site) {
        document.getElementById('blockedSite').textContent = site;
        document.title = 'Blocked: ' + site + ' — SafeSight';
    }

    // Plainly say why, because the three lanes are genuinely different and a
    // vague "blocked" message is what makes people uninstall a filter.
    const REASONS = {
        adult: {
            title: 'Adult content blocked',
            body: 'SafeSight blocked this request before it left your browser. The ' +
                'site appears on the adult-content filter list, so no part of the page was downloaded.'
        },
        malware: {
            title: 'Unsafe site blocked',
            body: 'This address is on a malware and phishing list. SafeSight refused the ' +
                'request before any of the page loaded.'
        },
        ads: {
            title: 'Request blocked',
            body: 'This request matched the ads and trackers filter list and was blocked ' +
                'before it was sent.'
        },
        user: {
            title: 'Site blocked',
            body: 'You added this site to your own block list in the SafeSight popup.'
        },
        '': {
            title: 'Site Blocked',
            body: 'SafeSight blocked this site because it appears on your block list. ' +
                'The default list ships in blocklist.json; edit your list any time from the SafeSight popup.'
        }
    };

    const reason = REASONS[category] || REASONS[''];
    document.getElementById('pageTitle').textContent = reason.title;
    document.getElementById('reasonText').textContent = reason.body;
    document.title = reason.title + (site ? ': ' + site : '') + ' — SafeSight';

    // Only claim a category chip when we actually know the category.
    const chip = document.getElementById('categoryChip');
    const LABELS = {
        adult: 'Adult content list',
        malware: 'Malware / phishing list',
        ads: 'Ads & trackers list',
        user: 'Your block list'
    };
    if (category && LABELS[category]) {
        chip.textContent = LABELS[category];
        chip.style.display = 'inline-block';
    } else {
        chip.style.display = 'none';
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
