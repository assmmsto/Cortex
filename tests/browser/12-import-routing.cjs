/**
 * الثاني عشر: توجيه الاستيراد — أي مسار يذهب لأي محرّك (2026-11-06).
 *
 * العطل الذي وُلد منه هذا الاختبار:
 *   قسم الاستيراد كان يرسل **كل** رابط https إلى /api/import/web (جالِب صفحات)،
 *   فصار رابط مستودع GitHub يعود صفحة HTML بلا نص (kind=code · 0 حرف) — رغم أن
 *   المحرّك يملك استنساخاً كاملاً (/api/import/remote: git clone + حدود + تدقيق + تنظيف).
 *
 * الفحص بلا شبكة: نعترض الطلبات ونؤكد الوجهة فقط، فلا نستنسخ شيئاً ولا نكتب في الخزنة.
 */
'use strict';
const path = require('path');
const { chromium } = require(path.join(process.cwd(), 'node_modules', 'playwright-core'));

const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
const BASE = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const R = { p: 0, f: 0, c: [] };
const ok = (k, n, x) => { if (k) { R.p++; R.c.push('  ✔ ' + n + (x ? ' — ' + x : '')); } else { R.f++; R.c.push('  ✖ ' + n + (x ? ' — ' + x : '')); } };
const FAKE = { ok: true, scanned: 3, created: 3, skipped: 0, quarantined: 0, perFile: [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }], relationsAdded: 1 };

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message)));
  const seen = [];
  await p.route(/\/api\/import/, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    seen.push(new URL(req.url()).pathname);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE) });
  });

  await p.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForFunction(() => document.querySelectorAll('#library-list .tree-i').length > 0, null, { timeout: 25000 }).catch(() => {});
  await p.waitForTimeout(1000);
  const notesBefore = await p.evaluate(async () => ((await (await fetch('/api/notes')).json()).notes || []).length);

  await p.click('#rail .rail-btn[data-view="import"]');
  await p.waitForTimeout(700);
  R.c.push('══════ توجيه الاستيراد: مستودع · صفحة · ملف محلي ══════');

  const submit = async (value) => {
    seen.length = 0;
    await p.locator('#import-path').fill(value);
    await p.locator('#import-submit').click();
    await p.waitForTimeout(900);
    return seen.slice();
  };

  const git = await submit('https://github.com/mdn/beginner-html-site-scripted');
  ok(git.includes('/api/import/remote'), 'رابط مستودع GitHub ⇒ محرّك الاستنساخ', git.join(',') || '—');
  const gitDeep = await submit('https://github.com/user/repo.git');
  ok(gitDeep.includes('/api/import/remote'), 'عنوان ينتهي بـ .git ⇒ محرّك الاستنساخ', gitDeep.join(',') || '—');

  const web = await submit('https://example.com/some-page');
  ok(web.includes('/api/import/web'), 'صفحة عامة ⇒ جالب الويب', web.join(',') || '—');

  const local = await submit('docs/ROADMAP.md');
  ok(local.includes('/api/import') && !local.includes('/api/import/web'), 'مسار محلي ⇒ استيراد الملفات (لا جالب الويب)', local.join(',') || '—');

  // العرض الصادق: استجابة دفعية تُعلن «مفحوص 3 · أُنشئ 3» لا «أُنشئ 1»
  await submit('https://github.com/user/repo2');
  const shown = await p.evaluate(() => ({
    status: ((document.querySelector('#import-status') || {}).textContent || '').trim(),
    result: ((document.querySelector('#import-result') || {}).textContent || '').trim()
  }));
  ok(/3/.test(shown.status) && !/أُنشئ 1\b/.test(shown.status), 'النتيجة الدفعية تُعلن العدد الحقيقي لا «1»', shown.status.slice(0, 90));
  ok(shown.result.length > 0, 'قائمة الملفات معروضة', shown.result.slice(0, 60).replace(/\n/g, ' · '));

  const notesAfter = await p.evaluate(async () => ((await (await fetch('/api/notes')).json()).notes || []).length);
  ok(notesAfter === notesBefore, 'الاعتراض لم يكتب شيئاً في الخزنة', notesBefore + ' → ' + notesAfter);
  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | ') || '—');

  console.log(R.c.join('\n'));
  console.log(`\nFIN_importroute ${R.p} نجح · ${R.f} فشل`);
  await b.close();
  process.exit(R.f ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + e.message); process.exit(1); });