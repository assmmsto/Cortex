import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../cortex-schema');
const P = require('../cortex-privacy');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  schema.migrate(db);
  return db;
}

// ─────────────────────────────────────────────────────────────────
// السياسة الافتراضية — محلي أولاً
// ─────────────────────────────────────────────────────────────────
test('defaultPolicy: محلي أولاً — الأسرار والأوامر مرفوعة دائماً', () => {
  const off = P.defaultPolicy();
  assert.equal(off.secrets.allowed, false);
  assert.equal(off.commands.allowed, false);
  assert.equal(off.knowledge.allowed, false);
  assert.equal(off.metadata.allowed, false, 'لا مزود مفعّل = لا شيء مفتوح');

  // حتّى مع تفعيل المزودين: الأسرار والأوامر تبقى مرفوعة
  const on = P.defaultPolicy({ providersEnabled: true });
  assert.equal(on.secrets.allowed, false, 'الأسرار مرفوعة دائماً');
  assert.equal(on.commands.allowed, false, 'الأوامر مرفوعة دائماً');
  assert.equal(on.metadata.allowed, true, 'metadata فقط يُفتح عند تفعيل مزود');
  assert.equal(on.knowledge.allowed, false, 'نصوص المعرفة تبقى مرفوعة افتراضياً');

  // كل صنف له ملاحظة عربية
  for (const key of Object.keys(P.DATA_CLASSES)) {
    assert.equal(typeof off[key].note, 'string');
    assert.ok(off[key].note.length > 0);
  }
});

test('limitsFor: الأسرار ممنوعة حتى إلى مزود محلي، والمسارات ممنوعة سحابياً', () => {
  assert.equal(P.limitsFor('openrouter', 'secrets').allowed, false);
  assert.equal(P.limitsFor('local', 'secrets').allowed, false, 'الأسرار لا تُرسل حتى محلياً');
  assert.equal(P.limitsFor('openrouter', 'paths').allowed, false, 'المسارات لا تُرسل سحابياً');
  assert.equal(P.limitsFor('ollama', 'paths').allowed, true, 'المزود المحلي يقبل كل شيء');
  assert.equal(P.limitsFor('openrouter', 'metadata', { providersEnabled: true }).allowed, true);
});

// ─────────────────────────────────────────────────────────────────
// logConnection
// ─────────────────────────────────────────────────────────────────
test('logConnection: يرفض تسجيل secrets مع allowed=true', () => {
  const db = freshDb();
  const res = P.logConnection(db, {
    provider: 'openrouter', purpose: 'chat', dataClass: 'secrets', allowed: true, bytes: 40
  });
  assert.equal(res.ok, false);
  assert.match(res.warning, /إرسال الأسرار ممنوع/);

  // لم يُكتب شيء في connection_log
  const count = db.prepare('SELECT COUNT(*) AS n FROM connection_log').get().n;
  assert.equal(count, 0, 'لا صف في connection_log بعد الرفض');
});

test('logConnection: ينجح مع metadata ويُكتب في الجدولين', () => {
  const db = freshDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  const res = P.logConnection(db, {
    provider: 'openrouter', purpose: 'embed', dataClass: 'metadata', allowed: true, bytes: 128
  });
  assert.equal(res.ok, true);
  assert.ok(Number.isInteger(res.id) && res.id > 0);

  const conn = db.prepare('SELECT COUNT(*) AS n FROM connection_log').get().n;
  assert.equal(conn, 1, 'صف واحد في connection_log');

  const after = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  assert.equal(after - before, 1, 'أثر واحد في audit_log');

  const audit = db.prepare("SELECT type, scope, tool FROM audit_log WHERE type = 'external_connection'").get();
  assert.ok(audit, 'يوجد أثر نوعه external_connection');
  assert.equal(audit.scope, 'external');

  const row = db.prepare('SELECT provider, data_kind, allowed, bytes FROM connection_log').get();
  assert.equal(row.provider, 'openrouter');
  assert.equal(row.data_kind, 'metadata');
  assert.equal(row.allowed, 1);
  assert.equal(row.bytes, 128);
});

// ─────────────────────────────────────────────────────────────────
// connectionHistory
// ─────────────────────────────────────────────────────────────────
test('connectionHistory: يعيد الأحدث أولاً', () => {
  const db = freshDb();
  P.logConnection(db, { provider: 'openrouter', purpose: 'first', dataClass: 'metadata', allowed: true });
  P.logConnection(db, { provider: 'openrouter', purpose: 'second', dataClass: 'metadata', allowed: true });
  P.logConnection(db, { provider: 'anthropic', purpose: 'third', dataClass: 'metadata', allowed: true });

  const all = P.connectionHistory(db, { limit: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[0].purpose, 'third', 'الأحدث أولاً');
  assert.equal(all[2].purpose, 'first', 'الأقدم آخراً');
  assert.equal(all[0].allowed, true, 'allowed يُعاد منطقياً لا 0/1');

  const filtered = P.connectionHistory(db, { provider: 'openrouter' });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((r) => r.provider === 'openrouter'));
  assert.equal(filtered[0].purpose, 'second');
});

