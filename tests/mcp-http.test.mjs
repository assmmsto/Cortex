/**
 * الاتصال العام (2026-10-30، مُحصَّن 2026-11-11) — MCP عبر HTTP على عنوان واحد.
 *
 * الدعوى: أي نظام يدعم MCP عن بُعد يتصل بـ POST /mcp ويحصل على **نفس** الأدوات
 * الـ28 التي يقدّمها منفذ stdio — من النواة الواحدة (cortex-mcp-core.js) ومن قائمة
 * المصدر الواحد (cortex-mcp-tools.js).
 *
 * الحصانة (تدقيق 2026-11-11): كان /mcp يقبل الكتابة بلا أي هوية. صار يشترط رمزاً
 * مخصّصاً لـMCP في `Authorization: Bearer` (ملف data/mcp.token بصلاحية 0600)،
 * ويُعرض داخل الإعداد الذي تنسخه من نافذة MCP — فالربط يبقى بنقرة، والانكشاف يتوقف.
 *
 * يثبت هنا: الرفض بلا رمز (401) · القبول بالرمز · التهيئة · قائمة الأدوات (28)
 * ومطابقتها الحرفية لـ/api/mcp-info · نداء حقيقي · قبول الإشعارات (202) ·
 * رفض المنهج المجهول (-32601) · رفض GET (405) · مفتاح الإيقاف/التشغيل.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLiveServer } from './_live-server.mjs';

/** ترويسة المصادقة لـMCP، مصدرها الإعداد الذي تنسخه الواجهة نفسها. */
async function mcpAuth(srv) {
  const info = await fetch(srv.base + '/api/mcp-info', { headers: srv.headers() }).then((r) => r.json());
  assert.ok(info.http && info.http.headers && info.http.headers.Authorization,
    'إعداد HTTP يحمل ترويسة المصادقة: ' + JSON.stringify(info.http));
  return { auth: info.http.headers.Authorization, info };
}

async function rpc(base, message, auth) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = auth;
  const r = await fetch(base + '/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(message),
  });
  return { status: r.status, body: r.status === 202 ? null : await r.json().catch(() => null) };
}

test('الاتصال العام: MCP عبر HTTP على /mcp — بلا رمز 401، وقراءة فقط افتراضياً', async (t) => {
  const srv = await startLiveServer();
  t.after(async () => { await srv.stop(); });

  // الحصانة أولاً: بلا رمز ⇒ رفض صريح (لا كتابة بهوية مجهولة)
  const anon = await rpc(srv.base, { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} });
  assert.equal(anon.status, 401, 'بلا رمز: /mcp يرفض (401)');
  assert.equal(anon.body.error.code, -32001, 'رمز خطأ صريح للترويسة المفقودة');

  const { auth } = await mcpAuth(srv);

  const init = await rpc(srv.base, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, auth);
  assert.equal(init.status, 200, 'التهيئة تُرد بـ200');
  assert.equal(init.body.result.serverInfo.name, 'cortex-memory');
  assert.equal(init.body.result.serverInfo.version, '5.0.0');

  const info = await fetch(srv.base + '/api/mcp-info', { headers: srv.headers() }).then((r) => r.json());
  const list = await rpc(srv.base, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, auth);
  const names = list.body.result.tools.map((x) => x.name);
  /* العقد الجديد (2026-11-15): الوافد يقرأ ولا يكتب حتى يُفعَّل — فتكون قائمة
     HTTP مجموعة فرعية من المصدر الواحد، لا نسخة ثانية ولا قائمة أقصر مخفية. */
  assert.equal(info.readOnly, true, 'الوضع الافتراضي: قراءة فقط');
  assert.ok(names.length > 0, 'أدوات متاحة في وضع القراءة');
  assert.ok(names.length < info.tools.length, 'أدوات الكتابة مخفية في وضع القراءة');
  assert.ok(names.every((n) => info.tools.includes(n)), 'كل أداة معروضة موجودة في المصدر الواحد');
  assert.ok(!names.includes('memory_delete_note'), 'أداة الحذف غير معروضة');

  const rw = await fetch(srv.base + '/api/mcp/settings', { method: 'POST', headers: srv.headers(), body: JSON.stringify({ readOnly: false }) }).then((r) => r.json());
  assert.equal(rw.readOnly, false, 'فُعّلت الكتابة');
  const full = await rpc(srv.base, { jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} }, auth);
  const fullNames = full.body.result.tools.map((x) => x.name);
  assert.deepEqual(fullNames, info.tools, 'بعد التفعيل: نفس القائمة حرفياً من المصدر الواحد');

  const call = await rpc(srv.base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_stats', arguments: {} } }, auth);
  assert.match(String(call.body.result.content[0].text), /Notes/, 'نداء حقيقي عبر HTTP يُعيد إحصاءات فعلية');

  const note = await rpc(srv.base, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
  assert.equal(note.status, 202, 'الإشعار يُقبل بلا رد (202)');

  const bad = await rpc(srv.base, { jsonrpc: '2.0', id: 4, method: 'no/such/method' }, auth);
  assert.equal(bad.body.error.code, -32601, 'منهج مجهول يُرفض بالرمز القياسي');

  const info2 = await fetch(srv.base + '/api/mcp-info', { headers: srv.headers() }).then((r) => r.json());
  assert.ok(info2.mcpHttp && info2.mcpHttp.lastAt,
    'آخر اتصال وارد مُسجَّل وظاهر في الواجهة: ' + JSON.stringify(info2.mcpHttp));

  const getRes = await fetch(srv.base + '/mcp');
  assert.equal(getRes.status, 405, 'GET مرفوض — النمط POST/JSON فقط');

  // رمز جلسة الواجهة يُقبل أيضاً على /mcp (نفس القدرة، بلا حاجة لرمز MCP)
  const viaSession = await rpc(srv.base, { jsonrpc: '2.0', id: 5, method: 'ping' }, srv.headers()['x-cortex-session']);
  assert.equal(viaSession.status, 401, 'الترويسة الخام بلا Bearer لا تُقبل كرمز MCP');

  /* مفتاح الاستقبال (2026-10-30): إيقاف ⇒ 403 للوافدين، تشغيل ⇒ يعود — «فك الاتصال العام» */
  const H2 = srv.headers();
  const off = await fetch(srv.base + '/api/mcp/incoming', { method: 'POST', headers: H2, body: JSON.stringify({ enabled: false }) }).then((r) => r.json());
  assert.equal(off.enabled, false, 'الإيقاف نجح');
  const blocked = await rpc(srv.base, { jsonrpc: '2.0', id: 7, method: 'ping' }, auth);
  assert.equal(blocked.status, 403, 'بعد الإيقاف: /mcp يرفض الوافدين (403)');
  const backOn = await fetch(srv.base + '/api/mcp/incoming', { method: 'POST', headers: H2, body: JSON.stringify({ enabled: true }) }).then((r) => r.json());
  assert.equal(backOn.enabled, true, 'التشغيل نجح');
  const back = await rpc(srv.base, { jsonrpc: '2.0', id: 8, method: 'ping' }, auth);
  assert.equal(back.status, 200, 'بعد التشغيل: يعود يستقبل');
  const info3 = await fetch(srv.base + '/api/mcp-info', { headers: srv.headers() }).then((r) => r.json());
  assert.equal(info3.mcpHttp.enabled, true, 'الحالة المرئية تعكس المفتاح');
});