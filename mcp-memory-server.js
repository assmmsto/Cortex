'use strict';
/* غلاف stdio لخادم ذاكرة كورتكس — نقل فقط (2026-10-30).
   المنطق كله في cortex-mcp-core.js (نفس المعالجات يخدمها server.js على /mcp)،
   وهنا: تحليل الوسائط + تأطير Content-Length + الطابور المتسلسل. */
const path = require('path');
const { createCore } = require('./cortex-core');
const extTools = require('./cortex-tools-external');
const { createProjectMemory } = require('./cortex-project-memory');
const { createMcpCore } = require('./cortex-mcp-core');

const arg = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
};

const ROOT = path.resolve(arg('--root', process.cwd()));
const core = createCore({ root: ROOT, projectRoot: __dirname });
// ذاكرة المشاريع (2026-10-28): نفس الوحدة المستخدمة في الخادم — سياق واحد للأدوات
const projectMemory = createProjectMemory({
  core, extTools,
  allowedRoots: extTools.buildAllowedRoots(ROOT),
  root: ROOT
});
const mcp = createMcpCore({ core, projectMemory });

function send(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

/* الطابور المتسلسل (عطل مُقاس 2026-10-22): معالج 'data' غير التزامني مع await handle()
   كان يبدأ نداء handle() جديداً قبل انتهاء السابق — متغير buffer مشترك بين نداءات
   متداخلة وردود خارج الترتيب. الآن: كل إطار يُقتطع تزامنياً من buffer ثم يُعالَج
   عبر سلسلة واحدة (chain) — لا تداخل ولا إعادة ترتيب مهما تلاحت القطع. */
let buffer = Buffer.alloc(0);
let chain = Promise.resolve();
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  chain = chain.then(async () => {
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const headerText = buffer.slice(0, headerEnd).toString('utf8');
      const match = headerText.match(/Content-Length: (\d+)/i);
      if (!match) { buffer = Buffer.alloc(0); break; }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) break;
      const payload = buffer.slice(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.slice(bodyStart + length);
      try {
        const response = await mcp.handle(JSON.parse(payload));
        if (response) send(response);
      } catch (e) { process.stderr.write(`parse error: ${e.message}\n`); }
    }
  }).catch(e => process.stderr.write(`handler error: ${e.message}\n`));
});

core.ensureBaseFiles();
