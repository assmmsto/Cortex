import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const policy = require('../cortex-policy');
const tools = require('../cortex-tools-external');

const ctx = { allowedRoots: [ROOT] };
const decide = o => policy.evaluate(o).decision;

// ─────────── الصلاحيات (دستور §35–§38) ───────────

test('القراءة مسموحة في كل الأوضاع', () => {
  for (const autonomy of ['supervised', 'autonomous']) {
    assert.equal(decide({
      tool: 'search_notes', level: 'read', scope: 'vault',
      allowedScopes: ['vault'], autonomy
    }), 'allow');
  }
});

test('أداة غير معرّفة مرفوضة دائماً', () => {
  assert.equal(decide({
    tool: 'definitely_not_a_tool', level: 'execute', scope: 'vault', allowedScopes: ['vault']
  }), 'refuse');
});

test('صلاحية ناقصة ترفض الأداة', () => {
  assert.equal(decide({
    tool: 'shell_exec', level: 'read', scope: 'sandbox',
    allowedScopes: ['sandbox'], autonomy: 'autonomous'
  }), 'refuse');
});

test('نطاق غير مصرّح يرفض الأداة', () => {
  assert.equal(decide({
    tool: 'repo_index', level: 'read', scope: 'repo',
    allowedScopes: ['vault'], autonomy: 'autonomous', path: '.'
  }), 'refuse');
});

test('الوضع الخاضع للإشراف يحوّل الكتابة إلى مسودة', () => {
  assert.equal(decide({
    tool: 'create_note', level: 'write', scope: 'vault',
    allowedScopes: ['vault'], autonomy: 'supervised'
  }), 'draft');
});

test('أدوات التنفيذ والكتابة الخارجية مسودة دائماً', () => {
  const cases = [
    { tool: 'shell_exec', path: undefined },
    { tool: 'run_tests', path: '.' },
    { tool: 'import_repo', path: '.' },
    { tool: 'fs_write', path: './x' },
    { tool: 'link_note', path: undefined }
  ];
  for (const { tool, path: p } of cases) {
    const spec = policy.TOOL_POLICY[tool];
    assert.equal(decide({
      tool, level: spec.level, scope: spec.scope,
      allowedScopes: [spec.scope], autonomy: 'autonomous', path: p
    }), 'draft', `${tool} يجب أن يكون مسودة`);
    // حتى مع نطاق موسّع: لا إعفاء من الاعتماد لأدوات الكتابة الخارجية والتنفيذ
    assert.equal(decide({
      tool, level: spec.level, scope: spec.scope,
      allowedScopes: [spec.scope, 'pre-approved'], autonomy: 'autonomous', path: p
    }), 'draft', `${tool} يجب أن يبقى مسودة حتى مع نطاق موسّع`);
  }
});

test('المسار إلزامي لأدوات المسارات', () => {
  assert.equal(decide({
    tool: 'fs_read', level: 'read', scope: 'filesystem',
    allowedScopes: ['filesystem'], autonomy: 'autonomous'
  }), 'refuse');
});

test('الميزانية اليومية توقف الكتابة عند الحد ولا توقف القراءة', () => {
  assert.equal(decide({
    tool: 'create_note', level: 'write', scope: 'vault', allowedScopes: ['vault'],
    autonomy: 'autonomous', dailyUsed: { vault: policy.DAILY_LIMITS.vault }
  }), 'refuse');
  assert.equal(decide({
    tool: 'create_note', level: 'write', scope: 'vault', allowedScopes: ['vault'],
    autonomy: 'autonomous', dailyUsed: { vault: 0 }
  }), 'allow');
  assert.equal(decide({
    tool: 'fs_read', level: 'read', scope: 'filesystem', allowedScopes: ['filesystem'],
    path: '.', dailyUsed: { fs: 99999 }
  }), 'allow');
});

// ─────────── قائمة الأوامر البيضاء ───────────

test('الأوامر المسموحة تمر', () => {
  for (const cmd of ['git status', 'ls', 'node --version', 'python -m pytest']) {
    assert.equal(policy.isAllowedCommand(cmd).ok, true, `${cmd} يجب أن يُسمح`);
  }
});

test('الأوامر الخطرة ومحارف الصدفة مرفوضة', () => {
  const denied = [
    'rm -rf /', 'curl http://evil', 'wget x', 'sudo ls', 'chmod 777 x',
    'ls; rm -rf /', 'ls && whoami', 'cat $(whoami)', 'echo x > f',
    'git status | rm', 'ls `id`'
  ];
  for (const cmd of denied) {
    assert.equal(policy.isAllowedCommand(cmd).ok, false, `${cmd} يجب أن يُرفض`);
  }
});

