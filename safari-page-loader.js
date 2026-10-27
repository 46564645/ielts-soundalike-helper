(function () {
  "use strict";

  const root = document.documentElement || document.head;
  if (!root || document.querySelector('script[data-ielts-safari-page-bridge="true"]')) return;

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-capture.js");
  script.dataset.ieltsSafariPageBridge = "true";
  script.addEventListener("load", () => script.remove(), { once: true });
  script.addEventListener("error", () => script.remove(), { once: true });
  root.appendChild(script);
})();
