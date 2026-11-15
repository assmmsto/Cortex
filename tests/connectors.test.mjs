import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const schema = require('../cortex-schema');
const conn = require('../cortex-connectors');

// قاعدة مُهاجَرة كاملة: mcp_calls + audit_log + محفّزات الحماية
function makeDb() {
  const db = new DatabaseSync(':memory:');
  schema.migrate(db);
  return db;
}

function countAudit(db, type) {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM audit_log WHERE type = ?')
    .get(type);
  return Number(row.n);
}

function lastAudit(db, type) {
  return db
    .prepare('SELECT * FROM audit_log WHERE type = ? ORDER BY id DESC LIMIT 1')
    .get(type);
}

// ── مسابر محقونة (لا شبكة حقيقية — المسبار يُحقن كما يفرض التصميم) ──
const probeUnreachable = () => ({
  reached: false,
  tools: [],
  resources: [],
  error: 'ECONNREFUSED',
});

const probeEmpty = () => ({ reached: true, tools: [], resources: [] });

const probeReadOnly = () => ({
  reached: true,
  tools: ['read_file', 'grep'],
  resources: ['file:///project/README.md'],
});

const probeFull = () => ({
  reached: true,
  tools: ['read_file', 'grep', 'write_file', 'run_tests', 'exec_command'],
  resources: [],
});

// ═══════════════ ١) discover: لا استنتاج من اسم التطبيق ═══════════════

test('discover: مسبار لا يصل ⇒ قدرات فارغة مع سبب واضح (لا استنتاج من الاسم)', () => {
  // الهدف اسم معروف ومع ذلك لا قدرة واحدة تُنسب إليه
  const r = conn.discover(probeUnreachable, 'opencode');

  assert.equal(r.target, 'opencode');
  assert.equal(r.reached, false);
  assert.deepEqual(r.capabilities, [], 'لا قدرات بلا وصول فعلي');
  assert.deepEqual(r.capabilityDetails, []);
  assert.deepEqual(r.evidence, {});
  assert.ok(r.reason, 'يجب أن يكون هناك سبب صريح');
  assert.match(r.reason, /لم يصل/);
  assert.match(r.reason, /§31\/1/);
  assert.equal(r.transport, 'stdio');

  // نفس المنع مع Claude Code: الاسم لا يمنح قدرة قراءة ولا كتابة
  const c = conn.discover(probeUnreachable, 'claude-code');
  assert.deepEqual(c.capabilities, []);
  assert.match(c.reason, /لم يصل/);

  // ولا حتى مع هدف مجهول تماماً
  const u = conn.discover(probeUnreachable, 'something-else');
  assert.equal(u.target, 'something-else');
  assert.deepEqual(u.capabilities, []);
});

test('discover: مسبار غير صالح أو نتيجة غير صالحة لا تُنتج قدرات', () => {
  const notAFunction = conn.discover(null, 'generic-mcp');
  assert.equal(notAFunction.reached, false);
  assert.deepEqual(notAFunction.capabilities, []);
  assert.match(notAFunction.reason, /مسبار غير صالح/);

  const badResult = conn.discover(() => undefined, 'generic-mcp');
  assert.deepEqual(badResult.capabilities, []);
  assert.match(badResult.reason, /نتيجة صالحة/);

  const throwing = conn.discover(() => { throw new Error('انفجار'); }, 'generic-mcp');
  assert.equal(throwing.reached, false);
  assert.match(throwing.reason, /فشل المسبار/);
  assert.match(throwing.reason, /انفجار/);
});

test('discover: وصل المسبار بلا أدوات ⇒ قدرات فارغة وسبب "لا أدوات"', () => {
  const r = conn.discover(probeEmpty, 'generic-mcp');
  assert.equal(r.reached, true);
  assert.deepEqual(r.capabilities, []);
  assert.match(r.reason, /أي أداة/);
});

