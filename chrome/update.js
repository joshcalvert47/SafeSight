const CHANGELOG = {
    "1.2": [
        "Enhanced AI image filtering with updated LiteRT engine.",
        "Fixed performance bottlenecks during page rescanning.",
        "Improved context menu responsiveness.",
        "Refined CSS for a cleaner user interface."
    ],
    "1.1": [
        "Added support for site-specific filtering toggles.",
        "Implemented persistent blocklists across sessions.",
        "Reduced memory footprint of the offscreen document."
    ],
    "1.0": [
        "Initial release of SafeSight Chrome Extension.",
        "Real-time NSFW image detection using on-device AI.",
        "Configurable allow/block lists for specific domains."
    ]
};

document.addEventListener('DOMContentLoaded', () => {
    const version = chrome.runtime.getManifest().version;
    document.getElementById('version-badge').textContent = `Version ${version}`;
    
    const changelogContainer = document.getElementById('changelog');
    const changes = CHANGELOG[version] || ["New updates and improvements for a safer browsing experience."];
    
    const section = document.createElement('div');
    section.className = 'changelog-section';
    
    const title = document.createElement('h2');
    title.textContent = `What's New in v${version}`;
    section.appendChild(title);
    
    changes.forEach(text => {
        const item = document.createElement('div');
        item.className = 'change-item';
        item.innerHTML = '<span class="bullet">•</span><span>' + text + '</span>';
        section.appendChild(item);
    });
    
    changelogContainer.appendChild(section);
    
    document.getElementById('close-btn').addEventListener('click', () => {
        window.close();
    });
});
