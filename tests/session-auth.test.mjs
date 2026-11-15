// tests/session-auth.test.mjs — §34: لا كتابة بلا هوية.
// يُثبت العقد كاملاً: بلا رمز ⇒ 401 + لا أثر على القرص؛ مع الرمز ⇒ 200 + أثر حقيقي.
// الاختبار يقيس القرص لا الاستجابة (المخرج «applied» قد يكذب).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { startLiveServer } from './_live-server.mjs';
// العطل 2026-10-20: كان يستعمل خادم 3737 الحيّ، فيفشل بـ«daily limit reached for
// fs (60)» لأن data/audit.log المشترك استُهلك بجولات التطوير — سبب خارجي عن
// الكود. الآن يقلع خادمه المعزول ببيئة حتمية، فالنتيجة لا تعتمد على من شغّل ماذا.
const SRV = await startLiveServer();
const BASE = SRV.base;
// مسار **مطلق** داخل جذر الخادم المعزول: مسار نسبي يُحلّ نسبةً لـcwd الخادم
// (= مجلد المشروع) فيكتب في المشروع الحقيقي بدل بيئة الاختبار — عطل مُثبت 2026-10-20.
const PROBE = path.join(SRV.root, 'vault', '_test_session_auth_probe.md');
// إيقاف الخادم المعزول في النهاية الصريحة (process.on('exit') لا يُنفَّذ تحت
// node --test، فيبقى الخادم حياً ويعلّق الملف — درس 2026-10-20).
test.after(async () => { await SRV.stop(); });


async function call(p, method = 'GET', body, hdrs) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(hdrs || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null;
  try { j = await r.json(); } catch { /* بلا جسم */ }
  return { status: r.status, json: j };
}

const filePath = () => PROBE;
const cleanup = () => { try { fs.rmSync(filePath(), { force: true }); } catch { /* غير موجود */ } };

test.after?.(() => {}); // no-op

test('بلا رمز جلسة: الكتابة تُرفض 401 ولا يُنشأ أي ملف على القرص', async () => {
  cleanup();
  const res = await call('/api/agent/execute', 'POST', {
    mutations: [{ tool: 'fs_write', args: { path: PROBE, content: 'هجمة اختبار' } }],
    project: 'default',
  });
  assert.equal(res.status, 401, `توقّع 401 بلا جلسة، حصلنا على ${res.status}`);
  assert.equal(fs.existsSync(filePath()), false, 'الملف أُنشئ رغم غياب الجلسة — ثغرة');
  cleanup();
});

test('برمز جلسة صحيح: الكتابة تمرّ ويظهر الأثر على القرص فعلاً', async () => {
  cleanup();
  const s = await call('/api/session', 'GET', undefined, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(s.status, 200, 'مسار تسليم الجلسة معطّل');
  assert.ok(s.json && s.json.token && s.json.token.length >= 32, 'رمز الجلسة غير صالح');
  const res = await call('/api/agent/execute', 'POST', {
    mutations: [{ tool: 'fs_write', args: { path: PROBE, content: 'كتابة موثّقة' } }],
    project: 'default',
  }, { 'X-Cortex-Session': s.json.token });
  assert.equal(res.status, 200, `توقّع 200 مع رمز صحيح، حصلنا على ${res.status}`);
  assert.equal(fs.existsSync(filePath()), true, 'الرمز الصحيح لم ينفّذ الكتابة');
  cleanup();
});

test('رمز مزوّر مرفوض — لا تُقبل أي هوية مجهولة', async () => {
  cleanup();
  const fake = 'f'.repeat(64);
  const res = await call('/api/agent/execute', 'POST', {
    mutations: [{ tool: 'fs_write', args: { path: PROBE, content: 'تزوير' } }],
    project: 'default',
  }, { 'X-Cortex-Session': fake });
  assert.equal(res.status, 401, 'رمز مزوّر قُبل — ثغرة مصادقة');
  assert.equal(fs.existsSync(filePath()), false);
  cleanup();
});

/* 2026-11-12: هذا الاختبار كان يُثبت أن نقطة التسليم **غير محمية** — وهي بالضبط
   الثغرة الحرجة F1. أُغلقت: صارت تخدم المتصفح على الأصل نفسه فقط، وترفض غير
   المتصفح. الاختبار يحمي الحالة الجديدة، لا الحالة القديمة. */
test('مسار تسليم الجلسة يخدم المتصفح المحلي فقط — لا عملية غير متصفح', async () => {
  const scripted = await call('/api/session');
  assert.equal(scripted.status, 403, 'غير المتصفح لا يحصل على الرمز');
  assert.ok(!(scripted.json && scripted.json.token), 'لا رمز في جسم الرفض');

  const browser = await call('/api/session', 'GET', undefined, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(browser.status, 200, 'المتصفح على الأصل نفسه يمرّ');
  assert.ok(browser.json && browser.json.token, 'لا رمز يُسلَّم للمتصفح');
});

test('قراءة المسارات لا تتطلب جلسة — المنع على الكتابة فقط (§33)', async () => {
  const res = await call('/api/status');
  assert.equal(res.status, 200, 'القراءة يجب أن تعمل بلا رمز');
});
