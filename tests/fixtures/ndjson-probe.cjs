'use strict';
// خادم MCP بنمط NDJSON (سطر JSON لكل رسالة) — للتحقق من الكشف التلقائي
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined || m.id === null) continue;
    const reply = (r) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...r }) + '\n');
    if (m.method === 'initialize') reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ndjson-fixture', version: '1' } } });
    else if (m.method === 'tools/list') reply({ result: { tools: [{ name: 'echo', description: 'أعد النص', inputSchema: { type: 'object' } }] } });
    else if (m.method === 'tools/call') reply({ result: { content: [{ type: 'text', text: 'echo:' + ((m.params.arguments || {}).text || '') }] } });
    else reply({ error: { code: -32601, message: 'method not found' } });
  }
});
process.stdin.on('close', () => process.exit(0));
