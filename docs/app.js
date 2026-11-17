/* Cortex v5 landing — bilingual, progressive enhancement, no dependencies. */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ---------- language ---------- */

  const META = {
    ar: {
      title: 'كورتكس — ذاكرة حيّة لمشاريعك',
      desc: 'كورتكس نظام تشغيل معرفة محلي: خزنة Markdown، ذاكرة مشاريع منظّمة في SQLite، استرجاع هجين، و28 أداة MCP تربط وكيلك بذاكرة مشاريعك — على جهازك.',
      locale: 'ar_AR',
      menu: 'القائمة',
    },
    en: {
      title: 'Cortex — A living memory for your projects',
      desc: 'Cortex is a local-first knowledge OS: a Markdown vault, structured project memory in SQLite, hybrid retrieval, and 28 MCP tools that connect your agent to your project memory.',
      locale: 'en_US',
      menu: 'Menu',
    },
  };

  const setMeta = (name, value) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    if (el) el.setAttribute('content', value);
  };
  const setProp = (prop, value) => {
    const el = document.querySelector(`meta[property="${prop}"]`);
    if (el) el.setAttribute('content', value);
  };

  const langButtons = $$('[data-set-lang]');

  const applyLang = (lang, persist) => {
    if (lang !== 'ar' && lang !== 'en') lang = 'ar';
    const html = document.documentElement;
    html.setAttribute('data-lang', lang);
    html.lang = lang;
    html.dir = lang === 'ar' ? 'rtl' : 'ltr';

    langButtons.forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.setLang === lang));
    });

    const m = META[lang];
    document.title = m.title;
    setMeta('description', m.desc);
    setProp('og:title', m.title);
    setProp('og:description', m.desc);
    setProp('og:locale', m.locale);
    const menuBtn = $('#menuBtn');
    if (menuBtn) menuBtn.setAttribute('aria-label', m.menu);

    if (persist) {
      try { localStorage.setItem('cortex-lang', lang); } catch (e) {}
      closeMenu();
    }
  };

  langButtons.forEach((b) => {
    b.addEventListener('click', () => applyLang(b.dataset.setLang, true));
  });

  // sync chrome on load with the value chosen by the inline bootstrap
  applyLang(document.documentElement.getAttribute('data-lang') || 'ar', false);

  /* ---------- header + progress ---------- */

  const header = $('#header');
  const progress = $('#progress');
  let ticking = false;

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY || document.documentElement.scrollTop;
      header.classList.toggle('is-scrolled', y > 8);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.width = (max > 0 ? Math.min(100, (y / max) * 100) : 0) + '%';
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- mobile menu ---------- */

  const menuBtn = $('#menuBtn');
  const mobileNav = $('#mobileNav');
  const menuIcon = $('use', menuBtn);

  const closeMenu = () => {
    mobileNav.classList.remove('is-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('is-locked');
    menuIcon.setAttribute('href', '#i-menu');
  };

  const toggleMenu = () => {
    const open = !mobileNav.classList.contains('is-open');
    mobileNav.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('is-locked', open);
    menuIcon.setAttribute('href', open ? '#i-close' : '#i-menu');
  };

  menuBtn.addEventListener('click', toggleMenu);
  $$('a', mobileNav).forEach((a) => a.addEventListener('click', closeMenu));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('resize', () => {
    if (window.innerWidth > 1080) closeMenu();
  });

  /* ---------- reveal ---------- */

  const revealEls = $$('[data-reveal]');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('is-in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
    revealEls.forEach((el) => io.observe(el));
  }

  /* ---------- counters ---------- */

  const counters = $$('[data-count]');
  if (counters.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      counters.forEach((el) => { el.textContent = el.dataset.count; });
    } else {
      const run = (el) => {
        const target = Number(el.dataset.count) || 0;
        if (!target) { el.textContent = '0'; return; }
        const start = performance.now();
        const dur = 900;
        const tick = (now) => {
          const t = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - t, 3);
          el.textContent = String(Math.round(target * eased));
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      };
      const cio = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          run(entry.target);
          cio.unobserve(entry.target);
        });
      }, { threshold: 0.6 });
      counters.forEach((el) => {
        el.textContent = '0';
        cio.observe(el);
      });
    }
  }

  /* ---------- tabs ---------- */

  const bindTabs = (buttons, activate) => {
    buttons.forEach((btn, i) => {
      btn.addEventListener('click', () => activate(btn));
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const next = buttons[(i + dir + buttons.length) % buttons.length];
        next.focus();
        activate(next);
      });
    });
  };

  /* ---------- MCP code tabs ---------- */

  const mcpTabs = $$('.tab[role="tab"]');
  const mcpPanels = $$('#mcp .code-panel');
  const mcpFile = $('#mcpFile');
  const copyMcp = $('#copyMcp');
  const fileNames = { 'panel-claude': 'shell', 'panel-json': 'json', 'panel-http': 'http' };

  const activateMcp = (btn) => {
    const id = btn.getAttribute('aria-controls');
    mcpTabs.forEach((t) => t.setAttribute('aria-selected', String(t === btn)));
    mcpPanels.forEach((p) => p.classList.toggle('is-active', p.id === id));
    mcpFile.textContent = fileNames[id] || 'shell';
    copyMcp.dataset.copy = id;
  };
  bindTabs(mcpTabs, activateMcp);

  /* ---------- clipboard ---------- */

  const toast = $('#toast');
  let toastTimer;
  const showToast = () => {
    toast.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-on'), 1700);
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove();
    }
  };

  const setCopyState = (btn, done) => {
    btn.classList.toggle('is-done', done);
    $$('.t-ar', btn).forEach((s) => { s.textContent = done ? 'تم النسخ' : 'نسخ'; });
    $$('.t-en', btn).forEach((s) => { s.textContent = done ? 'Copied' : 'Copy'; });
  };

  const flash = (btn) => {
    setCopyState(btn, true);
    setTimeout(() => setCopyState(btn, false), 1600);
  };

  copyMcp.addEventListener('click', async () => {
    const panel = document.getElementById(copyMcp.dataset.copy || 'panel-claude');
    const code = $('code', panel);
    await copyText(code.innerText.trim());
    flash(copyMcp);
    showToast();
  });

  const copyInstall = $('#copyInstall');
  copyInstall.addEventListener('click', async () => {
    const cmds = $$('#installCmd .cmd').map((el) => el.textContent.trim()).join('\n');
    await copyText(cmds);
    flash(copyInstall);
    showToast();
  });

  /* ---------- faq ---------- */

  const faqItems = $$('.faq-item');
  faqItems.forEach((item) => {
    item.addEventListener('toggle', () => {
      if (!item.open) return;
      faqItems.forEach((other) => { if (other !== item) other.open = false; });
    });
  });

  /* ---------- misc ---------- */

  const year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