// ═══════════════ ٢) discover: القدرات مشتقة من الأدوات فعلاً ═══════════════

test('discover: القدرات تُشتق من الأدوات الظاهرة عبر خريطة صريحة + unknownTools', () => {
  const probe = () => ({
    reached: true,
    tools: [
      'read_file',            // read_files
      'mcp__fs__read_file',   // نفس القدرة بعد التطبيع (لا تكرار)
      'grep',                 // search
      'tools/list',           // provide_tools
      'WRITE-FILE',           // write_files (تطبيع حالة الأحرف والشرطة)
      'str_replace_editor',   // write_files
      'weird_tool_xyz',       // بلا خريطة ⇒ unknownTools
    ],
    resources: ['file:///a.js', 'db://notes'],
  });

  const r = conn.discover(probe, 'opencode');

  assert.equal(r.reached, true);
  assert.deepEqual(r.capabilities, ['read_files', 'search', 'provide_tools', 'write_files']);
  // قدرة خطرة لم تظهر أداة لها ⇒ لا تُنسب
  assert.ok(!r.capabilities.includes('exec_command'), 'لا exec_command بلا أداة تنفيذ');

  assert.deepEqual(r.unknownTools, ['weird_tool_xyz']);
  // الدليل يسرد أسماء الأدوات كما وردت (بما فيها المرادف المُطبَّع إلى نفس القدرة)
  assert.deepEqual(r.evidence.read_files.sort(), ['mcp__fs__read_file', 'read_file']);
  assert.deepEqual(r.evidence.write_files.sort(), ['WRITE-FILE', 'str_replace_editor']);
  assert.deepEqual(r.resources, ['file:///a.js', 'db://notes']);
  assert.equal(r.reason, null);

  // الوصف العربي والحساسية مرفقان لكل قدرة مكتشفة
  const read = r.capabilityDetails.find((d) => d.id === 'read_files');
  assert.equal(read.sensitivity, 'safe');
  assert.ok(read.ar.length > 0);
  const write = r.capabilityDetails.find((d) => d.id === 'write_files');
  assert.equal(write.sensitivity, 'guarded');

  // حتمي: نفس المسبار ⇒ نفس القدرات (الزمن وحده يتغير)
  const again = conn.discover(probe, 'opencode');
  assert.deepEqual(again.capabilities, r.capabilities);
  assert.deepEqual(again.unknownTools, r.unknownTools);
});

test('discover: كل قدرة معيارية تُشتق من أداتها لا من الاسم', () => {
  const probe = () => ({
    reached: true,
    tools: ['list_files', 'ripgrep', 'list_tools', 'invoke_tool', 'run_tests', 'apply_patch', 'bash'],
    resources: [],
  });
  const r = conn.discover(probe, 'custom-connector');
  assert.deepEqual(
    r.capabilities,
    ['read_files', 'search', 'provide_tools', 'consume_tools', 'run_tests', 'write_files', 'exec_command']
  );
  assert.equal(conn.capabilityOf('mcp__server__exec_command'), 'exec_command');
  assert.equal(conn.capabilityOf('totally_unknown'), null);
});

// ═══════════════ ٣) نفس التطبيق بمسبارين ⇒ قدرات مختلفة ═══════════════

test('نفس التطبيق بمسبارين مختلفين ⇒ قدرات مختلفة (الاعتماد على القدرات لا الاسم)', () => {
  const a = conn.discover(probeReadOnly, 'claude-code');
  const b = conn.discover(probeFull, 'claude-code');

  assert.equal(a.target, b.target, 'نفس التطبيق');
  assert.deepEqual(a.capabilities, ['read_files', 'search']);
  assert.deepEqual(b.capabilities, ['read_files', 'search', 'run_tests', 'write_files', 'exec_command']);
  assert.notDeepEqual(a.capabilities, b.capabilities);

  // القرار الأمني يتبع المكتشَف: نفس المطلوب، حكمان مختلفان
  const required = ['read_files', 'write_files'];
  assert.equal(conn.compatibility(a, required).compatible, false);
  assert.equal(conn.compatibility(b, required).compatible, true);

  // والنطاق المسموح يختلف كذلك (الآمن فقط: قراءة وبحث)
  assert.deepEqual(conn.allowedScope(a, {}).allowed, ['read_files', 'search']);
  assert.deepEqual(conn.allowedScope(b, {}).allowed, ['read_files', 'search']);
  assert.ok(conn.allowedScope(b, {}).denied.includes('exec_command'));
});

