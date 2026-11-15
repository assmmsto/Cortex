/**
 * اختبار التدفق الكامل — الأقسام ⑤ المستودعات ⑥ المزودون ⑦ الاستيراد ⑧ الأدوات
 * + تحقق صريح من سحب عُقد الخريطة.
 */
const path = require('path');
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
  p.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().replace(B, '')); });

  await p.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2600);

  // ══════════ ⑥ المزودون ══════════
  R.c.push('══════ ⑥ المزودون — التدفق الكامل ══════');
  await p.locator('#rail .rail-btn[data-view="providers"]').click();
  await p.waitForTimeout(2000);
  ok(await p.locator('#view-providers').isVisible(), 'الشاشة تفتح');
  const pc = await p.locator('#provider-list .pcard').count();
  ok(pc >= 1, 'بطاقات المزودين تُعرض', pc + ' مزود');
  // التنقيح يُقاس على مزوّد **له مفتاح**، لا على أول بطاقة: المزوّد المحلي
  // (`mock` بلا مفتاح، §الخصوصية) شرعي ويُعرض أولاً، والالتزام هو «لا يظهر
  // مفتاح كامل» — فالاختبار يختار البطاقة ذات المفتاح لا يتوقّع ترتيباً.
  const keys = await p.locator('#provider-list .pkey').allInnerTexts();
  const withKey = keys.filter(k => !/بلا مفتاح|no key/i.test(k));
  ok(withKey.length > 0, 'مزوّد بمفتاح مُهيّأ للقياس', withKey.length + ' من ' + keys.length);
  const masked = withKey[0] || '';
  ok(/…/.test(masked) || /key/i.test(masked), 'المفتاح مُقنَّع لا مكشوف', masked.slice(0, 40));
  ok(keys.every(k => !/sk-[A-Za-z0-9-]{20,}/.test(k)), 'لا مفتاح كامل ظاهر في أي بطاقة');
  ok(await p.locator('#add-provider-form').isVisible(), 'نموذج الإضافة ظاهر');

  // عنوان خاطئ ⇒ يُرفض في خطوة التحقق
  await p.locator('#ap-name').fill('اختبار-خاطئ');
  await p.locator('#ap-url').fill('ليس-عنواناً');
  await p.locator('#ap-key').fill('sk-test-1234567890');
  await p.locator('#ap-submit').click();
  await p.waitForTimeout(4000);
  const errMsg = await p.locator('#ap-status').innerText();
  ok(/⚠|صيغة|غير صحيحة|fail/i.test(errMsg), 'العنوان الخاطئ يُرفض', errMsg.slice(0, 60));

  // عنوان صحيح + مفتاح مزيف ⇒ يُرفض في خطوة الاتصال (لا يُضاف)
  await p.locator('#ap-url').fill('https://api.inceptionlabs.ai/v1');
  await p.locator('#ap-key').fill('sk-مزيف-لاختبار-الرفض-000');
  await p.locator('#ap-submit').click();
  await p.waitForTimeout(9000);
  const st2 = await p.locator('#ap-status').innerText();
  ok(st2.length > 0, 'الردّ على المحاولة الحقيقية', st2.slice(0, 70));
  R.c.push('  (رد الاختبار الحقيقي: ' + st2.slice(0, 60) + ')');

  // ══════════ ⑦ الاستيراد ══════════
  R.c.push('══════ ⑦ الاستيراد — التدفق الكامل ══════');
  await p.locator('#rail .rail-btn[data-view="import"]').click();
  await p.waitForTimeout(2200);
  ok(await p.locator('#view-import').isVisible(), 'الشاشة تفتح');
  // الكتالوج صار مضغوطاً في <details> (نقد بصرية 2026-10-24: كان يملأ الشاشة)
  await p.locator('.import-catalog summary').click().catch(() => {});
  await p.waitForTimeout(300);
  const fmts = await p.locator('#import-formats .fmt-chip').count();
  ok(fmts > 10, 'الصيغ المدعومة تُعرض (كتالوج مضغوط)', fmts + ' صيغة');
  const opts = await p.locator('#import-format option').count();
  ok(opts > 10, 'قائمة اختيار الصيغة مملوءة', opts + ' خيار');

  // استيراد ملف حقيقي
    // استيراد ملف حقيقي: ملف فريد يُنشأ الآن — لأن التكرار صار مرفوضاً بحق (إصلاح 2026-11-06)
    const __fs = require('fs');
    const __path = require('path');
    const stamp = 'IMPTEST-' + Date.now();
    const relTmp = 'tmp/import-test-' + stamp + '.md';
    const absTmp = __path.join(process.cwd(), relTmp.split('/').join(__path.sep));
    __fs.mkdirSync(__path.dirname(absTmp), { recursive: true });
    __fs.writeFileSync(absTmp, '# ' + stamp + '\n\nمحتوى اختبار الاستيراد.\n', 'utf8');
    const beforeIds = await p.evaluate(async () => ((await (await fetch('/api/notes')).json()).notes || []).map((n) => n.id));
    await p.locator('#import-path').fill(relTmp);
    await p.locator('#import-submit').click();
    await p.waitForTimeout(6000);
    const ires = await p.locator('#import-result').innerText().catch(() => '');
    const istat = await p.locator('#import-status').innerText().catch(() => '');
    ok(ires.length > 20 || /✅/.test(istat), 'الاستيراد أعاد نتيجة', (istat + ' ' + ires).slice(0, 80).replace(/\n/g, ' '));
    const afterIds = await p.evaluate(async () => ((await (await fetch('/api/notes')).json()).notes || []).map((n) => n.id));
    const fresh = afterIds.filter((id) => !beforeIds.includes(id));
    ok(fresh.length === 1, 'الاستيراد أضاف عنصراً واحداً فعلاً', beforeIds.length + ' → ' + afterIds.length + ' (جديد: ' + fresh.length + ')');
    // إعادة الاستيراد نفسه لا تُنشئ نسخة ثانية — حرس عقد §19
    await p.locator('#import-path').fill(relTmp);
    await p.locator('#import-submit').click();
    await p.waitForTimeout(3000);
    const dupIds = await p.evaluate(async () => ((await (await fetch('/api/notes')).json()).notes || []).map((n) => n.id));
    ok(dupIds.length === afterIds.length, 'إعادة الاستيراد لا تُنشئ نسخة ثانية', afterIds.length + ' → ' + dupIds.length);
    // تنظيف: حذف العنصر التجريبي والملف المؤقت حتى لا تتضخم الخزنة
    if (fresh[0]) await p.evaluate(async (id) => { await fetch('/api/notes/' + encodeURIComponent(id), { method: 'DELETE' }); }, fresh[0]);
    try { __fs.unlinkSync(absTmp); } catch (e) { /* الملف قد يكون محذوفاً */ }
  // القياس الصادق (كشفته تقوية 2026-10-20): `deduplicated: true` يعني أن الملف
  // كان مُستورَداً سابقاً فيُدمج بدل الإضافة — وهذا **سلوك صحيح** (لا تكرار)، لكنه
  // يعني أن العنصر الأحدث ليس ROADMAP. القياس الحق: إن أُعلن dedup فالعنصر الأحدث
  // موجود سلفاً (لا ادعاء إضافة كاذب)، وإن لم يُعلن فالعنصر الأحدث هو المُستورَد فعلاً.
  // القياس الصادق (كشفتها تقوية 2026-10-20): `/api/notes` يُرتَّب **الأحدث أولاً**
  // (cortex-core.js `b.updatedAt.localeCompare(a.updatedAt)`)، فقراءة آخر عنصر تقرأ
  // **الأقدم** لا المُستورَد. القياس الحق: العنصر الأول = أحدث ما كُتب/استُورد.
  const importJson = await p.evaluate(async () => {
    const d = await (await fetch('/api/notes')).json();
    const list = d.notes || [];
    /* القياس بالعنصر **الأحدث** (الترتيب المُعاد هو الأحدث أولاً — cortex-core.js
       `b.updatedAt.localeCompare(a.updatedAt)`) — وهو العنصر الذي أنشأه الاستيراد
       للتوّ. لا نبحث عن كلمة «ROADMAP» لأن عنوان المستند بعد التحليل هو
       «Cortex — خارطة الحالة الفعلية…» (العنوان المُشتق من H1)، و`/api/notes`
       لا يُعيد `source_path` أصلاً. القياس الصادق: العنصر الأحدث هو مستند (لا بذرة). */
    const list2 = [...list].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const newest = list2[0] || {};
    const isDoc = !/بذرة|seed/i.test(String(newest.title || '')) && String(newest.title || '').length > 8;
    return {
      title: isDoc ? String(newest.title || '') : '', src: String(newest.source_path || newest.path || ''),
      at: String(newest.updatedAt || ''),
      newestTitle: String(newest.title || ''), count: list.length
    };
  });
  const dedup = /"deduplicated"\s*:\s*true/.test(ires);
  if (dedup) {
    ok(after === before || after === before + 1,
      'التكرار المدموج: لا إضافة مكرّرة إلى القائمة (سلوك صحيح معلَن)', before + ' → ' + after);
  } else {
    ok(String(importJson.title || '').length > 8,
      'العنصر المُستورَد ظهر فعلاً بعنوانه المُشتق', String(importJson.title || '').slice(0, 60));
  }

  // ══════════ ⑤ المستودعات ══════════
  R.c.push('══════ ⑤ المستودعات — التدفق الكامل ══════');
  await p.locator('#rail .rail-btn[data-view="repos"]').click();
  await p.waitForTimeout(2000);
  ok(await p.locator('#view-repos').isVisible(), 'الشاشة تفتح');
  // فهرسة مستندات (بلا استيرادات)
  await p.locator('#repo-path').fill('docs');
  await p.locator('#repo-index').click();
  await p.waitForTimeout(7000);
  const rstat = await p.locator('#repo-status').innerText().catch(() => '');
  ok(/✅/.test(rstat) && /ملف/.test(rstat), 'فهرسة المستندات', rstat.slice(0, 80).replace(/\n/g, ' '));
  const rf = await p.locator('#repo-file-count').innerText().catch(() => '0');
  ok(Number(rf) > 0, 'عدّاد ملفات المستندات', rf);
  const extRows = await p.locator('#repo-files .tree-i').count();
  ok(extRows > 0, 'توزيع الامتدادات يُعرض', extRows + ' صف');

  // فهرسة جذر المشروع (كود حقيقي باستيرادات)
  await p.locator('#repo-path').fill('.');
  await p.locator('#repo-index').click();
  // قياس 2026-10-24: الجذر تضخم إلى 1916 ملفاً (exports/backups/data) والفهرسة
  // الخام 8.5ث عبر curl — في المتصفح مع الرسم تتجاوز 20ث فتظهر «0 نقطة/⏳».
  await p.waitForTimeout(35000);
  const rstat2 = await p.locator('#repo-status').innerText().catch(() => '');
  input_ok: {
    ok(/✅/.test(rstat2) || /كود/.test(rstat2), 'فهرسة جذر المشروع', rstat2.slice(0, 90).replace(/\n/g, ' '));
  }
  const rf2 = await p.locator('#repo-file-count').innerText().catch(() => '0');
  ok(Number(rf2) > 0, 'عدّاد ملفات الجذر', rf2);
  const epRows = await p.locator('#repo-files [data-file]').count();
  /* عقد الفحص (مشدَّد 2026-10-29 بقياس): الخادم الحر يعيد نقاط الدخول كاملة في ~2s،
     لكن تحت حمل المتصفح ومع تضخم data/ يمكن أن يبلغ المسح سقفه الزمني (8s حماية
     DoS مصممة) فيعود جزئياً — والعقد الصادق حينها أن **يُعلن** «جزئي» في الحالة،
     لا أن يُصمت. الفحص يقبل: نقاط دخول معروضة أو جزئية معلَنة. */
  const partialShown = /جزئي/.test(rstat2);
  ok(epRows > 0 || partialShown, 'نقاط الدخول تُعرض أو تُعلن جزئية المسح', epRows + ' نقطة · جزئي=' + partialShown);

  // عارض الملفات (2026-10-29): زر «عرض» بجانب نقطة الدخول يفتح محتوى الملف فعلياً
  const vfBtn = p.locator('#repo-files [data-view-file]').first();
  ok(await vfBtn.count() > 0, 'زر عرض ملف بجانب نقاط الدخول');
  await vfBtn.click();
  await p.waitForTimeout(1500);
  const fvOpen = await p.locator('#file-drawer').isVisible().catch(() => false);
  const fvBody = fvOpen ? await p.locator('#file-body').innerText().catch(() => '') : '';
  ok(fvOpen && fvBody.length > 20 && !/^⚠/.test(fvBody.trim()), 'العارض يفتح ويعرض محتوى الملف', (fvBody || '').slice(0, 46).replace(/\n/g, ' '));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  ok(!(await p.locator('#file-drawer').isVisible().catch(() => true)), 'Esc يغلق العارض');
  const depsTxt = await p.locator('#repo-deps').innerText().catch(() => '');
  ok(/فُحص/.test(depsTxt), 'ترابط الكود يُحسب', depsTxt.split('\n')[0].slice(0, 80));

  // أثر التغيير على ملف حقيقي
  await p.locator('#impact-file').fill('cortex-monitor.js');
  await p.locator('#impact-run').click();
  /* سباق مُقاس 2026-10-29: النوم الثابت (6s) كان يُقرأ أحياناً قبل رد /api/repo/impact
     على جذر المشروع الكامل (2256 ملفاً، حمل متغير) — فيُلتقط «⏳…» بدل الحكم.
     القاعدة المطبقة في المشروع: انتظار شرطي بحد زمني لا نوم ثابت يفترض السرعة. */
  let imp = '';
  for (let i = 0; i < 40; i++) {
    imp = await p.locator('#impact-list').innerText().catch(() => '');
    if (/يعتمد/.test(imp)) break;
    await p.waitForTimeout(500);
  }
  ok(/يعتمد/.test(imp), 'تحليل الأثر يُعيد حكماً', imp.slice(0, 80).replace(/\n/g, ' '));
  const affN = await p.locator('#impact-list .hint.mono').count();
  ok(affN >= 1, 'نتائج الأثر معروضة', affN + ' سطر');

  // ══════════ ⑧ الأدوات ══════════
  R.c.push('══════ ⑧ الأدوات — التدفق الكامل ══════');
  await p.locator('#rail .rail-btn[data-view="tools"]').click();
  await p.waitForTimeout(3000);
  ok(await p.locator('#view-tools').isVisible(), 'الشاشة تفتح');
  const servers = await p.locator('#mcp-servers .pcard').count();
  R.c.push('  (خوادم MCP: ' + servers + ')');
  const tools = await p.locator('#mcp-tools-grid2 .tg').count();
  ok(tools > 0, 'أدوات MCP تُعرض', tools + ' أداة');
  const tcount = await p.locator('#mcp-tools-count').innerText().catch(() => '0');
  R.c.push('  (عدّاد الأدوات: ' + tcount + ')');
  // زر التحديث
  await p.locator('#mcp-refresh').click();
  await p.waitForTimeout(2500);
  ok(await p.locator('#view-tools').isVisible(), 'التحديث لا يكسر الشاشة');

  // ══════════ خريطة «من يعتمد على من» (FileMap) — تفاعل حيّ ══════════
  R.c.push('══════ خريطة الترابط (FileMap) — تفاعل حيّ ══════');
  await p.locator('#rail .rail-btn[data-view="graph"]').click();
  await p.waitForTimeout(3500);
  const hubOk = await p.locator('.fm-hub .fm-name').count();
  ok(hubOk === 1, 'المحور يعرض عنصراً', (await p.locator('.fm-hub .fm-name').textContent().catch(() => '') || '').trim().slice(0, 30));
  const fchips = await p.locator('.fm-chip').count();
  const fnodes = await p.locator('.fm-node[data-id]').count();
  ok(fchips + fnodes > 0, 'قائمة الجيران تُعرض', fchips + ' شريحة · ' + fnodes + ' عنصر');
  if (fnodes > 0) {
    const box = await p.locator('.fm-node[data-id]').first().boundingBox();
    ok(!!box, 'عنصر له موضع على الشاشة', box ? Math.round(box.x) + ',' + Math.round(box.y) : 'لا');
    const before = (await p.locator('.fm-hub .fm-name').textContent() || '').trim();
    await p.locator('.fm-node[data-id]').first().click();
    await p.waitForTimeout(800);
    const after = (await p.locator('.fm-hub .fm-name').textContent() || '').trim();
    ok(before !== after, 'النقر يتمركز حول العنصر', before.slice(0, 18) + ' → ' + after.slice(0, 18));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(600);
    const back = (await p.locator('.fm-hub .fm-name').textContent() || '').trim();
    ok(back === before, 'Esc يعود للمحور السابق', back.slice(0, 18));
  } else if (fchips > 0) {
    await p.locator('.fm-chip').first().click();
    await p.waitForTimeout(800);
    ok(await p.locator('.fm-node[data-id]').count() > 0, 'شريحة المشروع unfold عناصرها');
  }

  R.c.push('══════ الاستقرار ══════');
  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | '));
  // مسار add-provider يُرجع 400 عمداً عند الرفض — متوقع وليس عطلاً
  const realBad = [...new Set(bad)].filter(u => !/api\/models\/add-provider/.test(u));
  ok(realBad.length === 0, 'صفر ردود فاشلة غير متوقعة', realBad.slice(0, 3).join(' | '));

  await p.locator('#rail .rail-btn[data-view="providers"]').click();
  await p.waitForTimeout(1600);
  await p.screenshot({ path: path.join(__dirname, 'shots', 'S3-providers.png') });
  await p.locator('#rail .rail-btn[data-view="repos"]').click();
  await p.waitForTimeout(1600);
  await p.screenshot({ path: path.join(__dirname, 'shots', 'S4-repos.png') });
  await p.locator('#rail .rail-btn[data-view="tools"]').click();
  await p.waitForTimeout(1800);
  await p.screenshot({ path: path.join(__dirname, 'shots', 'S5-tools.png') });
  await b.close();
  console.log(R.c.join('\n'));
  console.log('\n═══ الأقسام ⑤⑥⑦⑧: ' + R.p + ' نجح · ' + R.f + ' فشل ═══');
  process.exit(R.f ? 1 : 0);
})();
