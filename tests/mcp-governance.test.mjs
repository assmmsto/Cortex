/**
 * حارس حوكمة MCP — يمنع رجوع «أداة MCP تُنفَّذ بلا اعتماد».
 *
 * العطل الأصلي (مؤكد حياً): `specPolicy` في `/api/mcp/call` كان يُحسب من
 * `toToolPolicy` ثم **يُهمَل تماماً** — فنُفِّذ `memory_delete_note` فعلياً
 * بلا أي اعتماد، رغم أن السياسة تصنّف كل أدوات MCP `alwaysDraft: true` (§31).
 *
 * القاعدة الصحيحة: كل أداة MCP مسودة تحتاج `approved:true` صراحةً،
 * وكل نداء — ناجحاً أو مرفوضاً — يُسجَّل في `mcp_calls`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// خادم معزول ببيئة حتمية + رمز جلسة (§34): الاعتماد مسار تنفيذ.
// العطل 2026-10-20: كان يضرب 3737 الحيّ بلا رمز ⇒ 401 على «الإنشاء بُاعتماد».
import { startLiveServer } from './_live-server.mjs';
const SRV = await startLiveServer();
const BASE = SRV.base;
const SERVER = 'cortex-memory';
test.after(async () => { await SRV.stop(); });

async function call(body) {
  const r = await fetch(BASE + '/api/mcp/call', { method: 'POST', headers: SRV.headers(), body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

test('حوكمة MCP — لا تنفيذ بلا اعتماد صريح', async (t) => {

  const id = 'mcp-guard-' + Date.now();

  // أنشئ عنصراً حقيقياً (اعتماد صريح)
  const made = await call({ server: SERVER, tool: 'memory_upsert_note', args: { id, title: 'هدف الحارس', content: 'محتوى للاختبار' }, approved: true });
  assert.equal(made.status, 200, 'الإنشاء بُاعتماد يعمل');

  // 1) الحذف بلا اعتماد ⇒ مسودة، لا تنفيذ
  const noApprove = await call({ server: SERVER, tool: 'memory_delete_note', args: { id } });
  assert.equal(noApprove.status, 202, 'بلا اعتماد ⇒ 202 مسودة');
  assert.equal(noApprove.json?.needsApproval, true, 'العلم needsApproval مرفوع');

  // 2) الأثر القاطع: العنصر ما زال موجوداً فعلاً
  const still = await call({ server: SERVER, tool: 'memory_get_note', args: { id }, approved: true });
  const body = JSON.stringify(still.json || {});
  assert.ok(still.status === 200 && body.includes('هدف الحارس'), 'العنصر ما زال موجوداً بعد المحاولة بلا اعتماد');

  // 3) مع الاعتماد الصريح ⇒ يُنفَّذ فعلاً
  const approved = await call({ server: SERVER, tool: 'memory_delete_note', args: { id }, approved: true });
  assert.equal(approved.status, 200, 'باعتماد صريح ⇒ تنفيذ');

  // 4) وبعده اختفى فعلاً
  const gone = await call({ server: SERVER, tool: 'memory_get_note', args: { id }, approved: true });
  const gbody = JSON.stringify(gone.json || {});
  assert.ok(!gbody.includes('محتوى للاختبار'), 'العنصر حُذف فعلاً بعد الاعتماد');
});