// ═══════════════ ٤) compatibility ═══════════════

test('compatibility: يفشل عند غياب قدرة مطلوبة ويرصد missing', () => {
  const report = conn.discover(probeReadOnly, 'opencode');
  const res = conn.compatibility(report, ['read_files', 'search', 'run_tests', 'write_files']);

  assert.equal(res.compatible, false);
  assert.deepEqual(res.missing, ['run_tests', 'write_files']);
  assert.deepEqual(res.extra, []);
  assert.equal(res.verdict.includes('غير متوافق'), true);
  assert.ok(res.verdict.includes('run_tests'));

  // الناقص فارغ ⇒ متوافق، والمكتشف الزائد يُرصد extra
  const ok = conn.compatibility(report, ['read_files']);
  assert.equal(ok.compatible, true);
  assert.deepEqual(ok.missing, []);
  assert.deepEqual(ok.extra, ['search']);
});

test('compatibility: قدرة dangerous بلا موافقة ⇒ غير متوافق، ومع الموافقة ⇒ متوافق', () => {
  const report = conn.discover(probeFull, 'opencode');
  assert.ok(report.capabilities.includes('exec_command'));

  const noApproval = conn.compatibility(report, ['read_files', 'exec_command']);
  assert.equal(noApproval.compatible, false);
  assert.deepEqual(noApproval.missing, []);
  assert.deepEqual(noApproval.needsApproval, ['exec_command']);
  assert.match(noApproval.verdict, /موافقة/);

  const approved = conn.compatibility(report, [{ id: 'exec_command', approved: true }, 'read_files']);
  assert.equal(approved.compatible, true);
  assert.deepEqual(approved.needsApproval, []);
  assert.deepEqual(approved.missing, []);
});

test('compatibility: لا توافق بلا مطلب ولا على تكامل لم يُصل إليه', () => {
  const report = conn.discover(probeFull, 'opencode');
  const none = conn.compatibility(report, []);
  assert.equal(none.compatible, false);
  assert.match(none.verdict, /لم تُطلب/);

  const unreached = conn.discover(probeUnreachable, 'opencode');
  const res = conn.compatibility(unreached, ['read_files']);
  assert.equal(res.compatible, false);
  assert.deepEqual(res.missing, ['read_files']);
  assert.match(res.verdict, /لم يُصل/);
});

// ═══════════════ ٥) allowedScope ═══════════════

