(() => {
  const root = document.documentElement;
  const stored = localStorage.getItem("fastcua-lang");
  let lang = stored === "zh" || stored === "en" ? stored : (navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en";

  function applyLang(next) {
    lang = next;
    localStorage.setItem("fastcua-lang", lang);
    root.lang = lang === "zh" ? "zh-CN" : "en";
    document.querySelectorAll("[data-en]").forEach((el) => {
      const en = el.getAttribute("data-en");
      const zh = el.getAttribute("data-zh");
      if (en == null) return;
      const value = lang === "zh" && zh != null ? zh : en;
      if (el.dataset.html === "1") el.innerHTML = value;
      else el.textContent = value;
    });
    document.querySelectorAll(".lang-btn").forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset.lang === lang ? "true" : "false");
    });
    const title = document.querySelector("title");
    if (title) {
      title.textContent = lang === "zh" ? "FastCUA · Windows Computer Use 运行时" : "FastCUA · Windows Computer Use Runtime";
    }
    const meta = document.querySelector('meta[name="description"]');
    if (meta) {
      meta.setAttribute(
        "content",
        lang === "zh"
          ? "面向 AI Agent 的 Windows Computer Use 运行时 — 无障碍优先、Skill + MCP、本地优先。一句话安装：npx fastcua"
          : "Windows Computer Use runtime for AI agents — UIA-first, Skill + MCP, local-first. One-line: npx fastcua",
      );
    }
  }

  document.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyLang(btn.dataset.lang));
  });
  applyLang(lang);

  // sticky top
  const top = document.querySelector(".top");
  const onScroll = () => top?.classList.toggle("scrolled", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // reveal
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add("in");
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" },
  );
  document.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));

  // grid demo pulse
  const cells = [...document.querySelectorAll(".grid-demo .cell")];
  let i = 0;
  if (cells.length) {
    setInterval(() => {
      cells.forEach((c) => c.classList.remove("active"));
      cells[i % cells.length].classList.add("active");
      i += 1;
    }, 900);
  }

  // install tabs
  const panels = {
    npm: "npx fastcua",
    ps: "irm https://raw.githubusercontent.com/Guojiz/FastCUA/main/install.ps1 | iex",
  };
  const codeEl = document.querySelector("#install-code");
  document.querySelectorAll(".install-tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".install-tabs button").forEach((b) => b.setAttribute("aria-selected", "false"));
      btn.setAttribute("aria-selected", "true");
      if (codeEl) codeEl.textContent = panels[btn.dataset.tab] || panels.npm;
    });
  });

  // copy
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = document.querySelector(btn.getAttribute("data-copy"));
      const text = target?.textContent?.trim() || "";
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.classList.add("ok");
        btn.textContent = lang === "zh" ? "已复制" : "Copied";
        setTimeout(() => {
          btn.classList.remove("ok");
          btn.textContent = prev;
        }, 1400);
      } catch {
        /* ignore */
      }
    });
  });
})();
