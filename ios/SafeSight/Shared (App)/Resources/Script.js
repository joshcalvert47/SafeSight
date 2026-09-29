function setText(className, text) {
    const element = document.getElementsByClassName(className)[0];
    if (element) element.innerText = text;
}

function show(platform, enabled, useSettingsInsteadOfPreferences) {
    document.body.classList.add(`platform-${platform}`);

    if (useSettingsInsteadOfPreferences) {
        setText('platform-mac state-on', "SafeSight’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.");
        setText('platform-mac state-off', "SafeSight’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.");
        setText('platform-mac state-unknown', "You can turn on SafeSight’s extension in the Extensions section of Safari Settings.");
        setText('platform-mac open-preferences', "Quit and Open Safari Settings…");
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function post(message) {
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.controller) {
        webkit.messageHandlers.controller.postMessage(message);
    }
}

function on(selector, message) {
    const button = document.querySelector(selector);
    if (button) button.addEventListener("click", function () { post(message); });
}

function openPreferences() {
    post("open-preferences");
}

const preferencesButton = document.querySelector("button.open-preferences");
if (preferencesButton) preferencesButton.addEventListener("click", openPreferences);

on("button.block-apps", "open-app-blocker");
on("button.block-sites", "open-block-sites");

/**
 * Paints the iOS dashboard. ViewController reads the app group (Screen Time
 * state, filters, counters) and hands the result over as a JSON object; this
 * only ever writes text, so nothing from the payload is interpreted as markup.
 *
 * Expected shape:
 *   { status, statusLabel, title, subtitle, scanned, blocked, sites,
 *     appBlocking, filters, steps: [String] }
 */
function showDashboard(state) {
    if (!state || typeof state !== "object") return;

    const setTextById = (id, value) => {
        const element = document.getElementById(id);
        if (element) element.textContent = value;
    };

    // Status hero — "active" / "attention" / "paused" drive the accent colour.
    const statusCard = document.getElementById("statusCard");
    if (statusCard) statusCard.dataset.state = state.status || "paused";

    setTextById("statusPill", state.statusLabel || "Status");
    setTextById("statusTitle", state.title || "Protection");
    setTextById("statusSubtitle", state.subtitle || "");

    // Counters.
    setTextById("statScanned", state.scanned ?? 0);
    setTextById("statBlocked", state.blocked ?? 0);
    setTextById("statSites", state.sites ?? "–");

    // Feature facts.
    const setFact = (id, isOn, onText, offText) => {
        const element = document.getElementById(id);
        if (!element) return;
        element.textContent = isOn ? onText : offText;
        element.classList.toggle("is-on", !!isOn);
        element.classList.toggle("is-off", !isOn);
    };

    setFact("factApps", state.appBlocking, "On", "Off");
    setFact("factFilters", state.filters, "On", "Off");

    // Setup checklist — only rendered while something is still outstanding.
    const setupCard = document.getElementById("setupCard");
    const setupSteps = document.getElementById("setupSteps");
    if (setupCard && setupSteps) {
        const steps = Array.isArray(state.steps) ? state.steps : [];
        setupSteps.replaceChildren();
        for (const step of steps) {
            const item = document.createElement("li");
            item.textContent = step;
            setupSteps.appendChild(item);
        }
        setupCard.hidden = steps.length === 0;
    }
}
