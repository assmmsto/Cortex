/**
 * ذاكرة المشاريع لوكلاء البناء (2026-10-28) — إثبات end-to-end على خادم معزول:
 *   ١) الاحتضان: مسح فعلي للمصدر → خريطة مرجعية + اعتمادية + ملاحظة «خريطة مشروع» في القبو.
 *   ٢) قاطع السياق: الجزء اللازم فقط (يعتمد على/يعتمد عليه + مسار كامل + تلخيص دقيق) —
 *      الهدف: وكيل البناء لا يقرأ المشروع كله.
 *   ٣) الاحتضان التلقائي: أول طلب لمشروع بلا خريطة يحتضنه بنفسه (الاحتضان عند الربط).
 *   ٤) المسير: تسجيل خطوات وكيل البناء وقراءتها (الأحدث أولاً).
 *   ٥) المسير التلقائي: تشغيل وكيل كورتكس على مشروع يُسجَّل في مسير المشروع بلا طلب.
 *   ٦) عبر MCP: الأدوات الأربع ظاهرة وتعمل فعلياً (التبادل بين النظامين).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startLiveServer } from './_live-server.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function seedDemo(root) {
  const dir = path.join(root, 'demo-proj');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, 'test'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'demo-proj', version: '1.0.0', description: 'مشروع تجريبي للاحتضان' }, null, 2));
  writeFileSync(path.join(dir, 'src', 'index.js'), "const { pretty } = require('./util');\nconsole.log(pretty(3));\n");
  writeFileSync(path.join(dir, 'src', 'calc.js'), "function add(a, b) { return a + b; }\nfunction mul(a, b) { return a * b; }\nmodule.exports = { add, mul };\n");
  writeFileSync(path.join(dir, 'src', 'format.js'), "const { add } = require('./calc');\nfunction fmt(n) { return String(n); }\nmodule.exports = { fmt, sum: add };\n");
  writeFileSync(path.join(dir, 'src', 'util.js'), "const { fmt } = require('./format');\nmodule.exports = { pretty: (n) => '=' + fmt(n) };\n");
  writeFileSync(path.join(dir, 'test', 'calc.test.js'), "const { add } = require('../src/calc');\nif (add(1, 2) !== 3) throw new Error('جمع خاطئ');\n");
  writeFileSync(path.join(dir, 'README.md'), '# demo-proj\n\nمشروع اختبار الاحتضان في كورتكس.\n');
  return dir;
}
function seedFresh(root) {
  const dir = path.join(root, 'fresh-proj');
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fresh-proj', version: '0.1.0' }, null, 2));
  writeFileSync(path.join(dir, 'main.js'), "const { help } = require('./lib/helper');\nconsole.log(help());\n");
  writeFileSync(path.join(dir, 'lib', 'helper.js'), "module.exports = { help: () => 'ok' };\n");
  return dir;
}

/* ناقل MCP stdio — نفس بروتوكول mcp-memory-server (طول + JSON) */
function encode(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, 'utf8'), payload]);
}
function createReader(child) {
  let buffer = Buffer.alloc(0);
  const pending = [];
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
      const next = pending.shift();
      if (next) next(payload);
    }
  });
  return () => new Promise(resolve => pending.push(resolve));
}

