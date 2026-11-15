/**
 * اختبار انحدار أمني دائم — §34 (بوابة الهوية) و§35 (البوابات الحتمية بالكود).
 *
 * لماذا هذا الملف: أُثبت حيّاً 2026-10-20 أن 4 مسارات كتابة و3 تصعيدات كانت تعمل
 * بلا رمز جلسة. الحماية كانت تُطبَّق باستدعاء يدوي، فأي مسار جديد ينساه يعود ثغرة.
 * هذا الملف يقيس **المبدأ** لا القائمة: أي طريقة كتابة (POST/PUT/PATCH/DELETE)
 * على أي مسار /api/* خارج قائمة قراءة صريحة = 401 بلا رمز.
 *
 * لو أضاف أحدهم مسار كتابة بلا حارس، أو تراجع الحارس المركزي ⇒ هذا الملف يُفشل الدفعة.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startLiveServer } from './_live-server.mjs';

let srv;
before(async () => { srv = await startLiveServer(); });
after(async () => { await srv.stop(); });

/* مسارات قراءة مشروعة (§34: `/api/settings` و`/api/session` قراءتهما حرة
   لأن الواجهة تحتاجهما قبل امتلاك الرمز). */
const READ_ONLY = new Set(['/api/session', '/api/settings', '/api/health', '/api/version']);

test('§34 — الكتابة المركّبة على مسارات حقيقية بلا رمز تُرفض 401', async () => {
  const targets = [
    ['POST', '/api/backup', '{}'],
    ['POST', '/api/agent/session/start', '{}'],
    ['POST', '/api/notes', JSON.stringify({ text: 'محاولة غير مصادَقة' })],
    ['DELETE', '/api/notes/victimUnauth', ''],
    ['POST', '/api/scan', '{}'],
    ['POST', '/api/ai/chat', JSON.stringify({ messages: [{ role: 'user', content: 'x' }] })],
    ['POST', '/api/import', '{}'],
    ['POST', '/api/agent/execute', JSON.stringify({ tool: 'fs_write', args: {} })],
    ['PATCH', '/api/settings', JSON.stringify({ autonomy: 'full' })],
  ];
  for (const [method, path, body] of targets) {
    const r = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${srv.port}` },
      body: method === 'DELETE' ? undefined : body,
    });
    assert.strictEqual(r.status, 401, `${method} ${path} بلا رمز يجب أن يُرفض 401 (أُعيد ${r.status})`);
  }
});

test('§34 — الحارس المركزي مُركَّب في مقدمة handleApi (الضمان البنيوي)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  /* الضمان الحقيقي ليس ذِكر الحارس بجانب كل مسار (هشّ وينسى)، بل أن الحارس
     المركزي يُنفَّذ في مقدمة الموجّه قبل أي معالجة. نتحقق من موضعه لا من عدده. */
  /* نبحث عن أول مسار **حقيقي** في الموجّه: `req.method === 'X' && url.pathname === '/api/...'`
     أو سطر يبدأ بـ`if (... url.pathname ===`. البحث عن `url.pathname` وحده يطابق
     دالة CSRF أيضاً (خطأ قياس أصلحته 2026-10-20). */
  const guard = src.indexOf('requiresSession(req.method, url.pathname)');
  assert.ok(guard > 0, 'الحارس المركزي requiresSession غير مُستدعى');
  const routeRe = /(?:req\.method\s*===\s*['"][A-Z]+['"]\s*&&\s*)?url\.pathname\s*===\s*['"]\/api\//g;
  let firstRoute = -1;
  let rm;
  while ((rm = routeRe.exec(src))) {
    /* نتجاهل ما يقع داخل تعريف دالة الحارس/القراءة نفسها (قبل handleApi) */
    if (rm.index > src.indexOf('async function handleApi')) { firstRoute = rm.index; break; }
  }
  assert.ok(firstRoute > 0, 'لا مسارات حقيقية في الموجّه');
  assert.ok(guard < firstRoute, `الحارس المركزي (${guard}) يجب أن يسبق أول مسار (${firstRoute})`);

  /* الأسئلة المُعلَنة: القائمة موجودة ومفروزة، والكتابة غير مذكورة فيها إطلاقاً */
  assert.match(src, /READ_ONLY_ROUTES/, 'قائمة القراءة الحرة غير مُعلَنة');
  const block = src.slice(src.indexOf('READ_ONLY_ROUTES'), src.indexOf('READ_ONLY_ROUTES') + 900);
  assert.ok(!/POST|PUT|PATCH|DELETE/.test(block),
    'قائمة القراءة الحرة يجب ألا تضم أي ميثود كتابة — أي كتابة فيها = ثغرة مُعلَنة');
});

test('§34 — كل مسار كتابة حقيقي يرفض بلا رمز (قياس سلوك لا نص)', async () => {
  /* نستخرج المسارات من الكود ثم نقيسها حيّاً — لا قائمة مكتوبة بيدي (تكبر وتتقادم) */
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const re = /url\.pathname\s*===\s*['"](\/api\/[^'"]+)['"]/g;
  const paths = new Set();
  let m;
  while ((m = re.exec(src))) paths.add(m[1]);
  /* نستبعد القراءة والمسارات ذات المعاملات (تحتاج معرّفاً حقيقياً) */
  const targets = [...paths].filter(p => !p.includes(':') && !READ_ONLY.has(p) && p !== '/api/session');
  assert.ok(targets.length >= 8, `عدد المسارات المكتشفة قليل جداً (${targets.length}) — النمط لا يعمل`);
  const failed = [];
  for (const p of targets) {
    const r = await fetch(`http://127.0.0.1:${srv.port}${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${srv.port}` },
      body: '{}',
    });
    if (r.status !== 401) failed.push(`${p}=${r.status}`);
  }
  assert.deepEqual(failed, [], `مسارات كتابة لم ترفض بلا رمز: ${failed.join(', ')}`);
});

test('§35 — تصعيد autonomy من الحمولة لا يُقبل بأي قيمة', async () => {
  const h = srv.headers();
  for (const val of ['full', 'FULL', 'admin', 'root', 'autonomous', '__proto__', '']) {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/agent/next-action`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ goal: 'اختبار تصعيد', autonomy: val }),
    });
    assert.ok(r.status === 200 || r.status === 400,
      `autonomy=${JSON.stringify(val)} أعاد ${r.status} — لا يجب أن يُنفَّذ بأي حال`);
    if (r.status === 200) {
      const j = await r.json();
      /* الاقتراح قد يُعاد، لكن لا يجوز أن يُعلن تنفيذاً مستقلاً */
      assert.ok(!/autonomy["\s:]*full/i.test(JSON.stringify(j)),
        `autonomy=${JSON.stringify(val)} تسرّب إلى الاستجابة`);
    }
  }
});
