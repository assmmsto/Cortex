import test from 'node:test';
import assert from 'node:assert/strict';
import policy from '../cortex-policy.js';
const { RATE_BUDGETS, rateLimit, resetRateLimits } = policy;

test.beforeEach(() => resetRateLimits());

test('RL-1 | الافتراضيات موجودة وموجبة لكل صنف مكلف', () => {
  for (const name of ['import', 'export', 'agent', 'ai', 'models']) {
    assert.ok(RATE_BUDGETS[name], `الصنف ${name} مفقود`);
    assert.ok(RATE_BUDGETS[name].limit > 0, `${name}: الحدّ يجب أن يكون موجباً`);
    assert.ok(RATE_BUDGETS[name].windowMs >= 1000, `${name}: النافذة قصيرة جداً`);
  }
});

test('RL-2 | يسمح حتى الحدّ ثم يرفض مع retryAfter موجب', () => {
  const { limit, windowMs } = RATE_BUDGETS.import;
  const t0 = 1_000_000;
  for (let i = 0; i < limit; i++) {
    const r = rateLimit('import', 'c1', t0 + i);
    assert.equal(r.ok, true, `الطلب ${i + 1} يجب أن يمرّ`);
    assert.equal(r.remaining, limit - i - 1);
  }
  const blocked = rateLimit('import', 'c1', t0 + limit);
  assert.equal(blocked.ok, false, 'الطلب فوق الحدّ يجب أن يُرفض');
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= Math.ceil(windowMs / 1000) + 1);
  assert.equal(blocked.limit, limit);
});

test('RL-3 | النافذة تنزلق: بعد مرور نافذة كاملة يُسمح من جديد', () => {
  const { limit, windowMs } = RATE_BUDGETS.export;
  const t0 = 5_000_000;
  for (let i = 0; i < limit; i++) rateLimit('export', 'c2', t0 + i);
  assert.equal(rateLimit('export', 'c2', t0 + limit).ok, false);
  // بعد انقضاء النافذة كلها تعود الميزانية كاملة
  const after = rateLimit('export', 'c2', t0 + windowMs + limit + 1);
  assert.equal(after.ok, true, 'بعد النافذة يجب أن يُسمح');
  assert.equal(after.remaining, limit - 1);
});

test('RL-4 | كل عميل له ميزانيته — رشقة عميل لا تحجب آخر', () => {
  const { limit } = RATE_BUDGETS.agent;
  for (let i = 0; i < limit; i++) rateLimit('agent', 'A', 9_000_000 + i);
  assert.equal(rateLimit('agent', 'A', 9_000_000 + limit).ok, false);
  assert.equal(rateLimit('agent', 'B', 9_000_000 + limit).ok, true, 'عميل آخر يجب ألا يتأثر');
});

test('RL-5 | الأصناف مستقلة — استيراد مزدحم لا يمنع تصديراً', () => {
  const { limit } = RATE_BUDGETS.import;
  for (let i = 0; i < limit; i++) rateLimit('import', 'c3', 7_000_000 + i);
  assert.equal(rateLimit('import', 'c3', 7_000_000 + limit).ok, false);
  assert.equal(rateLimit('export', 'c3', 7_000_000 + limit).ok, true);
});

test('RL-6 | صنف مجهول لا يُقيَّد، وإعادة التهيئة تُفرّغ الميزان', () => {
  assert.equal(rateLimit('nope', 'c4').ok, true);
  const { limit } = RATE_BUDGETS.ai;
  for (let i = 0; i < limit; i++) rateLimit('ai', 'c5', 3_000_000 + i);
  assert.equal(rateLimit('ai', 'c5', 3_000_000 + limit).ok, false);
  resetRateLimits();
  assert.equal(rateLimit('ai', 'c5', 3_000_000 + limit).ok, true, 'بعد التهيئة تُسمح الطلبات');
});
