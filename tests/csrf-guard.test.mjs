/**
 * حارس CSRF — يمنع رجوع ثغرة «أي موقع يكتب في معرفتك».
 *
 * الثغرة الأصلية (مؤكدة حياً): لا فحص Origin/Referer؛ طلب POST بسيط
 * (Content-Type: text/plain) من أي صفحة خارجية كان يمرّ بـ 200 ويكتب في القاعدة.
 * CORS لا يحمي من ذلك لأنه يقيّد القراءة لا الإرسال.
 *
 * الإصلاح: كل طلب مُغيِّر (غير GET/HEAD/OPTIONS) على /api/ يجب أن يكون من أصل محلي،
 * وإلا 403 UNTRUSTED_ORIGIN. الطلبات البرمجية بلا Origin (curl/سكربت) تبقى مسموحة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionToken } from './_session.mjs';
// §34: الرمز يُقرأ لحظياً من نفس خندق الواجهة (data/session.token أو /api/session)
// — بدل الاعتماد على متغير نطاقي يغيب عن الدوال العامة.
let __TOKEN_CACHE = null;
async function __sess() {
  if (__TOKEN_CACHE) return { 'X-Cortex-Session': __TOKEN_CACHE };
  __TOKEN_CACHE = await sessionToken({ base: process.env.CORTEX_BASE || 'http://127.0.0.1:3737' });
  return __TOKEN_CACHE ? { 'X-Cortex-Session': __TOKEN_CACHE } : {};
}


// العطل 2026-10-20: كان يستعمل خادم 3737 الحيّ (بيئة خارجية) فتفشل نتائجه
// بحالة data/audit.log المشترك. الآن يقلع خادمه المعزول ببيئة حتمية.
import { startLiveServer } from './_live-server.mjs';
const SRV = await startLiveServer();
const BASE = SRV.base;
test.after(async () => { await SRV.stop(); });
// §34: الكتابة تتطلب رمز جلسة — يُقرأ من نفس خندق الواجهة.
const TOKEN = await sessionToken({ base: BASE });

async function call(method, path, body, headers) {
  const res = await fetch(BASE + path, {
    method,
    // §34: الرمز يُدمَج دائماً — الترويسات الصريحة تحدد الأصل لا المصادقة.
    headers: { ...(await __sess()), ...(headers || (body ? { 'Content-Type': 'application/json' } : {})) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* رد غير JSON */ }
  return { status: res.status, json };
}

test('CSRF: POST من أصل خارجي مرفوض 403', async () => {
  const r = await call('POST', '/api/notes', { title: '__csrf_test_evil__', content: 'x' }, {
    'Content-Type': 'application/json',
    Origin: 'https://evil.example',
  });
  assert.equal(r.status, 403, `يجب الرفض، وصل ${r.status}`);
  assert.equal(r.json && r.json.code, 'UNTRUSTED_ORIGIN');
});

test('CSRF: طلب بسيط (text/plain) من أصل خارجي مرفوض أيضاً', async () => {
  // المتصفح يسمح بهذا النوع بلا preflight — لذلك الفحص في الخادم ضروري
  const r = await call('POST', '/api/agent/execute', { mutations: [] }, {
    'Content-Type': 'text/plain',
    Origin: 'https://evil.example',
  });
  assert.equal(r.status, 403);
});

test('CSRF: Referer خارجي بلا Origin مرفوض', async () => {
  const r = await call('POST', '/api/notes', { title: '__csrf_test_ref__', content: 'x' }, {
    'Content-Type': 'application/json',
    Referer: 'https://evil.example/page',
  });
  assert.equal(r.status, 403);
});

test('CSRF: Sec-Fetch-Site: cross-site مرفوض', async () => {
  const r = await call('POST', '/api/notes', { title: '__csrf_test_sfs__', content: 'x' }, {
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'cross-site',
  });
  assert.equal(r.status, 403);
});

test('CSRF: الكتابة من localhost تمرّ (لا كسر للوظيفة الشرعية)', async () => {
  const title = '__csrf_test_ok__';
  const r = await call('POST', '/api/notes', { title, content: 'اختبار' }, {
    'Content-Type': 'application/json',
    Origin: 'http://127.0.0.1:3737',
  });
  assert.equal(r.status, 200, `يجب أن يمر: ${JSON.stringify(r.json).slice(0, 120)}`);
  // تنظيف
  await call('DELETE', '/api/notes/' + encodeURIComponent(title));
});

test('CSRF: الطلبات البرمجية بلا Origin (curl) تمرّ', async () => {
  const title = '__csrf_test_curl__';
  const r = await call('POST', '/api/notes', { title, content: 'curl' });
  assert.equal(r.status, 200);
  await call('DELETE', '/api/notes/' + encodeURIComponent(title));
});

test('CSRF: GET لا يتأثر بالفحص', async () => {
  const r = await call('GET', '/api/notes');
  assert.equal(r.status, 200);
});
