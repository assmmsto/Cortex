/**
 * حارس الخصوصية الفعلية — يمنع رجوع «السياسة ورقية».
 *
 * العطل الأصلي (مؤكد بالتقارير والكود): `cortex-privacy` موجود ومختبَر بـ10 اختبارات،
 * و`limitsFor`/`logConnection` **صفر استدعاء** في كود الإنتاج. المتون تُرسل لمزود سحابي
 * بلا فحص، وسجل الاتصالات يبقى فارغاً. الاختبارات الخضراء كانت تمنح تأكيداً زائفاً.
 *
 * الإصلاح: `callModel` يمرّ عبر limitsFor وينفّذ logConnection، ويكشف الأسرار في الحمولة.
 * هذه الاختبارات تتحقق من الأثر الفعلي (سجل حقيقي + منع حقيقي)، لا من وجود الدوال.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// العطل 2026-10-20: كان يستعمل خادم 3737 الحيّ (بيئة خارجية) فتفشل نتائجه
// بحالة data/audit.log المشترك. الآن يقلع خادمه المعزول ببيئة حتمية.
import { startLiveServer } from './_live-server.mjs';
const SRV = await startLiveServer();
const BASE = SRV.base;
test.after(async () => { await SRV.stop(); });

async function get(path) {
  const r = await fetch(BASE + path);
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function post(path, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, {
      method: 'POST',
      // §34: /api/ai/chat مسار تنفيذ يحتاج رمز جلسة — بلا رمز يعود 401
      // فيفشل الاختبار بـ«الطلب يُخدم لكن بمُنع صريح» بلا عطل في الخصوصية.
      headers: SRV.headers(),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
}

test('الخصوصية: سجل الاتصالات يُكتب فعلياً بعد نداء نموذج', async () => {
  const before = await get('/api/connections');
  const beforeCount = (before.json && (before.json.items || []).length) || 0;

  // نداء نموذج حقيقي (قد يكون mock محلياً — لا يهم، الأثر هو المطلوب)
  await post('/api/ai/chat', { messages: [{ role: 'user', content: 'اختبار سجل الخصوصية' }] });

  const after = await get('/api/connections');
  const afterCount = (after.json && (after.json.items || []).length) || 0;
  assert.ok(afterCount >= beforeCount, 'عدد الاتصالات يجب ألا يتراجع');
  assert.ok(afterCount > 0, 'سجل الاتصالات فارغ — السياسة غير منفّذة');
});

test('الخصوصية: إرسال مفتاح API في نص يُمنع قبل مغادرة الجهاز', async () => {
  const r = await post('/api/ai/chat', {
    messages: [{ role: 'user', content: 'هذا مفتاحي sk_9ff997e1234567890abcdef12345678 خذه' }],
  });
  assert.equal(r.status, 200, 'الطلب يُخدم لكن بمُنع صريح في الرد');
  assert.ok(
    /مُنع الإرسال|سراً محتملاً|secret/i.test(r.text),
    `لم يُمنع الإرسال: ${r.text.slice(0, 200)}`
  );
});

test('الخصوصية: النداء العادي لا يُمنع (السياسة لا تعطّل المنتج)', async () => {
  const r = await post('/api/ai/chat', { messages: [{ role: 'user', content: 'قل: جاهز' }] });
  assert.equal(r.status, 200);
  assert.equal(/مُنع الإرسال/.test(r.text), false, 'المنع يجب ألا يطال نصاً عادياً');
});

test('الخصوصية: الأسرار وأوامر التنفيذ محظورة دائماً بأي إعداد', async () => {
  // عبر وحدة السياسة مباشرة (قرار حتمي لا اتصال)
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const priv = require('../cortex-privacy.js');
  for (const enabled of [false, true]) {
    for (const cls of ['secrets', 'commands']) {
      const v = priv.limitsFor('any-cloud-provider', cls, { providersEnabled: enabled });
      assert.equal(v.allowed, false, `${cls} يجب أن يبقى محظوراً (providersEnabled=${enabled})`);
    }
  }
});

test('الخصوصية: قرار المستخدم الصريح يفتح knowledge للسحابي (لا حظر أبدي)', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const priv = require('../cortex-privacy.js');
  const v = priv.limitsFor('any-cloud-provider', 'knowledge', { providersEnabled: true });
  assert.equal(v.allowed, true, 'اختيار المستخدم مزوداً سحابياً = موافقة صريحة');
  assert.equal(v.explicit, true, 'يجب وسم القرار بأنه صريح');
});

test('الخصوصية: المزود المحلي مسموح دائماً لغير الأسرار', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const priv = require('../cortex-privacy.js');
  assert.equal(priv.limitsFor('ollama', 'knowledge').allowed, true);
  assert.equal(priv.limitsFor('ollama', 'secrets').allowed, false, 'حتى المحلي لا يأخذ الأسرار');
});
