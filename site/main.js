(function () {
  "use strict";

  var LANGUAGE_KEY = "fastcua.site.language";
  var languageButtons = document.querySelectorAll("[data-set-language]");
  var demo = document.querySelector("[data-demo]");
  var demoButtons = document.querySelectorAll("[data-demo-step]");
  var copyButton = document.querySelector("[data-copy-command]");

  function preferredLanguage() {
    try {
      var stored = localStorage.getItem(LANGUAGE_KEY);
      if (stored === "en" || stored === "zh") return stored;
    } catch (_) {}
    return "en";
  }

  function applyLanguage(language, persist) {
    var lang = language === "zh" ? "zh" : "en";
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = lang === "zh"
      ? "FastCUA — 面向 AI Agent 的 Windows 控制"
      : "FastCUA — Windows control for AI agents";

    document.querySelectorAll("[data-en][data-zh]").forEach(function (element) {
      var value = element.getAttribute("data-" + lang);
      if (element.children.length && element.firstChild && element.firstChild.nodeType === Node.TEXT_NODE) {
        element.firstChild.nodeValue = value + " ";
      } else {
        element.textContent = value;
      }
    });

    languageButtons.forEach(function (button) {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-set-language") === lang));
    });

    if (persist) {
      try { localStorage.setItem(LANGUAGE_KEY, lang); } catch (_) {}
    }
  }

  languageButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      applyLanguage(button.getAttribute("data-set-language"), true);
    });
  });

  demoButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var step = button.getAttribute("data-demo-step");
      if (demo) demo.setAttribute("data-demo", step);
      demoButtons.forEach(function (candidate) {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      });
    });
  });

  function legacyCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    var copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  }

  if (copyButton) {
    copyButton.addEventListener("click", function () {
      var command = document.getElementById("install-command").textContent.trim();
      var copy = navigator.clipboard && window.isSecureContext
        ? navigator.clipboard.writeText(command)
        : Promise.resolve(legacyCopy(command));

      copy.then(function () {
        var lang = document.documentElement.lang.startsWith("zh") ? "zh" : "en";
        copyButton.textContent = lang === "zh" ? "已复制" : "Copied";
        window.setTimeout(function () {
          copyButton.textContent = copyButton.getAttribute("data-" + lang);
        }, 1600);
      }).catch(function () {
        legacyCopy(command);
      });
    });
  }

  var revealNodes = document.querySelectorAll("[data-reveal]");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealNodes.forEach(function (node) { node.classList.add("is-visible"); });
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    revealNodes.forEach(function (node) { observer.observe(node); });
  }

  applyLanguage(preferredLanguage(), false);
})();
