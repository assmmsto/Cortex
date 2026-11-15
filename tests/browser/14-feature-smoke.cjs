'use strict';
/**
 * ١٤ — تدقيق وظيفي شامل: كل شاشات النظام ووظائفه الأساسية على الخادم المعزول.
 *
 * الغاية: لا نكتفي بأن «الحزم خضراء»؛ نُثبت أن المنتج يعمل من طرف إلى طرف:
 * كل شاشة تُرسم بعنصرها المميّز · دورة ملاحظة كاملة تصل إلى القرص · البحث ·
 * الإعدادات (لغة/حجم خط) · لوحة الأوامر · صفر خطأ JS وصفر ردّ ≥400.
 *
 * المصدر: مجسّ تدقيق يدوي (2026-11-11) حوّلناه إلى اختبار دائم لأنه كشف عطلاً
 * حقيقياً (indexStale لا يصل إلى الواجهة) لا تكشفه بقية الأقسام.
 */
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', '..', 'node_modules', 'playwright-core'));
const iso = require('./_isolate.cjs');
const { resolveChrome } = require('./_chrome.cjs');

const VIEWS = [
  ['notes', '#library-list'],
  ['graph', '.fm-stage'],
  ['monitor', '#view-monitor'],
  ['repos', '#view-repos'],
  ['providers', '#provider-list'],
  ['import', '#view-import'],
  ['tools', '#view-tools'],
  ['governance', '#view-governance'],
];

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass += 1; console.log('  ✔ ' + label + (detail ? ' — ' + detail : '')); }
  else { fail += 1; console.log('  ✖ ' + label + (detail ? ' — ' + detail : '')); }
};

