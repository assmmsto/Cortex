'use strict';
/**
 * خادم MCP وهمي للاختبار — يتكلم بروتوكول Content-Length الرسمي (مواصفة MCP).
 * يرد على initialize و tools/list و tools/call و ping و resources/list.
 */
const TOOLS = [
  { name: 'echo', description: 'أعد النص كما هو', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
  { name: 'add', description: 'اجمع رقمين', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }
];

function send(message) {
  const body = JSON.stringify(message);
  const bytes = Buffer.byteLength(body, 'utf8');
  process.stdout.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
}

function handle(msg) {
  // الإشعارات بلا id — لا رد
  if (msg.id === undefined || msg.id === null) return;

  const reply = payload => send({ jsonrpc: '2.0', id: msg.id, ...payload });

  switch (msg.method) {
    case 'initialize':
      reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fake-mcp', version: '1.0.0' } } });
      break;
    case 'tools/list':
      reply({ result: { tools: TOOLS } });
      break;
    case 'tools/call': {
      const name = msg.params && msg.params.name;
      const args = (msg.params && msg.params.arguments) || {};
      if (name === 'echo') {
        reply({ result: { content: [{ type: 'text', text: `echo: ${args.text}` }] } });
      } else if (name === 'add') {
        reply({ result: { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] } });
      } else {
        reply({ error: { code: -32601, message: `unknown tool: ${name}` } });
      }
      break;
    }
    case 'ping':
      reply({ result: {} });
      break;
    case 'resources/list':
      reply({ result: { resources: [] } });
      break;
    default:
      reply({ error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

// قارئ Content-Length على stdin
let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf('\r\n\r\n');
    if (sep === -1) break;
    const m = buffer.slice(0, sep).toString('utf8').match(/Content-Length:\s*(\d+)/i);
    if (!m) { buffer = Buffer.alloc(0); break; }
    const len = Number(m[1]);
    const start = sep + 4;
    if (buffer.length < start + len) break;
    const payload = buffer.slice(start, start + len).toString('utf8');
    buffer = buffer.slice(start + len);
    try { handle(JSON.parse(payload)); } catch { /* حمولة تالفة تُتجاوز */ }
  }
});

process.stdin.on('close', () => process.exit(0));
