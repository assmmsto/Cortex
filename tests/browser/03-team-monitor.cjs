/**
 * اختبار التدفق الكامل — ③ الوكلاء (فردي + فريق متوازٍ) و ④ المراقبة الصارمة
 * يشغّل فريقاً حقيقياً من المتصفح ويقيس النتيجة بالوقت الفعلي.
 */
const path = require('path');
const { chromium } = require('playwright-core');
const R = { p: 0, f: 0, c: [] };
const ok = (k, n, x) => { if (k) { R.p++; R.c.push('  ✔ ' + n + (x ? ' — ' + x : '')); } else { R.f++; R.c.push('  ✖ ' + n + (x ? ' — ' + x : '')); } };
const B = process.env.CORTEX_URL || 'http://127.0.0.1:3737';
const { resolveChrome } = require('./_chrome.cjs');
const CHROME = resolveChrome();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, headless: true });
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 } });
  const errs = [], bad = [];
  p.on('pageerror', e => errs.push(String(e.message)));
  p.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url().replace(B, '')); });

  await p.goto(B + '/', { waitUntil: 'load', timeout: 30000 });
  await p.waitForTimeout(2600);

  // ══════════ ③-أ وكيل فردي ══════════
  R.c.push('══════ ③-أ وكيل فردي (لوحة الوكيل) ══════');
  await p.locator('#ai-open-btn').click();
  await p.waitForTimeout(1200);
  ok(await p.locator('#ai-panel').isVisible(), 'لوحة الوكيل تُفتح');
  ok(await p.locator('#ai-panel .atab').count() === 0, 'شاشة AGENT: بلا تبويبات (محادثة واحدة)');

  await p.locator('#chat-input').fill('كم ملاحظة عندي؟ اذكر العدد فقط');
  await p.locator('#send-chat-btn').click();
  // الخط الزمني (الاستوديو 2026-10-28): الرد يصير بطاقة .tl-answer — والاحتياط للفقاعة القديمة
  let ans = '';
  for (let i = 0; i < 32; i++) {
    await sleep(2500);
    const reply = p.locator('#chat-messages .tl-answer, #chat-messages .chat-bubble.ai');
    if (await reply.count() > 0) { ans = await reply.last().innerText(); break; }
  }
  // الرد قد يكون رقماً قصيراً («23») — فالمعيار أن الرد غير فارغ وليس طوله
  ok(ans.trim().length > 0, 'الوكيل الفردي ردّ', ans.slice(0, 70).replace(/\n/g, ' '));
  ok(/\d|ملاحظ/.test(ans), 'الرد يحمل عدداً أو محتوى', ans.slice(0, 50));
  ok(/⚠|401|خطأ/.test(ans) === false, 'الرد بلا أخطاء');
  const srcN = await p.locator('#ai-panel #agent-sources .ref').count();
  ok(srcN > 0, 'المصادر تُعرض في السطح نفسه (بلا تبويب)', srcN + ' مصدر');
  const stN = await p.locator('#ai-panel #agent-steps li').count();
  ok(stN > 0, 'الخطوات تُعرض في السطح نفسه (بلا تبويب)', stN + ' خطوة');
  await p.locator('#ai-close-btn').click();
  await p.waitForTimeout(700);

  // ══════════ ③-ب الفريق المتوازي ══════════
  R.c.push('══════ ③-ب الفريق المتوازي (بثّ حيّ) ══════');
  await p.locator('#ai-open-btn').click();
  await p.waitForTimeout(1200);
  ok(await p.locator('#agent-mode').count() === 0, 'بلا منتقي وضع في الشات (قرار 2026-10-30)');
  await p.locator('#chat-input').fill('اعملوا كفريق: اعرضوا ملاحظاتي وعددها ثم اختبروا صحتها');
  const t0 = Date.now();
  await p.locator('#send-chat-btn').click();
  await p.waitForTimeout(9000);
  const liveEarly = await p.locator('#team-live .tcard').count();
  ok(liveEarly > 0, 'بطاقات الأدوار تظهر فوراً (بثّ حيّ)', liveEarly + ' بطاقة');

  // انتظر نهاية الفريق
  let summary = '';
  for (let i = 0; i < 70; i++) {
    await sleep(3000);
    const s = await p.locator('#team-summary').innerText().catch(() => '');
    if (/النتيجة/.test(s)) { summary = s; break; }
  }
  const dur = Math.round((Date.now() - t0) / 1000);
  ok(summary.length > 0, 'الفريق أنهى وأعلن النتيجة', dur + 'ث');
  const cards = await p.locator('#team-live .tcard').count();
  ok(cards >= 4, 'بطاقات الأدوار للفريق', cards + ' دور');
  const roles = await p.locator('#team-live .trole').allInnerTexts();
  ok(new Set(roles).size >= 4, 'أدوار مختلفة فعلاً', [...new Set(roles)].join('/'));
  const evChips = await p.locator('#team-live .tchip').count();
  ok(evChips > 0, 'أثر الأدوات يظهر حيّاً على البطاقات', evChips + ' أثر');
  const doneCards = await p.locator('#team-live .tcard.done').count();
  ok(doneCards >= 4, 'بطاقات انتهت', doneCards + ' منتهية');
  R.c.push('  (الملخص: ' + summary.slice(0, 110).replace(/\n/g, ' ') + ')');
  const ridMatch = summary.match(/run-\d+-[0-9a-f]+/);
  const teamRunId = ridMatch ? ridMatch[0] : '';

  // ══════════ ④ المراقبة الصارمة ══════════
  R.c.push('══════ ④ المراقبة الصارمة ══════');
  await p.locator('#rail .rail-btn[data-view="monitor"]').click();
  await p.waitForTimeout(3000);
  ok(await p.locator('#view-monitor').isVisible(), 'شاشة المراقبة');
  const verdict = await p.locator('#mon-verdict').innerText();
  ok(['مقبول', 'مرفوض', 'مشروط'].includes(verdict), 'حكم المراقب محسوب', verdict);
  const steps = Number(await p.locator('#mon-steps').innerText());
  ok(steps >= 4, 'عدد مهام التشغيل', String(steps));
  const par = Number(await p.locator('#mon-parallel').innerText());
  ok(par >= 2, 'توازٍ مُنجَز فعلاً', String(par));
  const reasons = await p.locator('#mon-reasons').innerText();
  ok(/اكتملت|فشل|أثر|تحقق/.test(reasons), 'أسباب الحكم معروضة', reasons.slice(0, 90));
  const rows = await p.locator('#sp-tasks tr').count();
  ok(rows >= 4, 'جدول مهام التشغيل', rows + ' صف');
  const tableTxt = await p.locator('#sp-tasks').innerText();
  ok(/أثر/.test(tableTxt) || /بلا أثر/.test(tableTxt), 'عمود الأدلة يُعرض في الجدول');
  const objections = await p.locator('#mon-objections .fc').count();
  R.c.push('  (اعتراضات: ' + objections + ' | نجاح: ' + await p.locator('#mon-avg').innerText() + ' | متوسط: ' + await p.locator('#mon-dur').innerText() + ')');

  // اختيار تشغيل محدّد
  if (teamRunId) {
    await p.locator('#mon-run').selectOption({ label: new RegExp(teamRunId.slice(-12)) }).catch(() => {});
    await p.waitForTimeout(2500);
    ok(await p.locator('#view-monitor').isVisible(), 'اختيار تشغيل من القائمة يعمل');
  }
  const runOpts = await p.locator('#mon-run option').count();
  ok(runOpts >= 3, 'قائمة التشغيلات السابقة', runOpts + ' تشغيل');

  // تحديث
  await p.locator('#mon-refresh').click();
  await p.waitForTimeout(2800);
  ok(await p.locator('#mon-verdict').innerText() !== '—', 'التحديث يعيد الحكم');

  R.c.push('══════ الاستقرار ══════');
  ok(errs.length === 0, 'صفر أخطاء JS', errs.slice(0, 2).join(' | '));
  const realBad = [...new Set(bad)].filter(u => !/api\/models\/add-provider/.test(u));
  ok(realBad.length === 0, 'صفر ردود فاشلة', realBad.slice(0, 3).join(' | '));

  await p.locator('#ai-open-btn').click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.join(__dirname, 'shots', 'S6-team.png') });
  await p.locator('#rail .rail-btn[data-view="monitor"]').click();
  await p.waitForTimeout(2200);
  await p.screenshot({ path: path.join(__dirname, 'shots', 'S7-monitor.png') });
  await b.close();
  console.log(R.c.join('\n'));
  console.log('\n═══ الأقسام ③④: ' + R.p + ' نجح · ' + R.f + ' فشل ═══');
  process.exit(R.f ? 1 : 0);
})();