// ─────────── حدود المسار ───────────

test('حدود المسار تمنع الخروج والبايت الصفري', () => {
  assert.equal(tools.resolveSafePath(ROOT, [ROOT]).ok, true);
  assert.equal(tools.resolveSafePath('', [ROOT]).ok, false);
  assert.equal(tools.resolveSafePath('a\0b', [ROOT]).ok, false);
  const outside = process.platform === 'win32' ? 'C:/Windows/System32' : '/etc/passwd';
  assert.equal(tools.resolveSafePath(outside, [ROOT]).ok, false);
});

test('الهروب بـ .. مرفوض', () => {
  const escaping = path.join(ROOT, '..', '..', 'outside.txt');
  assert.equal(tools.resolveSafePath(escaping, [ROOT]).ok, false);
});

// ─────────── منع التكرار (دستور §36) ───────────

test('مفتاح منع التكرار ثابت للمدخلات نفسها ومتغير مع التشغيل', () => {
  const a = policy.idempotencyKey('run1', 'fs_read', { path: 'x', z: 1 });
  const b = policy.idempotencyKey('run1', 'fs_read', { z: 1, path: 'x' });
  const c = policy.idempotencyKey('run2', 'fs_read', { path: 'x', z: 1 });
  assert.equal(a, b, 'ترتيب المفاتيح لا يغيّر البصمة');
  assert.notEqual(a, c, 'تشغيل مختلف يعطي بصمة مختلفة');
});

// ─────────── أدوات حقيقية على القرص (دستور §23/3،8،9) ───────────

test('fs_read يقرأ ملفاً حقيقياً', async () => {
  const r = await tools.TOOL_IMPLS.fs_read({ path: path.join(ROOT, 'package.json') }, ctx);
  assert.ok(r.content, 'يجب أن يعيد محتوى');
  assert.ok(r.content.includes('"name"'), 'يجب أن يقرأ الحزمة فعلاً');
});

test('fs_list يسرد المجلد', async () => {
  const r = await tools.TOOL_IMPLS.fs_list({ path: ROOT }, ctx);
  assert.ok(Array.isArray(r.entries));
  assert.ok(r.entries.some(e => e.name === 'cortex-policy.js'));
});

test('repo_index يفهرس ويكتشف نقاط الدخول والامتدادات', async () => {
  const r = await tools.TOOL_IMPLS.repo_index({ path: ROOT }, ctx);
  assert.ok(r.files > 5, 'يجب أن يجد ملفات');
  assert.ok(r.entryPoints.length > 0, 'يجب أن يكتشف نقاط دخول');
  assert.ok(r.byExt['.js'] > 0, 'يجب أن يحصي الامتدادات');
});

test('repo_deps يحلّل الاستيرادات الفعلية', async () => {
  const r = await tools.TOOL_IMPLS.repo_deps({ path: ROOT }, ctx);
  assert.ok(r.filesScanned > 0);
  assert.ok(r.internalEdges > 0, 'يجب أن يجد استيرادات داخلية');
  assert.ok(r.external.length > 0, 'يجب أن يجد حزماً خارجية');
});

test('repo_impact يحدد أثر تغيير ملف (دستور §39/3)', async () => {
  const r = await tools.TOOL_IMPLS.repo_impact(
    { path: ROOT, file: 'cortex-tools-external.js' }, ctx);
  assert.ok(r.target);
  assert.ok(Array.isArray(r.affectedFiles));
});

test('shell_exec ينفّذ أمراً مسموحاً', async () => {
  const r = await tools.TOOL_IMPLS.shell_exec({ command: 'ls' }, ctx);
  assert.ok(r.ok || r.stdout, 'يجب أن ينفّذ');
});

test('shell_exec يمنع الأمر الخطر', async () => {
  const r = await tools.TOOL_IMPLS.shell_exec({ command: 'rm -rf /' }, ctx);
  assert.equal(r.blocked, true);
});

test('run_tests يكتشف ويشغّل اختبارات المشروع (دستور §23/9)', async () => {
  const r = await tools.TOOL_IMPLS.run_tests({ path: ROOT }, ctx);
  assert.ok(r.command, 'يجب أن يكتشف أمراً');
  assert.equal(typeof r.ok, 'boolean');
});

test('run_tests يرفض أمراً خارج القائمة البيضاء', async () => {
  const r = await tools.TOOL_IMPLS.run_tests({ path: ROOT, command: 'rm -rf /' }, ctx);
  assert.equal(r.blocked, true);
});

