(function () {
  "use strict";

  // Orion/iOS may execute document_start before documentElement exists.
  // A missing root must not permanently skip the main-world audio listener.
  let installed = false;
  function mountBridge() {
    if (installed) return true;
    const root = document.documentElement || document.head;
    if (!root) return false;
    installed = true;
    if (root.getAttribute("data-ielts-native-audio-bridge") ||
        document.querySelector('script[data-ielts-safari-page-bridge="true"]')) return true;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("page-capture.js");
    script.dataset.ieltsSafariPageBridge = "true";
    script.addEventListener("load", () => script.remove(), { once: true });
    script.addEventListener("error", () => {
      script.remove();
      // The UI will explicitly show that site-audio listening is unavailable
      // if CSP or the iOS extension runtime blocks main-world injection.
      root.setAttribute("data-ielts-audio-bridge-injection-error", "yes");
    }, { once: true });
    root.appendChild(script);
    return true;
  }
  if (!mountBridge()) {
    document.addEventListener("readystatechange", mountBridge);
    document.addEventListener("DOMContentLoaded", mountBridge, { once: true });
  }
})();
