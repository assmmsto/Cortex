/**
 * التاسع: تبويبات الحُكم — تنقّل داخلي بدل 9 بطاقات في عمود واحد (2026-11-06).
 *
 * القياس قبل الإصلاح: 18,941 حرفاً في عمود واحد بلا أي تنقّل، وأثقل شاشة في
 * المنتج. الإصلاح: 5 تبويبات داخل الشاشة نفسها (لا شاشة تاسعة) — كل تبويب
 * يعرض بطاقاته فقط ويحمل aria-selected، والاختيار يُحفظ ما دامت الصفحة حيّة.
 *
 * شروط النجاح: بطاقة واحدة على الأقل مرئية دائماً، وبطاقة واحدة مجموعة فقط،
 * وكل بطاقة من البطاقات التسع مصنَّفة، وصفر تجاوز أفقي على 375px.
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright-core'));

const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
const BASE = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const TABS = ['stages', 'quality', 'safety', 'relations', 'privacy'];

const R = { p: 0, f: 0, c: [] };
const ok = (k, n, x) => { if (k) { R.p++; R.c.push('  ✔ ' + n + (x ? ' — ' + x : '')); } else { R.f++; R.c.push('  ✖ ' + n + (x ? ' — ' + x : '')); } };

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 950 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));

  await p.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2200);
  await p.evaluate(() => { const btn = document.querySelector('#rail .rail-btn[data-view="governance"]'); if (btn) btn.click(); });
  await p.waitForTimeout(1600);

  R.c.push('══════ تبويبات الحُكم — قياس حقيقي ══════');

  const state = () => p.evaluate(() => {
    const cards = [...document.querySelectorAll('#view-governance .gov-card')];
    const visible = cards.filter((c) => !c.classList.contains('hidden'));
    const tabs = [...document.querySelectorAll('#gov-tabs [data-gov-tab]')];
    return {
      cards: cards.length,
      untagged: cards.filter((c) => !c.getAttribute('data-gov-tab')).length,
      visible: visible.length,
      groups: [...new Set(visible.map((c) => c.getAttribute('data-gov-tab')))],
      tabs: tabs.length,
      selected: tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.getAttribute('data-gov-tab')),
      active: tabs.filter((t) => t.classList.contains('on')).length,
      chars: visible.reduce((a, c) => a + c.innerText.length, 0),
      role: (document.querySelector('#gov-tabs') || {}).getAttribute ? document.querySelector('#gov-tabs').getAttribute('role') : ''
    };
  });

  const s0 = await state();
  ok(s0.cards === 9, 'البطاقات التسع موجودة', String(s0.cards));
  ok(s0.untagged === 0, 'كل بطاقة مصنَّفة لتبويب', s0.untagged ? s0.untagged + ' بلا تصنيف' : '—');
  ok(s0.tabs === TABS.length, 'عدد التبويبات 5', String(s0.tabs));
  ok(s0.role === 'tablist', 'التبويبات مُعلنة كـ tablist', s0.role || '—');
  ok(s0.visible > 0 && s0.groups.length === 1, 'تبويب واحد ظاهر فقط عند الفتح', JSON.stringify(s0.groups));
  ok(s0.selected.length === 1 && s0.active === 1, 'aria-selected و.on على تبويب واحد', JSON.stringify(s0.selected));
  ok(s0.chars < 4000, 'الحِمل الابتدائي انخفض (كان 18,941)', s0.chars + ' حرفاً');

  for (const t of TABS) {
    await p.evaluate((tab) => { const b2 = document.querySelector('#gov-tabs [data-gov-tab="' + tab + '"]'); if (b2) b2.click(); }, t);
    await p.waitForTimeout(320);
    const s = await state();
    ok(s.visible > 0 && s.groups.length === 1 && s.groups[0] === t,
      'التبويب «' + t + '» يعرض بطاقاته وحدها', JSON.stringify({ visible: s.visible, groups: s.groups }));
    ok(s.selected.length === 1 && s.selected[0] === t, 'aria-selected يتبع النقر — ' + t, JSON.stringify(s.selected));
  }

  /* التجاوز الأفقي: شريط التبويبات يمرّر داخلياً ولا يمدّ الصفحة */
  for (const w of [1440, 768, 375]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.waitForTimeout(320);
    const o = await p.evaluate(() => {
      const el = document.querySelector('#gov-tabs');
      return { page: document.documentElement.scrollWidth - window.innerWidth, tabsC: el.clientWidth, tabsS: el.scrollWidth };
    });
    ok(o.page === 0, 'صفر تجاوز أفقي على ' + w + 'px', 'page=' + o.page + ' tabs=' + o.tabsC + '/' + o.tabsS);
  }

  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | ') || '—');
  console.log(R.c.join('\n'));
  console.log(`\nFIN_govtabs ${R.p} نجح · ${R.f} فشل`);
  await b.close();
  process.exit(R.f ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });