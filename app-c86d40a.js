(function () {
  "use strict";
  var STORAGE_KEY = "guojiz.lang";
  var DEFAULT_LANG = "en";
  function supported(lang) { return lang === "zh" ? "zh" : DEFAULT_LANG; }
  function stored() { try { return supported(localStorage.getItem(STORAGE_KEY)); } catch (e) { return DEFAULT_LANG; } }
  function applyLang(lang) {
    lang = supported(lang);
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-en]").forEach(function (el) {
      var val = el.getAttribute("data-" + lang);
      if (val == null) return;
      if (el.tagName === "META") el.setAttribute("content", val);
      else if (el.tagName === "TITLE") document.title = val;
      else el.innerHTML = val;
    });
    document.querySelectorAll(".lang-opt").forEach(function (el) { el.classList.toggle("on", el.getAttribute("data-lang") === lang); });
  }
  var toggle = document.querySelector(".lang-toggle");
  toggle?.addEventListener("click", function () {
    var next = stored() === "en" ? "zh" : "en";
    try { localStorage.setItem(STORAGE_KEY, next); } catch (e) {}
    applyLang(next);
  });
  applyLang(stored());
  document.querySelectorAll("[data-rise]").forEach(function (el, i) { el.style.setProperty("--i", i); el.classList.add("rise"); });
  var copy = document.querySelector(".copy");
  var command = document.querySelector(".install-code code")?.textContent;
  copy?.addEventListener("click", async function () {
    await navigator.clipboard.writeText(command);
    copy.textContent = document.documentElement.lang === "zh" ? "已复制" : "Copied";
    setTimeout(function () { copy.textContent = document.documentElement.lang === "zh" ? "复制" : "Copy"; }, 1400);
  });
})();
