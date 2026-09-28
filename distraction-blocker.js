// KyberGate Distraction Blocker — Content Script
// Hides distracting elements on YouTube and reinforces SafeSearch on Google
// Controlled by org-level setting: distractionHidingEnabled

(function () {
  "use strict";

  // Prevent double-injection
  if (window.__kyberDistractionBlocker) return;
  window.__kyberDistractionBlocker = true;

  const hostname = location.hostname.replace(/^www\./, "");

  // ============================================================
  // CSS Rules — what to hide on each platform
  // ============================================================

  const YOUTUBE_HIDE_CSS = `
    /* === KyberGate Distraction Blocker === */

    /* Hide recommended/suggested videos sidebar */
    #related,
    #secondary,
    ytd-watch-next-secondary-results-renderer {
      display: none !important;
    }

    /* Hide comments section */
    #comments,
    ytd-comments,
    ytd-comments-header-renderer,
    ytd-item-section-renderer#sections {
      display: none !important;
    }

    /* Hide homepage feed — keep search bar and header visible */
    ytd-browse[page-subtype="home"] #contents.ytd-rich-grid-renderer,
    ytd-browse[page-subtype="home"] ytd-rich-grid-renderer,
    ytd-browse[page-subtype="home"] ytd-rich-item-renderer,
    ytd-browse[page-subtype="home"] ytd-rich-section-renderer,
    ytd-browse[page-subtype="home"] ytd-shelf-renderer {
      display: none !important;
    }

    /* Show a message on the homepage instead of the feed */
    ytd-browse[page-subtype="home"] #primary::before {
      content: "🔍 Use the search bar above to find educational content.";
      display: block;
      text-align: center;
      padding: 80px 20px 20px;
      font-size: 18px;
      color: #606060;
      font-family: "Roboto", Arial, sans-serif;
    }

    /* Hide autoplay toggle */
    .ytp-autonav-toggle-button,
    .ytp-autonav-toggle-button-container,
    [class*="autoplay"],
    .ytp-button[data-tooltip-target-id="ytp-autonav-toggle-button"] {
      display: none !important;
    }

    /* Hide end screen recommendations / cards */
    .ytp-ce-element,
    .ytp-ce-covering-overlay,
    .ytp-ce-element-shadow,
    .ytp-ce-covering-image,
    .ytp-ce-expanding-image,
    .ytp-ce-video,
    .ytp-ce-playlist,
    .ytp-ce-channel,
    .ytp-endscreen-content,
    .html5-endscreen,
    .videowall-endscreen {
      display: none !important;
    }

    /* Hide "Up next" section and auto-play queue */
    ytd-compact-autoplay-renderer,
    .ytp-upnext,
    .ytp-suggestion-set,
    .autoplay-bar {
      display: none !important;
    }

    /* Hide Shorts shelf on any page */
    ytd-reel-shelf-renderer,
    ytd-rich-shelf-renderer[is-shorts],
    [is-shorts],
    ytd-shorts {
      display: none !important;
    }

    /* Hide notification bell popover distractions */
    ytd-notification-topbar-button-renderer .yt-spec-icon-badge-shape--type-notification {
      display: none !important;
    }

    /* Hide trending/explore sidebar items */
    ytd-guide-entry-renderer a[href="/feed/trending"],
    ytd-guide-entry-renderer a[href="/feed/explore"],
    ytd-mini-guide-entry-renderer a[href="/feed/trending"],
    ytd-mini-guide-entry-renderer a[href="/feed/explore"] {
      display: none !important;
    }
  `;

  const GOOGLE_SAFESEARCH_CSS = `
    /* === KyberGate SafeSearch Reinforcement === */
    /* Hide SafeSearch toggle controls to prevent students from disabling it */
    #base_safesearch,
    [data-safesearch],
    .safesearch-toggle,
    #safeSearchToggle {
      display: none !important;
      pointer-events: none !important;
    }
  `;

  // ============================================================
  // State
  // ============================================================

  let isEnabled = false;
  let styleElement = null;
  let observer = null;
  let policyCheckInterval = null;

  // ============================================================
  // Policy Check — ask background for distraction hiding status
  // ============================================================

  function checkPolicy() {
    try {
      chrome.runtime.sendMessage(
        { type: "GET_DISTRACTION_POLICY" },
        (response) => {
          if (chrome.runtime.lastError) {
            // Extension context invalidated — stop polling
            stopPolling();
            return;
          }
          const wasEnabled = isEnabled;
          isEnabled = !!(response && response.enabled);

          if (isEnabled && !wasEnabled) {
            applyBlocking();
          } else if (!isEnabled && wasEnabled) {
            removeBlocking();
          }
        }
      );
    } catch (e) {
      // Extension context invalidated
      stopPolling();
    }
  }

  // ============================================================
  // Apply / Remove Blocking
  // ============================================================

  function applyBlocking() {
    if (styleElement) return; // Already applied

    styleElement = document.createElement("style");
    styleElement.id = "kybergate-distraction-blocker";
    styleElement.setAttribute("data-kybergate", "distraction-blocker");

    if (hostname.includes("youtube.com")) {
      styleElement.textContent = YOUTUBE_HIDE_CSS;
    } else if (hostname.includes("google.")) {
      styleElement.textContent = GOOGLE_SAFESEARCH_CSS;
      enforceGoogleSafeSearch();
    }

    // Insert into <html> as early as possible (before <body> may exist)
    const target = document.head || document.documentElement;
    target.appendChild(styleElement);

    // Start MutationObserver for YouTube SPA navigation
    if (hostname.includes("youtube.com")) {
      startYouTubeObserver();
    }

    console.debug("[KyberGate] Distraction blocker active");
  }

  function removeBlocking() {
    if (styleElement) {
      styleElement.remove();
      styleElement = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    console.debug("[KyberGate] Distraction blocker removed");
  }

  // ============================================================
  // YouTube SPA Observer
  // YouTube is a single-page app — the URL changes without a full
  // page reload. We watch for navigation events to re-apply CSS
  // and handle dynamically loaded content.
  // ============================================================

  function startYouTubeObserver() {
    if (observer) observer.disconnect();

    let lastUrl = location.href;

    observer = new MutationObserver(() => {
      // Detect SPA navigation (URL changed)
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        onYouTubeNavigate();
      }

      // Ensure our style element is still in the DOM
      // (YouTube sometimes clears/rebuilds the page)
      if (styleElement && !document.contains(styleElement)) {
        const target = document.head || document.documentElement;
        target.appendChild(styleElement);
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    // Also intercept history API for SPA navigation
    interceptHistoryAPI();

    // Initial check
    onYouTubeNavigate();
  }

  function onYouTubeNavigate() {
    // Disable autoplay programmatically when possible
    disableAutoplay();

    // Remove any lingering end screen elements that CSS might miss
    removeEndScreenElements();
  }

  function disableAutoplay() {
    // Try to find and disable the autoplay toggle
    try {
      const toggle = document.querySelector(
        ".ytp-autonav-toggle-button"
      );
      if (toggle) {
        const isOn = toggle.getAttribute("aria-checked") === "true";
        if (isOn) {
          toggle.click();
        }
      }
    } catch (e) {
      // Non-critical
    }
  }

  function removeEndScreenElements() {
    // Actively remove end screen elements (belt and suspenders with CSS)
    try {
      document
        .querySelectorAll(
          ".ytp-ce-element, .html5-endscreen, .videowall-endscreen"
        )
        .forEach((el) => {
          el.style.display = "none";
        });
    } catch (e) {
      // Non-critical
    }
  }

  // ============================================================
  // History API Interception (for SPA navigation detection)
  // ============================================================

  let historyIntercepted = false;

  function interceptHistoryAPI() {
    if (historyIntercepted) return;
    historyIntercepted = true;

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      originalPushState.apply(this, args);
      onYouTubeNavigate();
    };

    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      originalReplaceState.apply(this, args);
      onYouTubeNavigate();
    };

    window.addEventListener("popstate", () => onYouTubeNavigate());
  }

  // ============================================================
  // Google SafeSearch Enforcement
  // ============================================================

  function enforceGoogleSafeSearch() {
    // If on a Google search page without safe=active, redirect
    try {
      const url = new URL(location.href);
      if (
        url.hostname.includes("google.") &&
        url.pathname === "/search" &&
        url.searchParams.get("safe") !== "active"
      ) {
        url.searchParams.set("safe", "active");
        location.replace(url.toString());
      }
    } catch (e) {
      // Non-critical
    }

    // Watch for form submissions that might remove SafeSearch
    document.addEventListener(
      "submit",
      (e) => {
        try {
          const form = e.target;
          if (form && form.tagName === "FORM") {
            // Ensure safe=active is included
            let safeInput = form.querySelector('input[name="safe"]');
            if (!safeInput) {
              safeInput = document.createElement("input");
              safeInput.type = "hidden";
              safeInput.name = "safe";
              form.appendChild(safeInput);
            }
            safeInput.value = "active";
          }
        } catch (e) {
          // Non-critical
        }
      },
      true
    );
  }

  // ============================================================
  // Polling & Lifecycle
  // ============================================================

  function startPolling() {
    // Check policy immediately
    checkPolicy();

    // Re-check every 60 seconds (policy might change during session)
    policyCheckInterval = setInterval(checkPolicy, 60000);
  }

  function stopPolling() {
    if (policyCheckInterval) {
      clearInterval(policyCheckInterval);
      policyCheckInterval = null;
    }
  }

  // ============================================================
  // Initialize
  // ============================================================

  function init() {
    startPolling();
  }

  // Start when DOM is available
  if (
    document.readyState === "interactive" ||
    document.readyState === "complete"
  ) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();