// ─────────────────────────────────────────────────────────────────
// usageSummary — لا تخمين للتكلفة
// ─────────────────────────────────────────────────────────────────
test('usageSummary: لا يخمّن — الصفوف بلا cost تُحتسب في unknownCostCalls فقط', () => {
  const db = freshDb();
  const ins = db.prepare(
    'INSERT INTO model_usage(provider, model, at, prompt_tokens, completion_tokens, cost, source, purpose, ok) VALUES (?,?,?,?,?,?,?,?,?)'
  );
  ins.run('openrouter', 'm1', '2026-01-01T00:00:00Z', 100, 50, 0.02, 'api', 'chat', 1);
  ins.run('openrouter', 'm1', '2026-01-02T00:00:00Z', 200, 80, 0.05, 'api', 'chat', 1);
  ins.run('local', 'm2', '2026-01-03T00:00:00Z', 300, 20, null, 'unknown', 'chat', 1);
  ins.run('local', 'm2', '2026-01-04T00:00:00Z', 40, 10, null, 'unknown', 'chat', 1);

  const all = P.usageSummary(db);
  assert.equal(all.calls, 4);
  assert.equal(all.promptTokens, 640);
  assert.equal(all.completionTokens, 160);
  assert.equal(all.unknownCostCalls, 2, 'صفّان بلا cost');
  assert.ok(Math.abs(all.knownCost - 0.07) < 1e-9, `knownCost=${all.knownCost} (المعروف فقط)`);

  // فلترة بالتاريخ: تستبعد الصفوف الأقدم
  const recent = P.usageSummary(db, { since: '2026-01-03T00:00:00Z' });
  assert.equal(recent.calls, 2);
  assert.equal(recent.knownCost, 0, 'لا صف معروف التكلفة في النطاق');
  assert.equal(recent.unknownCostCalls, 2);
});

// ─────────────────────────────────────────────────────────────────
// privacyNotice
// ─────────────────────────────────────────────────────────────────
test('privacyNotice: يذكر «يُرسل إلى» سحابياً ولا يزعم أن البيانات لا تغادر الجهاز', () => {
  const cloud = P.privacyNotice('openrouter', 'knowledge');
  assert.match(cloud, /يُرسل إلى/, 'يجب أن يذكر «يُرسل إلى»');
  assert.match(cloud, /تغادر جهازك/, 'يجب أن يصرّح أن البيانات تغادر الجهاز');
  assert.match(cloud, /سحابي/);
  // لا ادّعاء بالبقاء محلياً
  assert.doesNotMatch(cloud, /لا تغادر الجهاز/);
  assert.doesNotMatch(cloud, /يبقى داخل جهازك/);
  assert.match(cloud, /لن تُرسل/, 'يعرض ما لن يُرسل');

  const local = P.privacyNotice('ollama', 'knowledge');
  assert.match(local, /محلي/);
  assert.match(local, /داخل جهازك/);
  assert.doesNotMatch(local, /يُرسل إلى/, 'المحلي لا يتصل بشبكة');
});

// ─────────────────────────────────────────────────────────────────
// maskSecret
// ─────────────────────────────────────────────────────────────────
test('maskSecret: الطويل يُقنّع جزئياً والقصير كلياً', () => {
  const long = 'sk-1234567890abcdefXYZ';
  const masked = P.maskSecret(long);
  assert.equal(masked, 'sk-123…fXYZ', 'أول 6 و4 أخيرة مع فاصل');
  assert.ok(masked.includes('…'));
  assert.ok(!masked.includes(long), 'لا تُعرض القيمة كاملة');
  assert.ok(!masked.includes('7890'), 'المتن مقنّع');

  // أقصر من 12 → تقنيع كامل
  assert.equal(P.maskSecret('short'), '***');
  assert.equal(P.maskSecret('12345678901'), '***', '11 حرفاً = تقنيع كامل');
  assert.equal(P.maskSecret('123456789012').startsWith('123456'), true, '12 حرفاً = حد التقنيع الجزئي');
  assert.equal(P.maskSecret(''), '***');
});

// ─────────────────────────────────────────────────────────────────
// scanForSecrets
// ─────────────────────────────────────────────────────────────────
test('scanForSecrets: يكشف sk- و Bearer و ghp_ بلا إظهار القيمة كاملة', () => {
  const text = [
    'config: OPENAI=sk-abcdEFGH1234567890ijkl',
    'auth: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'git token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
    'aws AKIAIOSFODNN7EXAMPLE'
  ].join('\n');

  const found = P.scanForSecrets(text);
  const types = found.map((f) => f.type);
  assert.ok(types.includes('openai_sk'), 'يكشف sk-');
  assert.ok(types.includes('bearer'), 'يكشف Bearer');
  assert.ok(types.includes('github'), 'يكشف ghp_');
  assert.ok(types.includes('aws_akia'), 'يكشف AKIA');

  for (const f of found) {
    assert.ok(Number.isInteger(f.index) && f.index >= 0, 'موقع صحيح');
    assert.equal(typeof f.masked, 'string');
    assert.ok(f.masked.includes('…') || f.masked === '***');
  }

  // لا تُعرض القيمة الكاملة لأي سرّ
  const sk = found.find((f) => f.type === 'openai_sk');
  assert.ok(!sk.masked.includes('sk-abcdEFGH1234567890ijkl'), 'القيمة الكاملة محجوبة');
  const bearer = found.find((f) => f.type === 'bearer');
  assert.ok(!bearer.masked.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'رمز Bearer محجوب');

  // text نظيف = لا نتائج
  assert.deepEqual(P.scanForSecrets('لا شيء هنا، مجرد نص عادي'), []);
});

// ─────────────────────────────────────────────────────────────────
// حماية audit_log
// ─────────────────────────────────────────────────────────────────
test('audit_log محمي: محاولة الحذف تُرفض', () => {
  const db = freshDb();
  P.logConnection(db, { provider: 'openrouter', purpose: 'x', dataClass: 'metadata', allowed: true });
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n >= 1);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /محمي|ممنوع/);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n >= 1, 'الصف باقٍ بعد المحاولة');
});
