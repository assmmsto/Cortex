/**
 * سطح MCP — مصدر واحد + التدفق الحقيقي لنافذة MCP (2026-10-30).
 *
 * العطل الذي يمنع رجوعه: القائمة كانت في مكانين — نسخة في server.js توقفت عند
 * 24 بينما الخادم يقدّم 28، فناقضت النافذة نفسها («28 أداة» فوق، «24 أداة MCP»
 * تحت). الآن المالك واحد: cortex-mcp-tools.js.
 *
 * هذا الملف يثبت ثلاث دعاوى النافذة الفعلية:
 *   ١) تطابق حرفي: /api/mcp-info = أسماء أدوات الخادم الحقيقية عبر stdio.
 *   ٢) «اختبر الاتصال الآن»: نفس طلب النافذة (approved:true) يُنفَّذ فعلياً،
 *      وبلا اعتماد يُسجَّل مسودة (202) — البوابة الحقيقية.
 *   ٣) «أضف واختبر»: تسجيل خادم + اكتشاف أدواته فعلياً عبر tools/list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveServer } from './_live-server.mjs';
import clientMod from '../cortex-mcp-client.js';

const { McpClient } = clientMod;
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_TOOLS = ['project_absorb', 'memory_slice', 'memory_record', 'project_trail'];

test('سطح MCP: mcp-info = الخادم الفعلي (28) + النداء الحقيقي + الاكتشاف الحقيقي', async t => {
  const srv = await startLiveServer();
  t.after(async () => { await srv.stop(); });

  /* ── ١) تطابق المصدر الواحد: النافذة تعرض ما يقدّمه الخادم حرفياً ── */
  /* /api/mcp-info تعرض رمز MCP، فصارت محمية بالجلسة (تدقيق 2026-11-11). */
  const info = await fetch(srv.base + '/api/mcp-info', { headers: srv.headers() }).then(r => r.json());
  assert.ok(Array.isArray(info.tools), 'mcp-info يعيد مصفوفة أدوات');
  const probe = new McpClient({
    name: 'cortex-memory',
    command: process.execPath,
    args: [path.join(PROJECT_DIR, 'mcp-memory-server.js'), '--root', srv.root],
    cwd: PROJECT_DIR,
    timeoutMs: 30000,
  });
  let real;
  try {
    await probe.start();
    const init = await probe.initialize();
    assert.equal(init.ok, true, 'تهيئة الخادم الفعلي عبر stdio: ' + (init.error || ''));
    real = (await probe.listTools()).map(x => x.name);
  } finally {
    await probe.stop();
  }
  assert.equal(real.length, 28, 'الخادم الفعلي يقدّم 28 أداة — وُجد ' + real.length);
  assert.deepEqual(info.tools, real, 'قائمة /api/mcp-info مطابقة حرفياً لأدوات الخادم (لا نسخة ثانية)');
  for (const w of NEW_TOOLS) {
    assert.ok(real.includes(w), 'أداة ذاكرة المشاريع ظاهرة في الخادم: ' + w);
    assert.ok(info.tools.includes(w), 'وظاهرة أيضاً في نافذة MCP: ' + w);
  }

  /* ── ٢) «اختبر الاتصال الآن»: نفس طلب النافذة حرفياً ── */
  const H = srv.headers();
  const call = await fetch(srv.base + '/api/mcp/call', {
    method: 'POST', headers: H,
    body: JSON.stringify({ server: 'cortex-memory', tool: 'memory_stats', args: {}, approved: true }),
  }).then(r => r.json());
  assert.equal(call.ok, true, 'النداء المُعتمد نجح: ' + (call.error || ''));
  assert.match(String(call.clean || ''), /Notes/, 'نتيجة حقيقية من memory_stats: ' + String(call.clean || '').slice(0, 90).replace(/\n/g, ' / '));

  /* حارس البوابة: بلا اعتماد = مسودة لا تنفيذ — لا استدعاء بلا حكم */
  const draftRes = await fetch(srv.base + '/api/mcp/call', {
    method: 'POST', headers: H,
    body: JSON.stringify({ server: 'cortex-memory', tool: 'memory_stats', args: {} }),
  });
  assert.equal(draftRes.status, 202, 'بلا اعتماد يُسجَّل مسودة (202)');
  const draft = await draftRes.json();
  assert.equal(draft.needsApproval, true, 'العقد يعلن الحاجة للاعتماد');

  /* ── ٣) «أضف واختبر»: تسجيل خادم ثم اكتشاف أدواته فعلياً ── */
  const add = await fetch(srv.base + '/api/mcp/servers', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      name: 'probe-mem', command: process.execPath,
      args: [path.join(PROJECT_DIR, 'mcp-memory-server.js'), '--root', srv.root],
    }),
  }).then(r => r.json());
  assert.equal(add.ok, true, 'تسجيل الخادم الخارجي: ' + JSON.stringify(add.error || ''));
  const disc = await fetch(srv.base + '/api/connectors/discover', {
    method: 'POST', headers: H,
    body: JSON.stringify({ target: 'probe-mem', server: 'probe-mem' }),
  }).then(r => r.json());
  assert.equal(disc.reached, true, 'المسبار وصل فعلاً: ' + (disc.reason || ''));
  assert.equal((disc.toolsFound || []).length, 28,
    'اكتشف أدوات الخادم فعلياً: ' + (disc.toolsFound || []).length + ' أداة');

  /* ── ٤) حالة الربط + إلغاؤه (2026-10-30): كان الإنشاء بلا حالة وبلا حذف ── */
  const withTest = await fetch(srv.base + '/api/mcp/servers').then(r => r.json());
  const probeRow = withTest.servers.find(s => s.name === 'probe-mem');
  assert.ok(probeRow && probeRow.lastTest && probeRow.lastTest.reached === true,
    'حالة الفحص ظاهرة لكل خادم (وصل ✓): ' + JSON.stringify(probeRow && probeRow.lastTest));
  const del = await fetch(srv.base + '/api/mcp/servers/probe-mem', { method: 'DELETE', headers: H }).then(r => r.json());
  assert.equal(del.ok, true, 'إلغاء الربط يعمل: ' + JSON.stringify(del.error || ''));
  const after = await fetch(srv.base + '/api/mcp/servers').then(r => r.json());
  assert.ok(!after.servers.some(s => s.name === 'probe-mem'), 'الخادم أُزيل من السجل فعلاً');
  const keep = await fetch(srv.base + '/api/mcp/servers/cortex-memory', { method: 'DELETE', headers: H });
  assert.equal(keep.status, 403, 'خادم كورتكس المدمج محمي من الحذف');
});