test('ذاكرة المشاريع: احتضان + قاطع سياق + احتضان تلقائي + مسير (HTTP + MCP)', async t => {
  const srv = await startLiveServer();
  t.after(async () => {
    await srv.stop();
    try { rmSync(srv.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ }
  });
  const H = srv.headers();
  const demoDir = seedDemo(srv.root);
  const freshDir = seedFresh(srv.root);

  /* ── ١) الاحتضان: خريطة من مسح فعلي + ملاحظة قبو ── */
  const abs = await fetch(srv.base + '/api/project/absorb', {
    method: 'POST', headers: H, body: JSON.stringify({ path: demoDir, project: 'Demo' })
  }).then(r => r.json());
  assert.ok(abs.ok && !abs.error, 'الاحتضان نجح: ' + JSON.stringify(abs.error || ''));
  assert.ok(abs.files >= 7, `عدد الملفات الممسوحة (${abs.files})`);
  assert.ok(abs.edges >= 4, `حواف الاستيراد الفعلية (${abs.edges})`);
  assert.ok(abs.entryPoints.includes('src/index.js'), 'نقطة الدخول مُكتشفة: ' + abs.entryPoints.join(','));
  const top = abs.topFiles.map(f => f.path);
  assert.ok(top.includes('src/calc.js') && top.includes('src/format.js'), 'الخريطة المرجعية تحمل الملفات الأكثر اعتماداً: ' + top.join(','));
  const noteId = abs.noteId;
  const notes = await fetch(srv.base + '/api/notes').then(r => r.json());
  const mapNote = (notes.notes || []).find(n => n.id === noteId);
  assert.ok(mapNote, 'ملاحظة الخريطة في القبو: ' + noteId);
  assert.match(mapNote.title, /خريطة مشروع/, 'عنوان الملاحظة يحمل الهوية: ' + mapNote.title);
  // م39/5+6+8: سجل تحذيرات دائم + دور مصنّف لكل ملف + فرق التحليلين عند إعادة الاحتضان
  assert.ok(Array.isArray(abs.warnings), 'سجل تحذيرات الخريطة محفوظ في الرد');
  assert.ok(abs.topFiles[0] && abs.topFiles[0].type, 'لكل ملف في الخريطة المرجعية دور مصنّف: ' + JSON.stringify(abs.topFiles[0]));
  const abs2 = await fetch(srv.base + '/api/project/absorb', {
    method: 'POST', headers: H, body: JSON.stringify({ path: demoDir, project: 'Demo' })
  }).then(r => r.json());
  assert.ok(abs2.ok && abs2.refreshed, 'إعادة الاحتضان موسومة refreshed');
  assert.ok(abs2.changes && typeof abs2.changes.filesAfter === 'number' && Array.isArray(abs2.changes.added),
    'فرق «ما تغيّر منذ آخر تحليل» محسوب: ' + JSON.stringify(abs2.changes));

  /* ── ٢) قاطع السياق: ملف داخل الحواف ── */
  const sl = await fetch(srv.base + '/api/memory/slice', {
    method: 'POST', headers: H,
    body: JSON.stringify({ project: 'Demo', file: 'src/calc.js', query: 'أريد إضافة عملية قسمة' })
  }).then(r => r.json());
  assert.ok(sl.ok && !sl.error, 'القاطع رد: ' + JSON.stringify(sl.error || ''));
  assert.equal(sl.targets[0].path, 'src/calc.js', 'الهدف محدد بدقة');
  assert.ok(sl.targets[0].fullPath.endsWith('demo-proj/src/calc.js'), 'المسار الكامل مرفق: ' + sl.targets[0].fullPath);
  assert.ok(sl.dependedBy.includes('src/format.js'), 'يعتمد عليه: format.js — ' + sl.dependedBy.join(','));
  assert.ok(sl.dependedBy.includes('test/calc.test.js'), 'يعتمد عليه: calc.test.js — ' + sl.dependedBy.join(','));
  assert.match(sl.summary, /src\/calc\.js/, 'التلخيص يذكر الملف');
  assert.match(sl.summary, /يعتمد عليه/, 'التلخيص يذكر الأثر');
  assert.ok(sl.summary.length <= 1200, 'التلخيص دقيق الطول: ' + sl.summary.length);
  // ملف جذر تبعية: لا يستورد لكن يُستورد — القاطع يشرح الدور بلا خرافات
  const sl2 = await fetch(srv.base + '/api/memory/slice', {
    method: 'POST', headers: H, body: JSON.stringify({ project: 'Demo', file: 'src/util.js' })
  }).then(r => r.json());
  assert.ok(sl2.dependsOn.includes('src/format.js'), 'util.js يعتمد على format.js — ' + sl2.dependsOn.join(','));

  /* ── ٣) الاحتضان التلقائي: مشروع لم يُحتضن بعد ── */
  const auto = await fetch(srv.base + '/api/memory/slice', {
    method: 'POST', headers: H,
    body: JSON.stringify({ project: 'Fresh', path: freshDir, file: 'lib/helper.js' })
  }).then(r => r.json());
  assert.ok(auto.ok && !auto.error, 'القاطع رد بعد الاحتضان التلقائي: ' + JSON.stringify(auto.error || ''));
  assert.equal(auto.autoAbsorbed, true, 'احتضان تلقائي عند أول طلب');
  assert.equal(auto.targets[0].path, 'lib/helper.js');
  assert.ok(auto.dependedBy.includes('main.js'), 'من يعتمد على helper: ' + auto.dependedBy.join(','));

  /* ── ٤) المسير: تسجيل خطوات وكيل البناء ── */
  const rec1 = await fetch(srv.base + '/api/memory/record', {
    method: 'POST', headers: H,
    body: JSON.stringify({ project: 'Demo', source: 'opencode', entries: [{ kind: 'fix', text: 'أصلحت جمع calc وأضفت اختباراً', files: ['src/calc.js', 'test/calc.test.js'], status: 'ok' }] })
  }).then(r => r.json());
  assert.ok(rec1.ok && rec1.added === 1, 'خطوة مسجلة');
  await fetch(srv.base + '/api/memory/record', {
    method: 'POST', headers: H,
    body: JSON.stringify({ project: 'Demo', source: 'claude', entries: [{ kind: 'add', text: 'أضفت دالة قسمة', files: ['src/calc.js'] }] })
  }).then(r => r.json());
  const trail = await fetch(srv.base + '/api/project/trail?project=Demo').then(r => r.json());
  assert.equal(trail.entries.length, 2, 'المسير يحمل الخطوتين');
  assert.equal(trail.entries[0].text, 'أضفت دالة قسمة', 'الأحدث أولاً');
  assert.equal(trail.entries[0].source, 'claude', 'مصدر الخطوة محفوظ');
  assert.equal(trail.entries[1].source, 'opencode', 'مصدر الخطوة السابقة محفوظ');

  /* ── ٥) المسير التلقائي: تشغيل وكيل كورتكس على مشروع ── */
  const runRes = await fetch(srv.base + '/api/agent/run', {
    method: 'POST', headers: H, body: JSON.stringify({ goal: 'ما وضع مشروع Demo؟', project: 'Demo' })
  });
  const runText = await runRes.text();
  assert.match(runText, /agent_done/, 'التشغيل انتهى بنهاية موثقة');
  const trail2 = await fetch(srv.base + '/api/project/trail?project=Demo').then(r => r.json());
  const autoEntry = trail2.entries.find(e => e.source === 'cortex-agent');
  assert.ok(autoEntry, 'التشغيل سُجِّل في مسير المشروع تلقائياً — المصادر: ' + trail2.entries.map(e => e.source).join(','));

  /* ── ٦) عبر MCP: التبادل بين النظامين ── */
  const child = spawn('node', ['mcp-memory-server.js', '--root', srv.root], { cwd: PROJECT_DIR });
  t.after(() => child.kill());
  const next = createReader(child);
  child.stdin.write(encode({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
  await next();
  child.stdin.write(encode({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
  let msg = await next();
  const names = msg.result.tools.map(x => x.name);
  for (const want of ['project_absorb', 'memory_slice', 'memory_record', 'project_trail']) {
    assert.ok(names.includes(want), `أداة MCP ظاهرة: ${want} — المتاح: ${names.join(',')}`);
  }
  // قاطع السياق عبر MCP على مشروع محتضَن مسبقاً (نفس الجذر = نفس الذاكرة)
  child.stdin.write(encode({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_slice', arguments: { project: 'Demo', file: 'src/format.js', query: 'تصحيح التنسيق' } } }));
  msg = await next();
  assert.match(msg.result.content[0].text, /src\/format\.js/, 'القاطع عبر MCP يرد بالمسار');
  assert.match(msg.result.content[0].text, /src\/calc\.js/, 'القاطع عبر MCP يرد بالاعتمادية');
  // المسير عبر MCP يقرأ ما سجّلته الجلسة
  child.stdin.write(encode({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'project_trail', arguments: { project: 'Demo', limit: 10 } } }));
  msg = await next();
  assert.match(msg.result.content[0].text, /أضفت دالة قسمة/, 'المسير مقروء عبر MCP');
  // تسجيل خطوة عبر MCP ثم قراءتها
  child.stdin.write(encode({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory_record', arguments: { project: 'Demo', source: 'codex', entries: [{ kind: 'test', text: 'شغلت الاختبارات كلها خضراء' }] } } }));
  msg = await next();
  assert.match(msg.result.content[0].text, /Recorded 1/, 'تسجيل عبر MCP نجح');
  const trail3 = await fetch(srv.base + '/api/project/trail?project=Demo').then(r => r.json());
  assert.equal(trail3.entries[0].source, 'codex', 'الخطوة المسجلة عبر MCP ظهرت في الخادم (ذاكرة واحدة)');
});
