import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function encode(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8'), payload]);
}
/* إصلاح 2026-11-12 (اختبار متذبذب مقيس: pass/fail/fail على نفس الكود):
   القارئ كان يخزّن **المُنتظِرين فقط**، فإن وصل إطار قبل تسجيل الانتظار يُسقَط
   ويُسلَّم الإطار التالي للمُنتظِر ⇒ إزاحة إطار واحد وقراءة ردّ خاطئ. الآن
   طابوران: إطارات واردة وانتظارات معلّقة، فأي ترتيب زمني يعمل. */
function createReader(child) {
  let buffer = Buffer.alloc(0);
  const incoming = [];
  const waiters = [];
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const idx = buffer.indexOf('\r\n\r\n');
      if (idx === -1) break;
      const header = buffer.slice(0, idx).toString('utf8');
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) break;
      const len = Number(match[1]);
      const start = idx + 4;
      const end = start + len;
      if (buffer.length < end) break;
      const payload = JSON.parse(buffer.slice(start, end).toString('utf8'));
      buffer = buffer.slice(end);
      if (waiters.length) waiters.shift()(payload);
      else incoming.push(payload);
    }
  });
  return () => new Promise((resolve, reject) => {
    if (incoming.length) return resolve(incoming.shift());
    const timer = setTimeout(() => reject(new Error('MCP reader timeout: no frame within 30000ms')), 30000);
    waiters.push(v => { clearTimeout(timer); resolve(v); });
  });
}

test('MCP server exposes brain tools and resolver flows', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-mcp-'));
  const child = spawn('node', ['mcp-memory-server.js', '--root', root], { cwd: projectDir });
  /* إصلاح 2026-11-12 (فشل حتمي في المجموعة، ونجاح منفرد): stderr كان أنبوباً
     لا يقرأه أحد. الخادم يطبع تحذيرات عند الإقلاع على جذر جديد، فتمتلئ سعة
     الأنبوب (64KB) ويتجمّد الطفل قبل أن يكتب أول إطار ⇒ «لا إطار خلال 30 ثانية».
     استنزاف stderr يفصل التشخيص عن التشغيل: نُبقي آخر السطور للرسالة عند الفشل. */
  const stderrTail = [];
  child.stderr.on('data', d => {
    stderrTail.push(d.toString());
    if (stderrTail.length > 40) stderrTail.shift();
  });
  t.after(() => {
    if (process.env.CORTEX_TEST_VERBOSE) console.error('[mcp stderr]', stderrTail.join(''));
  });
  t.after(() => child.kill());
  const next = createReader(child);

  child.stdin.write(encode({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  let msg = await next();
  assert.equal(msg.result.serverInfo.name, 'cortex-memory');
  assert.equal(msg.result.serverInfo.version, '5.0.0');

  child.stdin.write(encode({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  msg = await next();
  assert.ok(msg.result.tools.some(t => t.name === 'memory_resolve_reference'));
  assert.ok(msg.result.tools.some(t => t.name === 'memory_dashboard'));
  assert.ok(msg.result.tools.some(t => t.name === 'memory_list_projects'));

  child.stdin.write(encode({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_upsert_note', arguments: { title: 'Atlas Spec', project: 'Atlas', type: 'doc', content: '# Atlas Spec\n\nProject: Atlas\n\nSpec for the gateway.' } } }));
  msg = await next();
  assert.match(msg.result.content[0].text, /Saved.*Atlas Spec/);

  child.stdin.write(encode({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory_resolve_reference', arguments: { query: 'افتح المستند', activeProject: 'Atlas' } } }));
  msg = await next();
  assert.match(msg.result.content[0].text, /Atlas Spec/);

  child.stdin.write(encode({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_dashboard', arguments: {} } }));
  msg = await next();
  assert.match(msg.result.content[0].text, /workspace|recentDocuments|projects/);

  child.stdin.write(encode({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'memory_list_projects', arguments: {} } }));
  msg = await next();
  assert.match(msg.result.content[0].text, /Atlas/);
});
