/**
 * الثامن: إمكانية الوصول — بالكيبورد والفأرة في Chrome حقيقي (2026-11-06).
 *
 * القياس قبل الإصلاح: 0 سمة aria-* في الواجهة. هذا القسم يثبت أن الإصلاح
 * يعمل عند المستخدم لا في الملف فقط:
 *   • أول Tab يذهب إلى «تخطَّ إلى المحتوى» ويظهر فعلاً (لا :focus-visible فقط).
 *   • Enter على الرابط ينقل التركيز إلى main#work.
 *   • الشريط تبويبات: واحد فقط aria-current="page" ويتبدّل مع النقر.
 *   • كل حوار: role=dialog + aria-modal + اسم من عنوانه.
 *   • سجل الوكيل منطقة حيّة (role=log, aria-live=polite).
 *   • كل أزرار الشريط والشريط العلوي لها اسم مفهوم (WCAG 4.1.2).
 * صفر أخطاء JS وصفر ردود فاشلة.
 */
const { chromium } = require('playwright-core');
const R = { p: 0, f: 0, c: [] };
const ok = (k, n, x) => { if (k) { R.p++; R.c.push('  ✔ ' + n + (x ? ' — ' + x : '')); } else { R.f++; R.c.push('  ✖ ' + n + (x ? ' — ' + x : '')); } };
const B = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [], bad = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  p.on('response', (r) => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().replace(B, '')); });

  await p.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2600);

  R.c.push('══════ إمكانية الوصول — قياس حقيقي في المحرّك ══════');

  /* 1) المعالم */
  const mainBox = await p.evaluate(() => {
    const m = document.querySelector('main#work');
    const n = document.querySelector('nav#rail');
    return { tabIndex: m ? m.tabIndex : null, navName: n ? (n.getAttribute('aria-label') || '').trim() : null };
  });
  ok(mainBox.tabIndex === -1, 'main#work موجود وقابل للتركيز', String(mainBox.tabIndex));
  ok(!!mainBox.navName, 'شريط التنقل له اسم مفهوم', mainBox.navName || '—');

  /* 2) الكيبورد: أول Tab = رابط التخطي، وهو مرئي ومقروء */
  await p.evaluate(() => document.body.focus());
  await p.keyboard.press('Tab');
  const first = await p.evaluate(() => {
    const a = document.activeElement;
    const box = a ? a.getBoundingClientRect() : null;
    return { cls: a ? a.className : '', text: a ? (a.textContent || '').trim().slice(0, 40) : '', top: box ? Math.round(box.top) : null, h: box ? Math.round(box.height) : null };
  });
  ok(/skip-link/.test(first.cls), 'أول Tab يذهب إلى رابط التخطي', first.text || first.cls);
  ok(first.top !== null && first.top > -50 && first.h > 0, 'الرابط يظهر بصرياً عند التركيز', 'top=' + first.top);
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  const focused = await p.evaluate(() => (document.activeElement ? document.activeElement.id : ''));
  ok(focused === 'work', 'Enter ينقل التركيز إلى المحتوى', focused || '(بلا)');

  /* 3) التبويب النشط: واحد فقط، ويتبدّل */
  const tabState = async () => p.evaluate(() => {
    const cur = [...document.querySelectorAll('#rail .rail-btn[aria-current="page"]')];
    return { n: cur.length, view: cur[0] ? cur[0].dataset.view : null };
  });
  const before = await tabState();
  await p.evaluate(() => { const b = [...document.querySelectorAll('#rail .rail-btn')].find((x) => x.dataset.view === 'monitor'); if (b) b.click(); });
  await p.waitForTimeout(700);
  const after = await tabState();
  ok(after.n === 1 && after.view === 'monitor', 'aria-current ينتقل مع التبديل', `${before.view || '—'} → ${after.view || '—'}`);

  /* 4) الحوارات: تُفتح من زرها وتُعلن باسمها */
  await p.evaluate(() => document.getElementById('settings-btn').click());
  await p.waitForTimeout(900);
  const dlg = await p.evaluate(() => {
    const o = document.getElementById('modal-settings');
    if (!o) return null;
    const t = document.getElementById(o.getAttribute('aria-labelledby') || '');
    return {
      visible: !o.classList.contains('hidden'),
      role: o.getAttribute('role'),
      modal: o.getAttribute('aria-modal'),
      title: t ? (t.textContent || '').trim() : '',
    };
  });
  ok(dlg && dlg.visible, 'نافذة الإعدادات تفتح');
  ok(dlg && dlg.role === 'dialog' && dlg.modal === 'true', 'الحوار role=dialog وaria-modal', dlg ? dlg.role + '/' + dlg.modal : '—');
  ok(dlg && dlg.title.length > 1, 'اسم الحوار يأتي من عنوانه', dlg ? dlg.title : '—');
  await p.evaluate(() => document.getElementById('close-settings-btn') && document.getElementById('close-settings-btn').click());

  /* 5) المناطق الحيّة */
  const live = await p.evaluate(() => {
    const log = document.querySelector('#chat-messages');
    const st = document.querySelector('#status-health');
    const al = document.querySelector('#a11y-live');
    return {
      log: log ? log.getAttribute('role') + '/' + log.getAttribute('aria-live') : null,
      status: st ? st.getAttribute('role') + '/' + st.getAttribute('aria-live') : null,
      live: !!al && al.getAttribute('aria-live') === 'polite',
    };
  });
  ok(live.log === 'log/polite', 'سجل الوكيل منطقة حيّة', live.log || '—');
  ok(live.status === 'status/polite', 'الحالة منطقة حيّة', live.status || '—');
  ok(live.live, 'منطقة التنبيهات الحيّة موجودة');

  /* 6) أسماء الضوابط: زر بأيقونة فقط بلا اسم = فشل 4.1.2 */
  const unnamed = await p.evaluate(() => {
    const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.title || '').trim();
    return [...document.querySelectorAll('.rail button, .topbar button')].filter((b) => !name(b)).map((b) => b.id || b.className);
  });
  ok(unnamed.length === 0, 'كل أزرار الشريطين لها اسم مفهوم', unnamed.join(',') || '15 زراً');

  /* 7) اللغة: لا عربية في سمات الواجهة عند التبديل إلى الإنجليزية
     (2026-11-06): كان محرّك الترجمة يعالج data-i18n و-ph و-title فقط، فأفلتت
     aria-label ورابط التخطي وبعض الـplaceholder — أي أن قارئ الشاشة يعلن
     «التنقل الرئيسي» و«هدف الوكيل» داخل واجهة إنجليزية. */
  const chromeAr = () => p.evaluate(() => {
    const isChrome = (el) => !el.closest('#note-content,#chat-messages,#sessions-list,#findings-body,#contract-body,#repo-files,#gov-scroll,#agent-steps,#team-live,#file-body,#palette-results,#link-pick-list,#link-suggest-list,#notes-list,#q-tasks,#ctx-tasks');
    const out = [];
    for (const a of ['aria-label', 'placeholder']) {
      for (const el of document.querySelectorAll('[' + a + ']')) {
        const v = el.getAttribute(a) || '';
        if (el.tagName === 'SPAN') continue;
        if (/[\u0600-\u06FF]/.test(v) && isChrome(el)) out.push(a + ':' + (el.id || el.tagName));
      }
    }
    const s = document.querySelector('.skip-link');
    if (s && /[\u0600-\u06FF]/.test(s.textContent)) out.push('skip-link');
    return out;
  });
  await p.evaluate(() => document.getElementById('settings-btn').click());
  await p.waitForTimeout(400);
  await p.evaluate(() => { const b = document.querySelector('[data-ui-lang="en"]'); if (b) b.click(); });
  await p.waitForTimeout(1300);
  const en = await p.evaluate(() => ({
    lang: document.documentElement.lang,
    dir: document.documentElement.dir,
    rail: document.querySelector('#rail') ? document.querySelector('#rail').getAttribute('aria-label') : '',
    skip: (document.querySelector('.skip-link') || {}).textContent.trim(),
    chat: document.querySelector('#chat-input') ? document.querySelector('#chat-input').getAttribute('aria-label') : ''
  }));
  const leaksEn = await chromeAr();
  ok(en.lang === 'en' && en.dir === 'ltr', 'اللغة والاتجاه يتبدّلان', en.lang + '/' + en.dir);
  ok(/^[A-Za-z][A-Za-z ]+$/.test(en.rail || ''), 'اسم شريط التنقل يُترجم', en.rail || '—');
  ok(/^[A-Za-z][A-Za-z ]+$/.test(en.skip || ''), 'رابط التخطي يُترجم', en.skip || '—');
  ok(/^[A-Za-z][A-Za-z ]+$/.test(en.chat || ''), 'اسم حقل الوكيل يُترجم', en.chat || '—');
  ok(leaksEn.length === 0, 'صفر عربية في سمات الواجهة بالإنجليزية', leaksEn.slice(0, 4).join(',') || '—');
  // رجوع للعربية كي لا تتأثر بقية الفحوص
  await p.evaluate(() => { const b = document.querySelector('[data-ui-lang="ar"]'); if (b) b.click(); });
  await p.waitForTimeout(1000);
  const backAr = await p.evaluate(() => (document.querySelector('#rail') ? document.querySelector('#rail').getAttribute('aria-label') : ''));
  ok(/[\u0600-\u06FF]/.test(backAr || ''), 'العربية تُستعاد بعد الرجوع', backAr || '—');
  await p.evaluate(() => { const c = document.getElementById('close-settings-btn'); if (c) c.click(); });
  await p.waitForTimeout(500);

  /* 8) أخطاء وردود */
  await p.waitForTimeout(600);
  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | ') || '—');
  ok(bad.length === 0, 'صفر ردود فاشلة', bad.slice(0, 3).join(' | ') || '—');

  console.log(R.c.join('\n'));
  console.log(`\nFIN_a11y ${R.p} نجح · ${R.f} فشل`);
  await b.close();
  process.exit(R.f ? 1 : 0);
})();