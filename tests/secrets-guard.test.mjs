/**
 * حارس المفاتيح — يمنع رجوع ثغرة «المفتاح يُعاد كاملاً عبر API عام».
 *
 * الثغرة الأصلية (مؤكدة حياً): `GET /api/settings` كان يُرجع `sk_9ff997e...`
 * كاملاً (35 حرفاً) لأي طلب بلا مصادقة.
 *
 * الإصلاح: التقنيع إلزامي في القراءة وفي رد الحفظ، وحفظ إعدادات مقنّعة
 * لا يمحو المفتاح الحقيقي المخزّن.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// العطل 2026-10-20: كان يستعمل خادم 3737 الحيّ (بيئة خارجية) فتفشل نتائجه
// بحالة data/audit.log المشترك. الآن يقلع خادمه المعزول ببيئة حتمية.
import { startLiveServer } from './_live-server.mjs';
const SRV = await startLiveServer();
const BASE = SRV.base;
test.after(async () => { await SRV.stop(); });
const KEY_RE = /(sk_[A-Za-z0-9_-]{20,}|rv_[A-Za-z0-9_-]{20,})/;

async function get(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, text: await r.text() };
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text(), json: await r.json().catch(() => null) };
}

test('المفاتيح: GET /api/settings لا يكشف مفتاحاً كاملاً', async () => {
  const r = await get('/api/settings');
  assert.equal(r.status, 200);
  assert.equal(KEY_RE.test(r.text), false, 'وُجد مفتاح كامل في الرد — يجب أن يُقنّع');
});

test('المفاتيح: التقنيع موجود ويعلن وجود مفتاح', async () => {
  const r = await get('/api/settings');
  const j = JSON.parse(r.text);
  if (!j.ai) return; // لا مزود مهيّأ
  if (j.ai.hasApiKey) {
    assert.ok(typeof j.ai.apiKeyMasked === 'string' && j.ai.apiKeyMasked.length > 0, 'يجب إعلان المقنّع');
    assert.equal(j.ai.apiKey, undefined, 'المفتاح الحقيقي يجب ألا يُرجع');
    assert.ok(j.ai.apiKeyMasked.includes('…') || j.ai.apiKeyMasked === '***', 'شكل التقنيع صريح');
  }
});

test('المفاتيح: كل المزودين مقنّعون', async () => {
  const r = await get('/api/models/providers');
  assert.equal(r.status, 200);
  assert.equal(KEY_RE.test(r.text), false, 'مفتاح كامل في قائمة المزودين');
});

test('المفاتيح: الحفظ بمقنّع لا يمحو المفتاح الحقيقي', async () => {
  const before = JSON.parse((await get('/api/settings')).text);
  if (!before.ai || !before.ai.hasApiKey) return; // لا مفتاح لاختباره
  const maskedBefore = before.ai.apiKeyMasked;

  // نرسل الإعدادات كما تستقبلها الواجهة (مقنّعة) مع تغيير بريء
  const payload = JSON.parse(JSON.stringify(before));
  payload.ai.temperature = 0.25;
  const saved = await post('/api/settings', payload);
  assert.equal(saved.status, 200);
  assert.equal(KEY_RE.test(saved.text), false, 'رد الحفظ كشف مفتاحاً');

  const after = JSON.parse((await get('/api/settings')).text);
  assert.equal(after.ai.hasApiKey, true, 'المفتاح مُحي بعد حفظ مقنّع!');
  assert.equal(after.ai.apiKeyMasked, maskedBefore, 'بصمة المفتاح تغيّرت — ربما استُبدل بقيمة مقنّعة');
});

test('المفاتيح: لا مفتاح في أي مسار عام شائع', async () => {
  for (const ep of ['/api/status', '/api/governance', '/api/usage', '/api/connections', '/api/models/providers']) {
    const r = await get(ep);
    assert.equal(KEY_RE.test(r.text), false, `مفتاح مكشوف في ${ep}`);
  }
});
