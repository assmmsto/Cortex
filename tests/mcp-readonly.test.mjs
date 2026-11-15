import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionToken } from './_session.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function waitFor(url, ms = 60000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < ms) {
      try { const r = await fetch(url); if (r.ok) return; } catch { /* لم يقلع بعد */ }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`Timeout waiting for ${url}`);
  })();
}

test('MCP-RO: الربط بسطر واحد، وقراءة فقط افتراضياً، والكتابة تُرفض حتى تُفعَّل', async (t) => {
  /* العطل الذي يمنعه (2026-11-15): أي وكيل خارجي كان يستطيع استدعاء
     memory_delete_note بلا إذن — والعنوان والرمز يُخمَّنان يدوياً. */
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-mcpro-'));
  const port = 3987 + (process.pid % 200);
  const child = spawn('node', ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, APP_ROOT: root, APP_PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/ping`);
  const token = await sessionToken({ base });
  const h = { 'Content-Type': 'application/json', ...(token ? { 'X-Cortex-Session': token } : {}) };

  const cfg = await (await fetch(`${base}/api/mcp/config`, { headers: h })).json();
  assert.equal(cfg.ok, true);
  assert.equal(cfg.readOnly, true, 'قراءة فقط افتراضياً');
  assert.ok(cfg.url.endsWith('/mcp'), `عنوان MCP: ${cfg.url}`);
  assert.ok(String(cfg.claude).includes(cfg.url), 'سطر Claude يحتوي العنوان');
  assert.ok(cfg.json && cfg.json.mcpServers && cfg.json.mcpServers.cortex, 'JSON جاهز للنسخ');

  const call = async (body, bearer) => (await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })).json();

  const roList = await call({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, cfg.token);
  const roTools = (roList.result && roList.result.tools) || [];
  assert.ok(roTools.length > 0, 'أدوات تُعلن في وضع القراءة');
  assert.ok(!roTools.some((x) => x.name === 'memory_delete_note'), 'أداة الحذف مخفية');
  assert.ok(roTools.some((x) => x.name === 'memory_search'), 'أداة البحث حاضرة');

  const denied = await call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory_delete_note', arguments: { id: 'x' } } }, cfg.token);
  assert.ok(denied.error, 'الكتابة مرفوضة في وضع القراءة');
  assert.match(String(denied.error.message), /قراءة فقط|read-only/i, 'سبب الرفض واضح');

  const off = await (await fetch(`${base}/api/mcp/settings`, { method: 'POST', headers: h, body: JSON.stringify({ readOnly: false }) })).json();
  assert.equal(off.readOnly, false, 'أُوقف وضع القراءة');

  const rwList = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, cfg.token);
  const rwTools = (rwList.result && rwList.result.tools) || [];
  assert.ok(rwTools.some((x) => x.name === 'memory_delete_note'), 'أداة الحذف ظهرت بعد التفعيل');
  assert.ok(rwTools.length > roTools.length, 'عدد الأدوات زاد');
});