test('allowedScope: يبدأ آمناً ولا يمنح dangerous بلا explicit', () => {
  const report = conn.discover(probeFull, 'opencode');
  assert.deepEqual(
    report.capabilities,
    ['read_files', 'search', 'run_tests', 'write_files', 'exec_command']
  );

  // بلا منح: safe فقط — لا وصول شامل
  const base = conn.allowedScope(report, {});
  assert.deepEqual(base.allowed, ['read_files', 'search']);
  assert.deepEqual(base.denied, ['run_tests', 'write_files', 'exec_command']);
  assert.ok(base.note.includes('لا وصول شامل'));
  assert.ok(base.note.includes('§31/3'));

  // منح صريح لِـ guarded ⇒ يتوسّع
  const guarded = conn.allowedScope(report, { granted: ['write_files'] });
  assert.deepEqual(guarded.allowed, ['read_files', 'search', 'write_files']);
  assert.deepEqual(guarded.denied, ['run_tests', 'exec_command']);

  // dangerous مصرَّح بها بلا explicit ⇒ تُرفض
  const noExplicit = conn.allowedScope(report, { granted: ['write_files', 'exec_command'] });
  assert.ok(!noExplicit.allowed.includes('exec_command'));
  assert.deepEqual(noExplicit.blockedDangerous, ['exec_command']);
  assert.ok(noExplicit.denied.includes('exec_command'));

  // dangerous صراحةً + explicit:true ⇒ تُمنح
  const explicit = conn.allowedScope(report, { granted: [{ id: 'exec_command', explicit: true }] });
  assert.ok(explicit.allowed.includes('exec_command'));
  assert.deepEqual(explicit.blockedDangerous, []);
  assert.deepEqual(explicit.expanded, ['exec_command']);
  assert.deepEqual(explicit.denied, ['run_tests', 'write_files']);

  // منح قدرة غير مكتشفة لا يُنشئ صلاحية من الفراغ
  const ghost = conn.allowedScope(report, { granted: ['write_files', 'consume_tools'] });
  assert.ok(!ghost.allowed.includes('consume_tools'));
  assert.deepEqual(ghost.ungrantable, ['consume_tools']);
  assert.deepEqual(ghost.allowed, ['read_files', 'search', 'write_files']);
});

// ═══════════════ ٦) testIntegration ═══════════════

test('testIntegration: يسجّل connector_tested في audit_log ويعيد تقريراً موحّداً', () => {
  const db = makeDb();
  const before = countAudit(db, 'connector_tested');
  assert.equal(before, 0);

  const report = conn.testIntegration(db, 'opencode', {
    probe: probeFull,
    required: ['read_files', 'write_files'],
    granted: ['write_files'],
  });

  assert.equal(countAudit(db, 'connector_tested'), before + 1, 'سطر تدقيق واحد لكل فحص');

  const row = lastAudit(db, 'connector_tested');
  assert.equal(row.scope, 'opencode');
  const payload = JSON.parse(row.payload);
  assert.equal(payload.targetId, 'opencode');
  assert.equal(payload.reached, true);
  assert.equal(payload.compatible, true);
  assert.deepEqual(payload.allowed, ['read_files', 'search', 'write_files']);

  // التقرير الموحد يجمع الاكتشاف والتوافق والنطاق والسجل
  assert.equal(report.target, 'opencode');
  assert.equal(report.reached, true);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.allowed, ['read_files', 'search', 'write_files']);
  assert.ok(report.denied.includes('exec_command'));
  assert.deepEqual(report.blockedDangerous, []);
  assert.equal(report.audited, true);
  assert.equal(typeof report.auditId, 'number');

  // فحص ثانٍ لتكامل لم يُصل إليه: يُسجَّل أيضاً بصدق
  const failed = conn.testIntegration(db, 'claude-code', {
    probe: probeUnreachable,
    required: ['read_files'],
  });
  assert.equal(failed.compatible, false);
  assert.equal(failed.reached, false);
  assert.equal(countAudit(db, 'connector_tested'), 2);
  const failedPayload = JSON.parse(lastAudit(db, 'connector_tested').payload);
  assert.equal(failedPayload.reached, false);
  assert.deepEqual(failedPayload.allowed, []);
});

test('testIntegration: لا يسقط بلا قاعدة ولا بشهادة مسبار مرفوضة', () => {
  const report = conn.testIntegration(null, 'generic-mcp', { probe: probeFull, required: ['read_files'] });
  assert.equal(report.audited, false);
  assert.equal(report.auditId, null);
  assert.equal(report.compatible, true);
});

// ═══════════════ ٧) logCall + callLog ═══════════════