test('الأدوات تحترم حدود المسار', async () => {
  const outside = process.platform === 'win32' ? 'C:/Windows' : '/etc';
  for (const tool of ['fs_read', 'fs_list', 'repo_index', 'git_status']) {
    const r = await tools.TOOL_IMPLS[tool]({ path: outside }, ctx);
    assert.ok(r.error, `${tool} يجب أن يرفض مساراً خارجياً`);
  }
});

test('الملف غير الموجود يعيد خطأ بلا رمي', async () => {
  const missing = path.join(ROOT, 'does-not-exist-xyz.txt');
  const r = await tools.TOOL_IMPLS.fs_read({ path: missing }, ctx);
  assert.ok(r.error, 'يجب أن يعيد خطأ');
});

// ─────────── عقد الواجهة (يمنع تكرار عطل ctx-state) ───────────

test('عقد الواجهة: كل مرجع عنصر في JS موجود في HTML', () => {
  const htmlPath = path.join(PUBLIC, 'index.html');
  const jsPath = path.join(PUBLIC, 'app.js');
  if (!existsSync(htmlPath) || !existsSync(jsPath)) return;

  const html = readFileSync(htmlPath, 'utf8');
  const js = readFileSync(jsPath, 'utf8');

  const ids = new Set([...html.matchAll(/\bid\s*=\s*"([^"]+)"/g)].map(m => m[1]));
  const refs = new Set();
  // $('id') → المعرّف كما هو.  $$('#id'), $$('#id .sel') → المعرّف بعد #.
  // المحدِّدات الخالصة في $$ ([attr] و .class بلا #) ليست معرّفات عناصر فتُتجاهل.
  for (const m of js.matchAll(/(\$\$?)\('([^']+)'\)/g)) {
    const dd = m[1] === '$$';
    const sel = m[2].trim();
    const hash = sel.match(/^#([A-Za-z][\w-]*)/);
    if (hash) refs.add(hash[1]);
    else if (!dd) refs.add(sel);
  }
  for (const m of js.matchAll(/getElementById\('([^']+)'\)/g)) refs.add(m[1]);

  /* معرّفات تُبنى وقت التشغيل داخل innerHTML (لوحة العقد: ct-*) — لا وجود لها في
     الوسم الثابت بحكم التصميم؛ تُدرَج صراحةً حتى يبقى العقد صادقاً لا متسامحاً. */
  const DYNAMIC_IDS = new Set(['ct-msg', 'ct-save', 'ct-autonomy']);
  const missing = [...refs].filter(id => !ids.has(id) && !DYNAMIC_IDS.has(id)).sort();
  assert.deepEqual(missing, [], `مراجع مفقودة في index.html: ${missing.join(', ')}`);
});

test('عقد الواجهة: لا معرّفات مكررة في HTML', () => {
  const htmlPath = path.join(PUBLIC, 'index.html');
  if (!existsSync(htmlPath)) return;
  const html = readFileSync(htmlPath, 'utf8');

  const seen = new Set();
  const dupes = new Set();
  for (const m of html.matchAll(/\bid\s*=\s*"([^"]+)"/g)) {
    if (seen.has(m[1])) dupes.add(m[1]);
    seen.add(m[1]);
  }
  assert.deepEqual([...dupes].sort(), [], `معرّفات مكررة: ${[...dupes].join(', ')}`);
});

test('عقد الواجهة: كل data-i18n له ترجمة', () => {
  const htmlPath = path.join(PUBLIC, 'index.html');
  const jsPath = path.join(PUBLIC, 'app.js');
  if (!existsSync(htmlPath) || !existsSync(jsPath)) return;

  const html = readFileSync(htmlPath, 'utf8');
  const js = readFileSync(jsPath, 'utf8');

  const keys = new Set(
    [...html.matchAll(/data-i18n(?:-ph)?\s*=\s*"([^"]+)"/g)].map(m => m[1])
  );
  // المفاتيح تُكتب أحياناً مُقتبَسة (‎'key':) وأحياناً عارية (key:) — نقبل الاثنين،
  // وإلا سقط الاختبار على أسلوب صحيح تماماً (هشاشة في الاختبار لا في الكود).
  const missing = [...keys].filter(k => !new RegExp(`['"]?${k}['"]?\\s*:`).test(js)).sort();
  assert.deepEqual(missing, [], `مفاتيح ترجمة مفقودة: ${missing.join(', ')}`);
});
