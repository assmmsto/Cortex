/**
 * السابع: نافذة MCP — التدفق الحقيقي من الواجهة (2026-10-30).
 *
 * يثبت ما يراه المستخدم ويلمسه فعلاً:
 *   • فتح النافذة، وعدّاد «28 أداة MCP» حياً من /api/mcp-info (لا نسخة متقادمة).
 *   • «اختبر الاتصال الآن»: نداء MCP كامل (بدء/تهيئة/نداء/إغلاق) ⇒ ✓ بزمن حقيقي.
 *   • «أضف واختبر»: تسجيل خادم خارجي + اكتشاف أدواته فعلياً عبر tools/list ⇒ ✓.
 *   • صفر أخطاء JS وصفر ردود فاشلة.
 * صورة الإثبات: shots/S6-mcp-modal.png
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const R = { p: 0, f: 0, c: [] };
const ok = (k, n, x) => { if (k) { R.p++; R.c.push('  ✔ ' + n + (x ? ' — ' + x : '')); } else { R.f++; R.c.push('  ✖ ' + n + (x ? ' — ' + x : '')); } };
const B = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [], bad = [];
  p.on('pageerror', e => errs.push(String(e.message)));
  p.on('response', r => {
    if (r.status() < 400) return;
    /* /mcp محروس بقصد: أي طلب لا يجتاز فحص الأصل يرجع 403 — وهذا سلوك أمني صحيح،
       لا عطل. الفحوص الوظيفية أعلاه تُثبت أن النداءات الشرعية ترجع 200. */
    if (r.status() === 403 && r.url().replace(B, '') === '/mcp') return;
    bad.push(r.status() + ' ' + r.url().replace(B, ''));
  });

  await p.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2600);

  R.c.push('══════ نافذة MCP — ما يراه المستخدم ══════');
  /* الفتح من واجهتها الحقيقية (زر mcp-btn) — بالنقر البرمجي لأن الزر قد يجلس
     خارج الشاشة الظاهرة (الشريط الأيقوني) والهدف هنا هو النافذة نفسها. */
  await p.evaluate(() => { const el = document.getElementById('mcp-btn'); if (el) el.click(); });
  await p.waitForTimeout(1200);
  ok(await p.locator('#modal-mcp').isVisible(), 'النافذة تفتح');

  /* العدّاد والشبكة — انتظار شرطي (لا نوم يفترض سرعة الرد) */
  let count = '';
  for (let i = 0; i < 25; i++) {
      count = await p.locator('#mcp-tools-hint').innerText().catch(() => '');
    if (/\d/.test(count)) break;
    await p.waitForTimeout(400);
  }
    ok(/28/.test(count), 'تلميح المودال يعرض 28 حياً من الخادم', count.trim().slice(0, 44));
    /* الأدوات تُعرض في قسم الأدوات وحده (2026-11-07): المودال يحيل، والشبكة هناك. */
    ok(await p.locator('#mcp-open-tools').count() === 1, 'زر «اعرض الأدوات» موجود في المودال');
    await p.locator('#mcp-open-tools').click();
    await p.waitForFunction(() => document.querySelectorAll('#mcp-tools-grid2 > *').length > 0, null, { timeout: 20000 }).catch(() => { });
    const chips = await p.locator('#mcp-tools-grid2 > *').count();
    ok(chips === 28, 'شبكة الأدوات في قسم الأدوات تعرض 28', chips + ' أداة');
    ok(await p.locator('#mcp-tools-grid2 > *', { hasText: 'memory_slice' }).count() === 1, 'أداة ذاكرة المشاريع (memory_slice) ظاهرة في الشبكة');
    /* العودة إلى المودال لإكمال فحوص الاتصال */
    await p.click('#mcp-btn');
    await p.waitForTimeout(800);

  const cfg = await p.locator('#mcp-config-display').innerText().catch(() => '');
  ok(/mcp-memory-server\.js/.test(cfg) && /cortex-memory/.test(cfg), 'كتلة الإعداد مولّدة حياً');

  /* الكتلة تُعرض **كاملة بلا تمرير داخلي** (قرار المستخدم 2026-10-30). */
  const fit = await p.evaluate(() => {
    const el = document.getElementById('mcp-config-display');
    return { sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth };
  });
  ok(fit.sh <= fit.ch + 2 && fit.sw <= fit.cw + 2, 'كتلة الإعداد كاملة بلا تمرير', `h ${fit.sh}/${fit.ch} · w ${fit.sw}/${fit.cw}`);

  /* الاتصال العام (2026-10-30): عنوان واحد مولَّد حياً بدل بطاقات «لكل عميل» */
  const urlTxt = (await p.locator('#mcp-url-display').innerText().catch(() => '')).trim();
  ok(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(urlTxt), 'العنوان العام يظهر مولَّداً من أصل الصفحة', urlTxt);
  ok(await p.locator('[data-copy="#mcp-url-display"]').count() === 1, 'زر نسخ العنوان موجود');
  ok(await p.locator('#mcp-preset-claude, #mcp-preset-opencode').count() === 0, 'بطاقات العملاء القديمة أُزيلت نهائياً');

  /* «اختبر الاتصال الآن» — نداء MCP حقيقي بارد (قد يستغرق حتى ~15ث) */
  await p.locator('#mcp-test-btn').click();
  let st = '';
  for (let i = 0; i < 80; i++) {
    st = (await p.locator('#mcp-test-status').innerText().catch(() => '')).trim();
    if (/^✓|^✗/.test(st)) break;
    await p.waitForTimeout(500);
  }
  ok(/^✓/.test(st), 'اختبر الاتصال الآن: ✓ نداء MCP فعلي', st.slice(0, 92));

  /* «أضف واختبر» — تسجيل خادم خارجي + اكتشاف أدواته فعلياً */
  await p.locator('#mcp-ext-name').fill('probe-ui');
  await p.locator('#mcp-ext-cmd').fill(process.execPath || 'node');
  /* عطل واجهة حقيقي (مُكتشف بهذا الاختبار — يُبلَّغ عنه ولا يُخفى): حقل args
     يُقسم على الفراغات (app.js: addExternalMcpServer) ولا يفهم الاقتباس "..." —
     فمسار مشروع يحوي مسافة («مجلد جديد») يستحيل تمريره كاملاً. النسبي يعمل لأن
     الخادم يُشغَّل بـ cwd = جذر المشروع. */
  await p.locator('#mcp-ext-args').fill('mcp-memory-server.js');
  await p.locator('#mcp-ext-add').click();
  let est = '';
  for (let i = 0; i < 100; i++) {
    est = (await p.locator('#mcp-ext-status').innerText().catch(() => '')).trim();
    if (/^✓|^✗/.test(est)) break;
    await p.waitForTimeout(500);
  }
  ok(/^✓/.test(est), 'أضف واختبر: ✓ اكتشاف فعلي عبر tools/list', est.slice(0, 92));

  /* حالة الربط وإلغاؤه من الواجهة (2026-10-30) — «مرتبط أم لا؟ وكيف ألغيه؟» */
  ok(await p.locator('[data-mcp-check="probe-ui"]').count() === 1, 'زر «فحص» ظاهر على بطاقة الخادم');
  ok(await p.locator('[data-mcp-unlink="probe-ui"]').count() === 1, 'زر «إلغاء الربط» ظاهر على البطاقة');
  const stateTxt = (await p.locator('.mcp-srow .mcp-sst').first().innerText().catch(() => '')).trim();
  ok(/وصل/.test(stateTxt), 'حالة آخر فحص تظهر على البطاقة', stateTxt.slice(0, 44));
  await p.locator('[data-mcp-unlink="probe-ui"]').first().click();
  let gone = 1;
  for (let i = 0; i < 30; i++) {
    gone = await p.locator('[data-mcp-unlink="probe-ui"]').count();
    if (gone === 0) break;
    await p.waitForTimeout(400);
  }
  ok(gone === 0, 'إلغاء الربط أزال البطاقة من الواجهة');
  const srvAfter = await p.evaluate(async () => (await (await fetch('/api/mcp/servers')).json()).servers.map(s => s.name));
  ok(!srvAfter.includes('probe-ui'), 'الخادم أُزيل من السجل فعلاً', srvAfter.join(','));
  /* «آخر اتصال وارد»: نداء MCP حقيقي من المتصفح ثم قراءة الحالة المسجّلة */
  ok(await p.locator('#mcp-incoming-status').count() === 1, 'سطر «آخر اتصال وارد» موجود في قسم الاتصال العام');
  const incAt = await p.evaluate(async () => {
    await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'initialize', params: {} }) });
    const j = await (await fetch('/api/mcp-info')).json();
    return (j && j.mcpHttp && j.mcpHttp.lastAt) || null;
  });
  ok(!!incAt, 'آخر اتصال وارد يُسجَّل فعلاً', String(incAt).slice(0, 19));

  /* أدوات الاتصال العام (أمر «نفذ» 2026-10-30): فحص + إيقاف/تشغيل — «لا نص بلا أداة» */
  ok(await p.locator('#mcp-general-test').count() === 1, 'زر «فحص الاتصال العام» موجود');
  ok(await p.locator('#mcp-toggle-incoming').count() === 1, 'زر إيقاف/تشغيل الاستقبال موجود');
  const togTxt0 = (await p.locator('#mcp-toggle-incoming').innerText().catch(() => '')).trim();
  ok(/إيقاف|تشغيل/.test(togTxt0), 'الزر يعرض حالته بوضوح', togTxt0.slice(0, 52));
  await p.locator('#mcp-general-test').click();
  let gst = '';
  for (let i = 0; i < 40; i++) {
    gst = (await p.locator('#mcp-general-test-status').innerText().catch(() => '')).trim();
    if (/^✓|^✗/.test(gst)) break;
    await p.waitForTimeout(250);
  }
  ok(/^✓/.test(gst), 'فحص الاتصال العام: ✓ نداء فعلي', gst.slice(0, 64));
  await p.locator('#mcp-toggle-incoming').click();
  let offStatus = 0;
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(300);
    offStatus = await p.evaluate(async () => {
      const r = await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 71, method: 'ping' }) });
      return r.status;
    });
    if (offStatus === 403) break;
  }
  ok(offStatus === 403, 'بعد «إيقاف الاستقبال»: الوافدون يُرفضون فعلاً', String(offStatus));
  await p.locator('#mcp-toggle-incoming').click();
  let onStatus = 0;
  for (let i = 0; i < 20; i++) {
    await p.waitForTimeout(300);
    onStatus = await p.evaluate(async () => {
      const r = await fetch('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 72, method: 'ping' }) });
      return r.status;
    });
    if (onStatus === 200) break;
  }
  ok(onStatus === 200, 'بعد «تشغيل الاستقبال»: يعود يستقبل', String(onStatus));

  /* صورة الإثبات — تلتقط الحالة النهائية (28 + ✓ + ✓) */
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  await p.screenshot({ path: path.join(__dirname, 'shots', 'S6-mcp-modal.png') });

  R.c.push('══════ الاستقرار ══════');
  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | '));
  const realBad = [...new Set(bad)];
  ok(realBad.length === 0, 'صفر ردود فاشلة', realBad.slice(0, 3).join(' | '));

  await b.close();
  console.log(R.c.join('\n'));
  console.log('\n═══ نافذة MCP: ' + R.p + ' نجح · ' + R.f + ' فشل ═══');
  process.exit(R.f ? 1 : 0);
})();