test('logCall: يكتب في mcp_calls، وcallLog يعيد needsApproval منطقياً', () => {
  const db = makeDb();

  const first = conn.logCall(db, {
    server: 'opencode',
    tool: 'write_file',
    args: { path: 'src/a.js', content: 'x' },
    result: { ok: true, bytes: 1 },
    ok: true,
    changedFiles: ['src/a.js'],
    needsApproval: false,
  });
  assert.equal(first.ok, true);
  assert.equal(typeof first.id, 'number');
  assert.equal(first.needsApproval, false);

  const second = conn.logCall(db, {
    server: 'opencode',
    tool: 'exec_command',
    args: { cmd: 'rm -rf build' },
    result: { exitCode: 0 },
    ok: true,
    changedFiles: ['build/index.js'],
    needsApproval: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.audited, true, 'ما يحتاج موافقة يُرفع لسجل التدقيق');

  const rows = db.prepare('SELECT COUNT(*) AS n FROM mcp_calls').get();
  assert.equal(Number(rows.n), 2);
  assert.equal(countAudit(db, conn.AUDIT_TYPE_APPROVAL_REQUIRED), 1);

  const log = conn.callLog(db, { limit: 10 });
  assert.equal(log.count, 2);
  assert.equal(log.total, 2);
  assert.equal(log.pendingApproval.length, 1);

  // الأحدث أولاً
  const [latest, older] = log.entries;
  assert.equal(latest.tool, 'exec_command');
  assert.equal(typeof latest.needsApproval, 'boolean');
  assert.equal(latest.needsApproval, true);
  assert.equal(older.needsApproval, false, 'needsApproval حقل منطقي لا رقم');

  // السجل يوضح الأدوات والنتائج والملفات المتغيرة
  assert.deepEqual(latest.changedFiles, ['build/index.js']);
  assert.deepEqual(latest.args, { cmd: 'rm -rf build' });
  assert.deepEqual(latest.result, { exitCode: 0 });
  assert.deepEqual(older.changedFiles, ['src/a.js']);
  assert.equal(older.ok, true);

  // الفلترة بالمزود
  assert.equal(conn.callLog(db, { server: 'opencode' }).count, 2);
  assert.equal(conn.callLog(db, { server: 'claude-code' }).count, 0);
  assert.equal(conn.callLog(db, { server: 'claude-code' }).total, 0);

  // limit يُحترم
  assert.equal(conn.callLog(db, { limit: 1 }).count, 1);

  // نداء ناقص لا يُسجَّل صامتاً
  const bad = conn.logCall(db, { server: 'opencode' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /مطلوب/);
  assert.equal(conn.callLog(db, {}).count, 2, 'لا صف دخيل بعد رفض النداء الناقص');

  // قاعدة بلا هجرة لا تُسقط التسجيل
  const raw = new DatabaseSync(':memory:');
  assert.equal(conn.logCall(raw, { server: 's', tool: 't' }).ok, false);
  assert.equal(conn.callLog(raw, {}).count, 0);
});

// ═══════════════ ٨) حماية سجل التدقيق ═══════════════

test('audit_log محمي: الحذف والتعديل يُرفضان بمحفّزات القاعدة', () => {
  const db = makeDb();
  conn.writeAudit(db, 'connector_tested', { targetId: 'opencode' }, { scope: 'opencode' });
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n), 1);

  assert.throws(
    () => db.prepare('DELETE FROM audit_log').run(),
    (e) => /محمي/.test(e.message),
    'حذف سجل التدقيق يجب أن يُرفض'
  );
  assert.throws(
    () => db.prepare("UPDATE audit_log SET type = 'x'").run(),
    (e) => /محمي/.test(e.message),
    'تعديل سجل التدقيق يجب أن يُرفض'
  );

  // الصف باقٍ كما هو بعد المحاولتين
  const row = db.prepare('SELECT * FROM audit_log').get();
  assert.equal(row.type, 'connector_tested');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n), 1);
  assert.equal(conn.hasTable(db, 'audit_log'), true);
});