(async () => {
  const srv = await iso.start({ seed: 24 });
  const b = await chromium.launch({ executablePath: resolveChrome(), headless: true });
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const badHttp = [];
  p.on('pageerror', (e) => errors.push('JS: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 120)); });
  p.on('response', (r) => { if (r.status() >= 400) badHttp.push(r.status() + ' ' + r.url().replace(srv.base, '')); });

  try {
    await p.goto(srv.base + '/', { waitUntil: 'load', timeout: 30000 });
    await p.waitForFunction(() => document.querySelectorAll('#library-list .tree-i').length > 0, null, { timeout: 25000 });
    ok(true, 'الصفحة أقلعت وظهرت المكتبة');

    for (const [v, sel] of VIEWS) {
      const before = errors.length;
      await p.click(`[data-view="${v}"]`).catch(() => {});
      await p.waitForTimeout(1100);
      const info = await p.evaluate((x) => {
        const el = document.querySelector(x);
        if (!el) return { visible: false, children: 0 };
        return { visible: !!(el.offsetParent || el.getClientRects().length), children: el.children.length };
      }, sel);
      ok(info.visible, `شاشة ${v} تُرسم (${sel})`, 'عناصر=' + info.children);
      if (errors.length > before) console.log('     ↳ أخطاء: ' + errors.slice(before).join(' | '));
    }

    const call = (method, url, body, withSession) => p.evaluate(async ({ method, url, body, withSession }) => {
      const headers = { 'Content-Type': 'application/json' };
      if (withSession) headers['x-cortex-session'] = (await (await fetch('/api/session')).json()).token;
      const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch { /* غير JSON */ }
      return { status: r.status, json: j };
    }, { method, url, body, withSession });

    const title = 'تدقيق-وظيفي-' + Date.now();
    const created = await call('POST', '/api/notes', { title, content: '# ' + title + '\n\nنص تدقيق.', type: 'note' }, true);
    ok(created.status === 200, 'إنشاء ملاحظة', 'HTTP ' + created.status);
    const id = created.json && created.json.note && created.json.note.id;

    const readBack = await call('GET', '/api/notes/' + encodeURIComponent(id), null, false);
    ok(readBack.status === 200 && String((readBack.json.note || {}).content || '').includes('نص تدقيق'), 'قراءة الملاحظة من القرص', 'HTTP ' + readBack.status);

    const edited = await call('POST', '/api/notes', { id, title, content: '# معدّل\n\nنص بعد التعديل.', type: 'note' }, true);
    ok(edited.status === 200, 'تعديل الملاحظة (POST مع id — عقد الواجهة نفسه)', 'HTTP ' + edited.status);
    const afterEdit = await call('GET', '/api/notes/' + encodeURIComponent(id), null, false);
    ok(String((afterEdit.json.note || {}).content || '').includes('نص بعد التعديل'), 'التعديل وصل إلى القرص فعلاً');

    const del = await call('DELETE', '/api/notes/' + encodeURIComponent(id), null, true);
    ok(del.status === 200 || del.status === 404, 'حذف الملاحظة', 'HTTP ' + del.status);
    const afterDel = await call('GET', '/api/notes/' + encodeURIComponent(id), null, false);
    ok(afterDel.status === 404, 'المحذوفة لم تعد تُقرأ (404)', 'HTTP ' + afterDel.status);

    const search = await p.evaluate(async () => {
      /* الاستعلام يطابق **بذرة الأرضية المعزولة** (وسم «اختبار» ونصّ عربي)،
         لا خزنة المستخدم — اختبار «memory» على ٢٤ ملاحظة بذرية يعيد صفراً بحقّ. */
      const r = await fetch('/api/search?q=' + encodeURIComponent('اختبار') + '&limit=5');
      const j = await r.json().catch(() => ({}));
      return { status: r.status, n: (j.results || []).length, stale: j.indexStale };
    });
    ok(search.status === 200 && search.n > 0, 'البحث يعيد نتائج', 'HTTP ' + search.status + ' · نتائج=' + search.n);
    ok(typeof search.stale === 'boolean', 'حالة الفهرس مُعلنة في ردّ البحث', 'indexStale=' + search.stale);

    await p.click('#settings-btn');
    await p.waitForTimeout(400);
    await p.waitForFunction(() => {
      const el = document.getElementById('active-model-line');
      return !!el && (el.textContent || '').trim().length > 0;
    }, null, { timeout: 5000 }).catch(() => {});
    const filled = await p.evaluate(() => ({
      provider: (document.getElementById('active-model-line') || {}).textContent || '',
      temp: (document.getElementById('temp-input') || {}).value,
      prov: (document.getElementById('retrieval-provider-select') || {}).value,
      auth: (document.getElementById('autonomy-select') || {}).value,
    }));
    ok(!!filled.provider.trim(), 'سطر المزوّد النشط ممتلئ', filled.provider.slice(0, 40));
    ok(filled.temp !== undefined && filled.temp !== '', 'الحرارة ممتلئة', String(filled.temp));
    ok(!!filled.prov, 'مزوّد الاسترجاع محدَّد', String(filled.prov));
    ok(!!filled.auth, 'وضع الاستقلالية محدَّد', String(filled.auth));

    await p.click('[data-ui-lang="en"]');
    await p.waitForTimeout(1100);
    const en = await p.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir, save: (document.querySelector('[data-i18n="b_save"]') || {}).textContent }));
    ok(en.lang === 'en' && en.dir === 'ltr' && /Save/i.test(en.save || ''), 'الإنجليزية تغيّر النص والاتجاه', JSON.stringify(en));

    await p.click('[data-ui-fz="xl"]');
    await p.waitForTimeout(400);
    const zoom = await p.evaluate(() => getComputedStyle(document.documentElement).zoom);
    ok(Number(zoom) > 1.05, 'حجم XL يكبّر فعلاً', 'zoom=' + zoom);
    const saveBox = await p.evaluate(() => { const el = document.getElementById('save-settings-btn'); const r = el.getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: innerHeight }; });
    ok(saveBox.bottom <= saveBox.h, 'زر الحفظ داخل الشاشة عند XL', saveBox.bottom + '≤' + saveBox.h);

    await p.click('[data-ui-fz="m"]');
    await p.click('[data-ui-lang="ar"]');
    await p.waitForTimeout(700);
    await p.click('#close-settings-btn').catch(() => {});
    await p.waitForTimeout(400);

    await p.keyboard.press('Control+k').catch(() => {});
    await p.waitForTimeout(600);
    const palOpen = await p.evaluate(() => { const el = document.getElementById('palette'); return !!el && !el.classList.contains('hidden'); });
    ok(palOpen, 'لوحة الأوامر تُفتح بـCtrl+K');
    const palResults = await p.evaluate(async () => {
      const i = document.getElementById('palette-input');
      if (!i) return 0;
      i.value = 'memory';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 900));
      return document.querySelectorAll('#palette-results [role="option"]').length;
    });
    ok(palResults > 0, 'لوحة الأوامر تعرض نتائج (بدلالة option)', 'عناصر=' + palResults);
    await p.keyboard.press('Escape').catch(() => {});

    const realErrors = errors.filter((e) => !/favicon|net::ERR_ABORTED/i.test(e) && !String(e).includes('404'));
    ok(realErrors.length === 0, 'صفر خطأ JS/console', realErrors.slice(0, 3).join(' | ') || 'نظيف');
    const realBad = badHttp.filter((x) => !/favicon/.test(x) && !String(x).includes(encodeURIComponent(id)));
    ok(realBad.length === 0, 'صفر ردّ ≥400 (بلا فحص المحذوفة المقصود)', realBad.slice(0, 5).join(' | ') || 'نظيف');
  } finally {
    await b.close();
    await srv.stop();
  }

  console.log(`\nFIN_features ${pass} نجح · ${fail} فشل`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });