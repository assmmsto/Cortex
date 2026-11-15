/**
 * tests/security-deep.test.mjs — مراجعة أمنية هجومية (characterization tests).
 *
 * المنهج: كل اختبار يرسل **طلباً حقيقياً** إلى خادم حقيقي معزول (tests/_live-server.mjs)
 * ويقارن **الرد الحقيقي** بالسلوك المتوقع أمنياً. عند وجود ثغرة يُثبِّت الاختبار
 * السلوك الحالي (وثيقة تنفيذية)، ويطبع سطر دليل:  ملف:سطر ← الطلب ← الرد.
 * لذلك: الاختبار الذي يوثّق ثغرة **يفشل بعد إصلاحها** — وهذا مقصود (بوابة كشف).
 *
 * لا يعدّل هذا الملف أي ملف منتج. ملكيته: tests/security-deep.test.mjs فقط.
 *
 * الاكتشافات المرصودة (2026-10-23، خادم معزول، Windows 10):
 *   F1  server.js:891   GET /api/session يعيد الرمز كاملاً لأي عميل محلي بلا مصادقة.
 *   F2  server.js:760   الرمز يُقبل من ?session= في العنوان (تسريب عبر السجلات/التاريخ).
 *   F3  server.js:848-869   الحارس المركزي سليم للكتابة (401)، لكن تصنيفه **بالطريقة** لا بالنية.
 *   F4  server.js:862,868   GET/HEAD/OPTIONS تُعدّ «قراءة» دائماً ⇒ كل GET ذي أثر جانبي بلا حماية.
 *   F5  server.js:1479 + 409-436  GET /api/export/project يكتب ملفات على القرص بلا جلسة.
 *   F6  cortex-import.js:702-718,775-776  تجوال المسار مرفوض في كل الأشكال (سليم) — لكنه يكشف المسار المطبع.
 *   F7  cortex-import.js:772,783  رسائل نظام خام: EPERM/EISDIR + مسار مطلق (ENOENT مُقنَّع برسالة صديقة).
 *   F8  cortex-import.js:776,783  صدى المسار المطلق المرفوض (كشف بنية القرص).
 *   F9  cortex-import.js:686     NUL مرفوض صراحةً (سليم).
 *   F10 server.js:21,791        حد 2MB يطبَّق حتى على chunked بلا Content-Length (سليم).
 *   F11 لا حصر معدل: 20 طلباً متتالياً على /api/import بلا 429 (سقف يومي فقط، لا نافذة).
 *   F12 لا حصر معدل على التصدير: 20 GET بلا رمز ⇒ 20 ملفاً على القرص (تضخيم كتابة).
 *   F13 cortex-import.js:28,645 + server.js:934  استيراد *.env داخل APP_ROOT ⇒ قراءة الأسرار كنص عبر GET بلا جلسة.
 *   F14 عام: الخادم يخزّن HTML خاماً بلا تنقية؛ التخفيف الوحيد escapeHtml في public/app.js:814 (85 موضع innerHTML).
 *   F15 لا مُصدِّر CSV (format=csv ⇒ 400) ⇒ صيغ CSV الخطرة تُحفظ حرفياً وتنتقل إلى md.
 *   F16 لا حقن رؤوس: CRLF في العنوان/المشروع لا يصل إلى الترويسات (سليم).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveServer } from './_live-server.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const EVIDENCE = [];
let srv;

function note(fileLine, reqText, resText) {
  const line = `[${fileLine}] ${reqText}  ⇒  ${resText}`;
  EVIDENCE.push(line);
  console.log('EVIDENCE ' + line);
}

const short = (s, n = 220) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

async function hit(tag, urlPath, opts = {}) {
  const t0 = Date.now();
  let status = 0, headers = new Headers(), body = '';
  try {
    const r = await fetch(srv.base + urlPath, { redirect: 'manual', ...opts });
    status = r.status; headers = r.headers; body = await r.text();
  } catch (e) {
    body = 'FETCH_ERROR ' + e.message;
  }
  return { tag, status, headers, body, ms: Date.now() - t0 };
}

/** كتابة JSON — بالرمز افتراضياً (المسار الشرعي)، وبلا رمز عند token=false. */
function postJson(urlPath, obj, { token = true, method = 'POST' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Cortex-Session'] = srv.token;
  return hit('json', urlPath, { method, headers, body: JSON.stringify(obj) });
}

const imp = (p, token = true) => postJson('/api/import', { path: p, project: 'sec-deep' }, { token });

before(async () => {
  srv = await startLiveServer();
  fs.mkdirSync(path.join(srv.root, 'planted'), { recursive: true });
}, { timeout: 90000 });

after(async () => {
  const dump = path.join(os.tmpdir(), 'cortex-security-deep-evidence.log');
  try { fs.writeFileSync(dump, EVIDENCE.join('\n') + '\n', 'utf8'); console.log('\nEVIDENCE_FILE ' + dump); } catch { /* تجاهل */ }
  if (srv) await srv.stop();
});

/* ─────────────── F1: تسليم الرمز — أُغلق 2026-11-12 ─────────────── */
/* كان هذا الاختبار يُثبت الثغرة (200 + الرمز بلا تحقق). بعد إغلاقها صار يُثبت
   الإغلاق: العميل غير المتصفح يُرفض، والمتصفح على الأصل نفسه يمرّ. الاختبار
   يحمي **الحالة الأمنية** لا لحظةً تاريخية. */
test('SEC-01 | GET /api/session لا يسلّم الرمز لعميل محلي غير متصفح', async () => {
  const r = await hit('session', '/api/session');
  const j = (() => { try { return JSON.parse(r.body); } catch { return {}; } })();
  note('server.js', 'GET /api/session (بلا Origin، بلا Sec-Fetch-Site)',
    `${r.status} · token_present=${Boolean(j.token)} · code=${j.code || '—'}`);
  assert.equal(r.status, 403, 'F1 مُغلق: لا رمز لغير المتصفح');
  assert.equal(j.token, undefined, 'لا رمز في جسم الرفض');
  assert.equal(j.code, 'not_a_browser');
});

test('SEC-01b | GET /api/session يخدم المتصفح المحلي على الأصل نفسه', async () => {
  const r = await hit('session-browser', '/api/session', { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  const j = (() => { try { return JSON.parse(r.body); } catch { return {}; } })();
  assert.equal(r.status, 200, 'المتصفح يعمل: لا كسر للواجهة');
  assert.equal(j.token, srv.token, 'نفس رمز الخادم');
  assert.match(String(r.headers.get('set-cookie') || ''), /cortex_session=/, 'كوكي HttpOnly يُضبط');
});

/* ─────────────── F2: الرمز في العنوان — أُغلق 2026-11-12 ─────────────── */
test('SEC-02 | الرمز في ?session= لم يعد يمنح كتابة', async () => {
  const ok = await hit('qs', '/api/notes?session=' + encodeURIComponent(srv.token), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'qs-note', content: 'x' }),
  });
  note('server.js', 'POST /api/notes?session=<token> (بلا X-Cortex-Session)', `${ok.status} · ${short(ok.body, 90)}`);
  assert.equal(ok.status, 401, 'F2 مُغلق: العنوان ليس حاملاً للهوية');

  const hdr = await hit('qs-hdr', '/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': srv.token },
    body: JSON.stringify({ title: 'hdr-note', content: 'x' }),
  });
  assert.equal(hdr.status, 200, 'الترويسة وحدها تمرّ — البديل الشرعي');
});

/* ─────────────── F3: الحارس المركزي ─────────────── */
test('SEC-03 | الحارس المركزي يرفض كل كتابة بلا رمز (ضابط سالب)', async () => {
  const cases = [
    ['POST', '/api/notes', { title: 'x', content: 'y' }],
    ['DELETE', '/api/notes/any-note', null],
    ['POST', '/api/settings', { lang: 'en' }],
    ['POST', '/api/backup', {}],
    ['POST', '/api/import', { path: 'C:/Windows/win.ini', project: 'p' }],
  ];
  const results = [];
  for (const [method, p, payload] of cases) {
    const r = payload
      ? await hit('guard', p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      : await hit('guard', p, { method });
    results.push(`${method} ${p} → ${r.status}/${(JSON.parse(r.body || '{}').code) || '-'}`);
    assert.equal(r.status, 401, `F3: ${method} ${p} مرّ بلا رمز`);
  }
  note('server.js:848-869', 'خمسة مسارات كتابة بلا رمز', results.join(' · '));
});

/* ─────────────── F4: تصنيف الطريقة ─────────────── */
test('SEC-04 | OPTIONS/HEAD يمرّان قبل الحارس: التصنيف بالطريقة لا بالنية', async () => {
  const opt = await hit('opt', '/api/notes', {
    method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  const head = await hit('head', '/api/notes', { method: 'HEAD' });
  note('server.js:874-890', "OPTIONS /api/notes (Origin: http://evil.example)",
    `${opt.status} · allow-methods=${opt.headers.get('access-control-allow-methods')} · vary=${opt.headers.get('vary')}`);
  note('server.js:862,868', 'HEAD /api/notes (بلا رمز)', `${head.status} (ليس 401 — الحارس لا يُستدعى) · ${short(head.body, 80)}`);
  assert.equal(opt.status, 204);
  assert.notEqual(head.status, 401, 'F4: HEAD مُعفى بنيوياً');
});

/* ─────────────── F5: GET يكتب على القرص ───────────────
   كان: تصدير بلا هوية يكتب ملفاً. صار 2026-10-26: SIDE_EFFECT_READS في
   requiresSession تعامل GET /api/export/project ككتابة. الاختبار يُثبت
   الإغلاق ويُثبت أن المسار الشرعي (بالرمز) ما زال يعمل. */
test('SEC-05 | GET /api/export/project: بلا رمز ⇒ 401 بلا ملف، وبالرمز ⇒ يعمل', async () => {
  const created = await postJson('/api/notes', { title: 'export-seed', content: '# seed\n\nbody', project: 'sec-export' });
  assert.equal(created.status, 200);

  const anon = await hit('export-anon', '/api/export/project?project=sec-export&format=md');
  const anonBody = (() => { try { return JSON.parse(anon.body); } catch { return {}; } })();
  note('server.js requiresSession/SIDE_EFFECT_READS', 'GET /api/export/project (بلا رمز)',
    `${anon.status} · code=${anonBody.code || '-'} · file=${anonBody.file || '-'}`);
  assert.equal(anon.status, 401, 'F5: تصدير بلا هوية ما زال ممكناً');
  assert.equal(anonBody.file, undefined, 'F5: الرد لا يحمل مسار ملف لم يُكتب');

  const ok = await hit('export-token', '/api/export/project?project=sec-export&format=md', {
    headers: { 'X-Cortex-Session': srv.token },
  });
  const j = (() => { try { return JSON.parse(ok.body); } catch { return {}; } })();
  const exists = Boolean(j.file) && fs.existsSync(j.file);
  note('server.js:1708 (تصدير بالرمز)', 'GET /api/export/project + X-Cortex-Session',
    `${ok.status} · on_disk=${exists} · size=${j.size}`);
  assert.equal(ok.status, 200, 'المسار الشرعي يجب أن يبقى يعمل');
  assert.ok(exists, 'التصدير بالرمز يجب أن يكتب الملف فعلاً');
});

/* ─────────────── F6: تجوال المسار ─────────────── */
test('SEC-06 | تجوال المسار: ..، خلفية، UNC، جهاز، 8.3، طويل، NUL — كلها مرفوضة', async () => {
  const payloads = [
    ['نسبي ../', '..%2F..%2Fserver.js'],
    ['شرطة خلفية', '..\\..\\server.js'],
    ['UNC', '\\\\localhost\\C$\\Windows\\win.ini'],
    ['مسار جهاز', '\\\\.\\C:'],
    ['اختصار 8.3', 'C:\\PROGRA~1\\..\\Windows\\win.ini'],
    ['طويل جداً (300+)', 'C:/' + 'A'.repeat(320) + '.md'],
    ['محرف NUL', 'C:/Windows/win.ini\u0000.md'],
    ['مطلق خارج الجذور', 'C:/Windows/win.ini'],
  ];
  const rows = [];
  for (const [label, p] of payloads) {
    const r = await imp(p);
    rows.push(`${label} → ${r.status} (${short(r.body, 70)})`);
    assert.equal(r.status, 400, `F6: ${label} لم يُرفض`);
    assert.doesNotMatch(r.body, /"ok":true/, `F6: ${label} نُفّذ`);
  }
  note('cortex-import.js:686-718', 'ثمانية أشكال تجوال إلى POST /api/import', rows.join(' | '));
});

/* ─────────────── F7: تسريب رسائل النظام ─────────────── */
/* تحديث 2026-10-24: الإصدار القديم من هذا الحارس كان يُثبِّت السلوك المسرِّب نفسه
   (يتوقع EPERM + المسار المطلق في الرد). الإصلاح في cortex-import.js
   (errnoMessage :714 + scrubSystemText :734) يقنّع الرموز والمسارات —
   لذلك الحارس يثبّت الاتجاه المعاكس: لا رمز errno ولا مسار مطلق يغادر الخادم أبداً. */
test('SEC-07 | رسائل نظام مُقنَّعة: بلا EPERM/EISDIR وبلا مسار مطلق في أي رد', async () => {
  if (!WIN) return; // مسارات النظام أدناه خاصة بويندوز
  const sam = await imp('C:/Windows/System32/config/SAM');
  const dev = await imp('\\\\?\\C:\\Windows\\win.ini');
  const gone = await imp(path.join(srv.root, 'planted', 'nope-9137.md'));

  note('cortex-import.js:857 errnoMessage', 'POST /api/import {"path":"C:/Windows/System32/config/SAM"}', `${sam.status} · ${short(sam.body, 260)}`);
  note('cortex-import.js:857 errnoMessage', 'POST /api/import {"path":"\\\\\\\\?\\\\C:\\\\Windows\\\\win.ini"}', `${dev.status} · ${short(dev.body, 200)}`);
  note('cortex-import.js:866', 'POST /api/import {"path":"<APP_ROOT>/planted/nope-9137.md"}', `${gone.status} · ${short(gone.body, 200)}`);

  assert.doesNotMatch(sam.body, /EPERM|EACCES/, 'F7: رمز خطأ النظام مُقنَّع');
  assert.doesNotMatch(sam.body, /System32|operation not permitted/i, 'F7: المسار المطلق ونص النظام غير مرسَلين');
  assert.match(sam.body, /مسار محمي أو صلاحية مرفوضة/, 'F7: الرسالة العربية الثابتة حاضرة');
  assert.doesNotMatch(dev.body, /EISDIR/, 'F7: رمز الخطأ الثاني مُقنَّع أيضاً');
  // ENOENT لا يُسرَّب، والمرجع المسموح اسم الملف فقط — لا جذر الخادم ولا مساره
  assert.doesNotMatch(gone.body, /ENOENT/, 'F7: ENOENT لا يتسرب');
  const rootRe = srv.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.doesNotMatch(gone.body, new RegExp(rootRe), 'F7: جذر الخادم لا يظهر في الرد');
});

/* ─────────────── F8: صدى المسار ─────────────── */
test('SEC-08 | المسار المرفوض لا يُعاد في الرد (لا كشف لبنية القرص)', async () => {
  if (!WIN) return;
  const r = await imp('C:/Windows/win.ini');
  const j = (() => { try { return JSON.parse(r.body); } catch { return {}; } })();
  note('cortex-import.js:857-861', 'POST /api/import {"path":"C:/Windows/win.ini"}',
    `${r.status} · error=${short(j.error, 60)} · path=${JSON.stringify(j.path)} · name=${JSON.stringify(j.name)}`);
  assert.equal(r.status, 400);
  assert.equal(j.path, undefined, 'F8: المسار المطلق لا يُعاد في الرد');
  assert.match(String(j.error || ''), /خارج الجذور/, 'F8: سبب الرفض معلن بلا بنية قرص');
});

/* ─────────────── F9: NUL ─────────────── */
test('SEC-09 | محرف NUL يُرفض صراحةً قبل أي لمس للنظام', async () => {
  const r = await imp('C:/Windows/win.ini\u0000.md');
  note('cortex-import.js:686', 'POST /api/import {"path":"C:/Windows/win.ini\\\\u0000.md"}', `${r.status} · ${short(r.body, 160)}`);
  assert.equal(r.status, 400);
  assert.match(r.body, /بايتاً صفرياً|مسار مرفوض/, 'F9: يجب رفض NUL لا تمريره للنظام');
});

/* ─────────────── F10: حد الحمولة ─────────────── */
test('SEC-10 | حد 2MB يطبَّق حتى على جسم chunked بلا Content-Length', async () => {
  const payload = JSON.stringify({ title: 'chunky', content: 'y'.repeat(2 * 1024 * 1024 + 4096) });
  const res = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: srv.port, path: '/api/notes', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cortex-Session': srv.token },
    }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d })); });
    req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
    for (let i = 0; i < payload.length; i += 65536) req.write(payload.slice(i, i + 65536));
    req.end();
  });
  note('server.js:21,791', `POST /api/notes (chunked, ${payload.length} بايت، بلا Content-Length)`, `${res.status} · ${short(res.body, 120)}`);
  assert.equal(res.status, 413, 'F10: الحد يجب أن يُطبَّق على البث لا على الترويسة فقط');
});

/* ─────────────── F12: تضخيم التصدير ───────────────
   كان: 20 تصديراً بلا رمز ⇒ 20 ملفاً. صار 2026-10-26: كلها 401 ولا ملف واحد،
   والمسار الشرعي (بالرمز) يُنتج ملفاً واحداً فقط — لا تضخيم. */
test('SEC-12 | 20 تصديراً سريعاً بلا رمز ⇒ 401 ولا ملف جديد على القرص', async () => {
  const seed = await hit('seed', '/api/export/project?project=sec-export&format=md', {
    headers: { 'X-Cortex-Session': srv.token },
  });
  assert.equal(seed.status, 200, 'البذرة تحتاج تصديراً شرعياً واحداً');
  const dir = path.dirname(JSON.parse(seed.body).file);
  const before = fs.readdirSync(dir).length;

  const codes = [];
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) codes.push((await hit('exp', '/api/export/project?project=sec-export&format=md')).status);
  const ms = Date.now() - t0;
  const afterCount = fs.readdirSync(dir).length;

  note('server.js requiresSession/SIDE_EFFECT_READS', '20 × GET /api/export/project بلا رمز',
    `${codes.join(',')} · ${ms}ms · ملفات: ${before}→${afterCount} (+${afterCount - before})`);
  assert.equal(codes.filter((c) => c === 401).length, 20, 'F12: طلب تصدير مرّ بلا هوية');
  assert.equal(afterCount, before, 'F12: أثر تراكمي على القرص — لا يجب أن يُكتب شيء');
});

/* ─────────────── F13: استخراج أسرار من جذر التطبيق ─────────────── */
test('SEC-13 | استيراد secrets.env داخل APP_ROOT ثم قراءته كنص بلا جلسة', async () => {
  const file = path.join(srv.root, 'planted', 'secrets.env');
  fs.writeFileSync(file, 'DB_PASSWORD=PROBE_SECRET_9137\nAPI_KEY=sk-probe-9137\n', 'utf8');

  const imported = await imp(file);
  const id = (() => { try { return JSON.parse(imported.body).meta?.title || 'secrets'; } catch { return 'secrets'; } })();
  const read = await hit('read', '/api/notes/' + encodeURIComponent(id));

  note('cortex-import.js isSecretFile (2026-10-26)', 'POST /api/import {"path":"<APP_ROOT>/planted/secrets.env"}', `${imported.status} · ${short(imported.body, 150)}`);
  note('server.js:934 (GET بلا جلسة)', `GET /api/notes/${id}`, `${read.status} · secret_in_body=${read.body.includes('PROBE_SECRET_9137')}`);

  // كان: 200 ثم نص يحوي السر بلا مصادقة. صار: رفض صريح، ولا ملاحظة تحمل السر.
  assert.equal(imported.status, 400, 'F13: ملف أسرار ما زال يُستورد');
  const body = JSON.parse(imported.body);
  assert.equal(body.secretRefused, true, 'F13: الرفض يجب أن يعلن سببه ليس صامتاً');
  assert.equal(read.body.includes('PROBE_SECRET_9137'), false, 'F13: السر وصل للمعرفة');
});

/* ─────────────── F14: XSS مخزّن ─────────────── */
test('SEC-14 | HTML/JS في ملاحظة: الخادم يخزّن خاماً، التخفيف في طبقة العرض فقط', async () => {
  const payload = '<img src=x onerror="alert(1)"><script>alert(2)</script><svg onload=alert(3)>';
  const created = await postJson('/api/notes', { title: 'xss-probe', content: payload, project: 'sec-xss' });
  const id = JSON.parse(created.body).note?.id || 'xss-probe';
  const read = await hit('read', '/api/notes/' + id);

  const appJs = fs.readFileSync(path.join(PROJECT_DIR, 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(PROJECT_DIR, 'public', 'index.html'), 'utf8');
  const sinks = (appJs.match(/innerHTML/g) || []).length;
  const escapesFirst = /function renderInline\(text\) \{\s*let s = escapeHtml\(text\)/.test(appJs);
  const hasSanitizerLib = /DOMPurify|sanitize-html/.test(html + appJs);

  note('public/app.js:814 + 15', 'POST /api/notes {"content":"<img onerror><script>"} ثم GET',
    `${created.status}/${read.status} · raw_stored=${read.body.includes('<img src=x onerror=')} · sinks=${sinks} · escapeHtml_first=${escapesFirst} · sanitizer_lib=${hasSanitizerLib}`);

  assert.equal(read.body.includes('<img src=x onerror='), true, 'F14: لا تنقية على الخادم');
  assert.equal(escapesFirst, true, 'التخفيف الحالي: escapeHtml قبل أي إدراج');
  assert.equal(hasSanitizerLib, false, 'F14: لا مكتبة تنقية — الطبقة الوحيدة regex يدوي');
});

/* ─────────────── F15: CSV injection ─────────────── */
test('SEC-15 | CSV injection: الصيغ تُحفظ حرفياً، ولا مُصدِّر CSV يهرّبها', async () => {
  const csv = 'name,value\n=cmd|\' /C calc\'!A1,x\n+1+1,y\n-2+3,z\n@SUM(1+1),w\n';
  const file = path.join(srv.root, 'planted', 'formulas.csv');
  fs.writeFileSync(file, csv, 'utf8');

  const imported = await postJson('/api/import', { path: file, project: 'sec-csv' });
  const id = (() => { try { return JSON.parse(imported.body).meta?.title || 'formulas'; } catch { return 'formulas'; } })();
  const read = await hit('read', '/api/notes/' + id);

  const exported = await hit('exp', '/api/export/project?project=sec-csv&format=md', {
    headers: { 'X-Cortex-Session': srv.token },
  });
  const j = (() => { try { return JSON.parse(exported.body); } catch { return {}; } })();
  const md = j.file && fs.existsSync(j.file) ? fs.readFileSync(j.file, 'utf8') : '';
  const csvFormat = await hit('csvfmt', '/api/export/project?project=sec-csv&format=csv', {
    headers: { 'X-Cortex-Session': srv.token },
  });

  note('cortex-import.js:28 + server.js:409-436', 'استيراد formulas.csv ثم تصدير md ثم طلب format=csv',
    `import=${imported.status} · note_keeps_formula=${read.body.includes("=cmd|' /C calc'!A1")} · md_keeps_formula=${md.includes("=cmd|' /C calc'!A1")} · csv_export=${csvFormat.status}`);

  assert.equal(imported.status, 200);
  assert.equal(read.body.includes("=cmd|' /C calc'!A1"), true, 'F15: الصيغة محفوظة بلا تهريب');
  assert.equal(md.includes("=cmd|' /C calc'!A1"), true, 'F15: الصيغة تنتقل إلى التصدير');
  assert.equal(csvFormat.status, 400, 'لا يوجد مُصدِّر CSV (md | zip فقط)');
});

/* ─────────────── F16: حقن الرؤوس ─────────────── */
test('SEC-16 | CRLF في العنوان/المشروع لا يصل إلى ترويسات الرد', async () => {
  const r = await postJson('/api/notes', { title: 'crlf\r\nX-Inj: 1\r\nSet-Cookie: pwn=1', content: 'body' });
  const exp = await hit('exp', '/api/export/project?project=x%0d%0aX-Injected:%201&format=md');

  note('server.js:669 (json)', 'POST /api/notes {"title":"crlf\\\\r\\\\nX-Inj: 1"}',
    `${r.status} · x-inj=${r.headers.get('x-inj')} · set-cookie=${r.headers.get('set-cookie')}`);
  note('server.js:1479', 'GET /api/export/project?project=x%0d%0aX-Injected:%201',
    `${exp.status} · x-injected=${exp.headers.get('x-injected')}`);

  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-inj'), null, 'F16: لا حقن رؤوس من العنوان');
  assert.equal(exp.headers.get('x-injected'), null, 'F16: لا حقن رؤوس من معامل المشروع');
});

/* ─────────────── F11: حصر المعدل على الاستيراد ───────────────
   كان: 20 طلباً ⇒ 200×20 و429=0 (لا نافذة معدل). صار 2026-10-26: ميزان رشقة
   في cortex-policy.js (RATE_BUDGETS) يُستدعى من بوابة handleApi المركزية.
   موضوع آخر الملف عمداً: الميزان مشترك لكل عميل، فاختبارات الاستيراد السابقة
   كانت تستهلك النافذة وتجعل هذا الاختبار غير حتمي. ننتظر انقضاء نافذة كاملة
   قبل القياس، فيبدأ من ميزانية نظيفة معروفة. */
test('SEC-11 | حصر المعدل: رشقة استيراد تُردّ بـ429 بدل 200×N', async () => {
  const { RATE_BUDGETS } = await import('../cortex-policy.js');
  const windowMs = RATE_BUDGETS.import.windowMs;
  await new Promise((r) => setTimeout(r, windowMs + 500)); // نافذة نظيفة
  const file = path.join(srv.root, 'planted', 'bulk.md');
  fs.writeFileSync(file, '# bulk\n\n' + 'x'.repeat(20000), 'utf8');
  const codes = [];
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) codes.push((await imp(file)).status);
  const ms = Date.now() - t0;
  const limited = codes.filter((c) => c === 429).length;
  note('cortex-policy.js RATE_BUDGETS.import + server.js (بوابة handleApi)', '40 × POST /api/import لملف 20KB', `${codes.join(',')} · ${ms}ms · 429=${limited}`);
  assert.ok(limited > 0, 'F11: لا نافذة حصر معدل — 40 طلباً مرّت بلا 429');
  assert.equal(codes[0], 200, 'الطلب الأول يجب أن ينجح — الحدّ ليس حجباً أعمى');
  assert.ok(limited < 40, 'ليس كل شيء مرفوضاً — الحدّ نافذة لا إغلاقاً');
  assert.ok(codes.every((c) => c === 200 || c === 400 || c === 429), 'الردود غير متوقعة');
  // الحدّ مذكور في الرد ولا يخفي السبب
  const blocked = await imp(file);
  assert.equal(blocked.status, 429);
  const body = JSON.parse(blocked.body);
  assert.equal(body.code, 'rate_limited');
  assert.ok(body.retryAfter >= 1, 'retryAfter مطلوب ليُعلم العميل متى يعيد');
});
