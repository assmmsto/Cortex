/**
 * اختبار التدفق الكامل — القسم ① المعرفة + ② الخريطة
 * يمرّ على كل وظيفة فعلية ويتحقق من أثرها (في الواجهة وفي الـ API).
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
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errs = [], bad = [];
  p.on('pageerror', e => errs.push(String(e.message)));
  p.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().replace(B, '')); });

  await p.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2600);
  // انتظر امتلاء المكتبة فعلاً — توقيت ثابت كان يقيس صفراً على خادم بارد
  await p.waitForFunction(() => document.querySelectorAll('#library-list .tree-i').length > 0, null, { timeout: 25000 }).catch(() => {});
  await p.waitForTimeout(600);

  // ══════════ ① المعرفة ══════════
  R.c.push('══════ ① المعرفة — التدفق الكامل ══════');
  const n0 = await p.locator('#library-list .tree-i').count();
  ok(n0 >= 18, 'المكتبة تُعرض', n0 + ' عنصر');

  // فلترة بالبحث
  await p.locator('#notes-search').fill('Atlas');
  await p.waitForTimeout(1400);
  const nf = await p.locator('#library-list .tree-i').count();
  ok(nf > 0 && nf < n0, 'البحث يفلتر القائمة', nf + '/' + n0);
  await p.locator('#notes-search').fill('');
  await p.waitForTimeout(1400);
  const nBack = await p.locator('#library-list .tree-i').count();
  ok(nBack === n0, 'مسح البحث يستعيد الكل', String(nBack));

  // فلترة بالنوع
  await p.locator('#notes-type').selectOption('project');
  await p.waitForTimeout(1300);
  const np = await p.locator('#library-list .tree-i').count();
  R.c.push('  (المشاريع: ' + np + ')');
  await p.locator('#notes-type').selectOption('');
  await p.waitForTimeout(1200);

  // فتح عنصر
  const firstId = await p.evaluate(() => { const el = document.querySelector('#library-list .tree-i'); return el ? (el.dataset.id || el.getAttribute('data-id')) : ''; });
  await p.locator('#library-list .tree-i').first().click();
  await p.waitForTimeout(2400);
  ok(await p.locator('#doc').isVisible(), 'المحرر يُفتح بالنقر');
  const title = await p.locator('#note-title').inputValue();
  ok(title.length > 0, 'العنوان يُملأ', title.slice(0, 30));
  const body = await p.locator('#note-content').inputValue();
  ok(body.length > 0, 'المحتوى يُملأ', body.length + ' حرف');
  const hDoc = await p.evaluate(() => Math.round(document.getElementById('doc').getBoundingClientRect().height));
  ok(hDoc > 300, 'ارتفاع المحرر كافٍ', hDoc + 'px');

  // تعديل + حفظ + التحقق من قاعدة البيانات
  const stamp = 'اختبار-تدفق-' + Date.now();
  await p.locator('#note-content').fill('# ' + stamp + '\n\nمحتوى اختباري من المتصفح.');
  await p.locator('#save-note-btn').click();
  await p.waitForTimeout(2800);
  const saved = await p.evaluate(async (id) => {
    const r = await fetch('/api/notes/' + encodeURIComponent(id));
    const d = await r.json();
    return (d.note && (d.note.content || d.note.body)) || '';
  }, firstId);
  ok(saved.includes(stamp), 'الحفظ وصل لقاعدة البيانات', saved.slice(0, 40));

  // زر واحد يفتح لوحات السياق الست (توحيد 2026-10-30: كان خمسة أزرار)
  // زر واحد يفتح/يغلق لوحات السياق الست (توحيد 2026-10-30: كان خمسة أزرار)
  const ctxBtn = p.locator('#ctx-details-toggle');
  ok(await ctxBtn.count() === 1, 'زر «تفاصيل العنصر» موجود');
  // الفحص داخل صفحة واحدة بلا انتظار: النقر يقلب الحالة (لوحظ أن تحميل السياق يفتحها تلقائياً)
  const flip = await p.evaluate(() => {
    const btn = document.getElementById('ctx-details-toggle');
    const box = document.getElementById('ctx-panels');
    const before = box.classList.contains('hidden');
    btn.click();
    const after = box.classList.contains('hidden');
    btn.click();
    return { before, after };
  });
  ok(flip.before !== flip.after, 'النقر يقلب حالة لوحة السياق', 'قبل=' + flip.before + ' بعد=' + flip.after);
  ok(await p.locator('#ctx-panels .ctx-col').count() === 6, 'اللوحات الست موجودة');
  ok(await p.locator('#ctx-panels .ctx-col').count() === 6, 'اللوحات الست موجودة');

  // إنشاء عنصر جديد
  const newTitle = 'عنصر-اختبار-' + Date.now();
  await p.locator('#new-note-btn').click();
  await p.waitForTimeout(1000);
  ok(await p.locator('#modal-new').isVisible(), 'نافذة العنصر الجديد');
  await p.locator('#new-title-input').fill(newTitle);
  // التصنيف اليدوي داخل <details> مطويّ: يُفتح أولاً وإلا فالحقل غير مرئي (عطل اختبار لا منتج)
  await p.locator('#modal-new details.adv-opt summary').first().click();
  await p.waitForTimeout(250);
  await p.locator('#new-type-select').selectOption('note');
  await p.locator('#create-note-btn').click();
  await p.waitForTimeout(2800);
  const created = await p.evaluate(async (t) => {
    const r = await fetch('/api/notes');
    const d = await r.json();
    return ((d.notes || d || []).filter ? (d.notes || d || []) : []).some(x => String(x.title || '').includes(t));
  }, newTitle);
  ok(created, 'العنصر الجديد أُنشئ فعلاً', newTitle.slice(0, 26));

  // ══════════ ② الخريطة (نظام FileMap: مركز + عمودان + شريط أرقام) ══════════
  R.c.push('══════ ② الخريطة — التدفق الكامل (FileMap) ══════');
  await p.locator('#rail .rail-btn[data-view="graph"]').click();
  await p.waitForTimeout(3200);
  // المحور: بطاقة العنصر الأكثر ارتباطاً باسمه ومشروعه ومؤشراته
  const hubName = await p.locator('.fm-hub .fm-name').textContent().catch(() => '');
  ok(!!hubName && hubName.trim().length > 0, 'المحور يعرض عنصراً باسمه', hubName || '—');
  const hubMeta = await p.locator('.fm-hub .fm-meta').textContent().catch(() => '');
  ok(/يعتمد عليه \d+ · يعتمد على \d+/.test(hubMeta || ''), 'مؤشرات المحور (يعتمد عليه/عليه)', (hubMeta || '').slice(0, 50));
  // العمودان بعنوانيهما وعدّاديهما
  const colTitles = await p.locator('.fm-col-title').count();
  ok(colTitles === 2, 'العمودان بعنوانيهما', colTitles + ' عنوان');
  const chips = await p.locator('.fm-chip').count();
  const nodes = await p.locator('.fm-node[data-id]').count();
  ok(chips + nodes > 0, 'قائمة الجيران تُعرض (بطاقات أو أسماء)', chips + ' شريحة · ' + nodes + ' عنصر');
  // شريط الأرقام السفلي بقيمه الخمس
  const stats = await p.evaluate(() => ({
    files: document.getElementById('fm-st-files')?.textContent,
    folders: document.getElementById('fm-st-folders')?.textContent,
    cycles: document.getElementById('fm-st-cycles')?.textContent,
    orphans: document.getElementById('fm-st-orphans')?.textContent,
    edges: document.getElementById('fm-st-edges')?.textContent,
  }));
  ok(Number(stats.files) >= 18, 'عداد العناصر', stats.files);
  ok(Number(stats.edges) >= 1, 'عداد الارتباطات', stats.edges);
  ok(Number(stats.orphans) >= 0 && Number(stats.folders) >= 1, 'عدادات المشاريع واليتيمة', 'مشاريع=' + stats.folders + ' يتيمة=' + stats.orphans);

  // التفاعل: شريحة مشروع → ملفاته → تمركز حول عنصر → رجوع بـEsc
  const chip1 = p.locator('.fm-chip').first();
  if (await chip1.count()) {
    const before = hubName;
    await chip1.click();
    await p.waitForTimeout(800);
    const unfolded = await p.locator('.fm-node[data-id]').count();
    ok(unfolded > 0, 'نقرة شريحة المشروع unfold ملفاته', unfolded + ' عنصر');
    await p.locator('.fm-node[data-id]').first().click();
    await p.waitForTimeout(800);
    const hub2 = await p.locator('.fm-hub .fm-name').textContent();
    ok(hub2.trim() !== before.trim(), 'النقر يتمركز حول العنصر', '→ ' + hub2.trim().slice(0, 24));
    const back = await p.locator('.fm-hub .fm-back').count();
    ok(back === 1, 'زر رجوع يظهر بعد التمركز');
    await p.keyboard.press('Escape');
    await p.waitForTimeout(700);
    const hub3 = await p.locator('.fm-hub .fm-name').textContent();
    ok(hub3.trim() === before.trim(), 'Esc يعود للمحور السابق', hub3.trim().slice(0, 24));
  }
  // الأسلاك: تُرسم تحت حد الزحام (60) وتُخفى فوقه — وصفر ظاهر ⇒ صفر سلك
  const wires = await p.locator('.fm-wire').count();
  const visible = await p.locator('.fm-node[data-id]').count();
  ok((visible === 0 && wires === 0) || (visible <= 60 && wires > 0) || (visible > 60 && wires === 0), 'قاعدة الأسلاك عند الزحام', wires + ' سلك لـ' + visible + ' ظاهراً');

  R.c.push('══════ الاستقرار ══════');
  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | '));
  ok(bad.length === 0, 'صفر ردود فاشلة', [...new Set(bad)].slice(0, 3).join(' | '));

  // تنظيف ذاتي: العنصر الذي أنشأه هذا الاختبار يُحذف — لا تراكم في خزنة المنتج
  try {
    const TOKEN = await p.evaluate(() => fetch('/api/session').then(r => r.json()).catch(() => null));
    const tok = TOKEN && TOKEN.token;
    if (tok) {
      const del = await p.evaluate(async ({ t, token }) => {
        const r0 = await fetch('/api/notes');
        const d0 = await r0.json();
        const list = d0.notes || d0 || [];
        const hit = (list.filter || (() => [])).call(list, x => String(x.title || '').includes(t)).map(x => x.id);
        let n = 0;
        for (const id of hit) {
          const r = await fetch('/api/notes/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'X-Cortex-Session': token } });
          if (r.ok) n++;
        }
        return n;
      }, { t: newTitle, token: tok });
      R.c.push('  (تنظيف ذاتي: حُذف ' + del + ' عنصر اختبار)');
    }
  } catch (e) { R.c.push('  (تنظيف ذاتي: تعذّر — ' + String(e.message).slice(0, 60) + ')'); }

  await p.screenshot({ path: path.join(__dirname, 'shots', 'S1-notes.png') });
  await p.locator('#rail .rail-btn[data-view="graph"]').click();
  await p.waitForTimeout(3200);
  await p.screenshot({ path: path.join(__dirname, 'shots', 'S2-graph.png') });
  await b.close();
  console.log(R.c.join('\n'));
  console.log('\n═══ القسم ①②: ' + R.p + ' نجح · ' + R.f + ' فشل ═══');
  process.exit(R.f ? 1 : 0);
})();