test('testIntegration: لا يمكن محو أثر الفحص بعد تسجيله', () => {
  const db = makeDb();
  conn.testIntegration(db, 'generic-mcp', { probe: probeReadOnly, required: ['read_files'] });
  assert.equal(countAudit(db, 'connector_tested'), 1);
  assert.throws(() => db.prepare('DELETE FROM audit_log').run(), (e) => /محمي/.test(e.message));
  assert.equal(countAudit(db, 'connector_tested'), 1);
});

// ═══════════════ ٩) summary ═══════════════

test('summary: عدد التكاملات المختبرة والمتوافقة والأدوات التي تحتاج موافقة', () => {
  const db = makeDb();

  const ok = conn.testIntegration(db, 'opencode', { probe: probeFull, required: ['read_files', 'search'] });
  const bad = conn.testIntegration(db, 'claude-code', { probe: probeUnreachable, required: ['read_files'] });
  conn.logCall(db, {
    server: 'opencode', tool: 'exec_command', args: { cmd: 'ls' }, result: { code: 0 },
    ok: true, changedFiles: [], needsApproval: true,
  });
  conn.logCall(db, {
    server: 'claude-code', tool: 'read_file', args: { path: 'a' }, result: {}, ok: true,
  });

  const s = conn.summary(db, { reports: [ok, bad] });
  assert.equal(s.tested, 2);
  assert.equal(s.compatible, 1);
  assert.equal(s.incompatible, 1);
  assert.equal(s.reached, 1);
  assert.deepEqual(s.testedTargets.sort(), ['claude-code', 'opencode']);
  assert.equal(s.callsLogged, 2);
  assert.equal(s.needsApproval, 1);
  assert.equal(s.operationsNeedingApproval.length, 1);
  assert.equal(s.operationsNeedingApproval[0].tool, 'exec_command');
  assert.equal(s.operationsNeedingApproval[0].server, 'opencode');

  // ملخص بلا تقارير ولا قاعدة: أصفار لا انفجار
  const empty = conn.summary(null, {});
  assert.equal(empty.tested, 0);
  assert.equal(empty.compatible, 0);
  assert.equal(empty.callsLogged, 0);
});

// ═══════════════ ١٠) سجل التكاملات المعيارية ═══════════════

test('TARGETS و CAPABILITIES: التغطية المعيارية بأوصافها وحساسياتها', () => {
  const ids = conn.TARGETS.map((t) => t.id);
  for (const expected of ['opencode', 'claude-code', 'generic-mcp', 'custom-connector']) {
    assert.ok(ids.includes(expected), `الهدف ${expected} مفقود`);
  }
  for (const t of conn.TARGETS) {
    assert.ok(t.ar && t.kind && t.transport, 'كل هدف له وصف عربي ونوع ونقل');
  }

  for (const cap of ['read_files', 'write_files', 'run_tests', 'search', 'exec_command', 'provide_tools', 'consume_tools']) {
    assert.ok(conn.CAPABILITIES[cap], `القدرة ${cap} مفقودة`);
    assert.ok(conn.CAPABILITIES[cap].ar.length > 0);
    assert.ok(['safe', 'guarded', 'dangerous'].includes(conn.CAPABILITIES[cap].sensitivity));
  }
  assert.equal(conn.CAPABILITIES.exec_command.sensitivity, 'dangerous');
  assert.equal(conn.CAPABILITIES.read_files.sensitivity, 'safe');
  assert.equal(conn.sensitivityOf('write_files'), 'guarded');

  // كل مفتاح في الخريطة يشير إلى قدرة معيارية معروفة (لا خريطة معلّقة)
  for (const [tool, cap] of Object.entries(conn.TOOL_CAPABILITY)) {
    assert.ok(conn.CAPABILITIES[cap], `الأداة ${tool} تشير إلى قدرة مجهولة ${cap}`);
  }
});
