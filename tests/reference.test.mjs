import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tools = require('../cortex-tools-external');
const schema = require('../cortex-schema');
const orc = require('../cortex-orchestrator');

// ═══════════════════════════════════════════════════════════
//  الاختبار المرجعي — دستور المادة 41
//  النظام لا يُعتبر «وكيلاً» إلا إذا نفّذ هذا التسلسل فعلياً.
// ═══════════════════════════════════════════════════════════

const ctx = { allowedRoots: [ROOT] };

test('المادة 41/1: استيراد مستودع كامل — ملفات وتوثيق واعتماديات', async () => {
  const index = await tools.TOOL_IMPLS.repo_index({ path: ROOT }, ctx);
  assert.ok(!index.error, 'الفهرسة يجب أن تنجح');
  assert.ok(index.files > 20, `المستودع يجب أن يُفهرس كاملاً — وُجد ${index.files} ملفاً`);
  assert.ok(index.code > 5, 'يجب رصد ملفات الكود');
  assert.ok(index.docs > 0, 'يجب رصد التوثيق');
  assert.ok(index.manifest, 'يجب قراءة مخطوط الحزمة');
  assert.ok(index.manifest.file === 'package.json');

  // التوثيق الفعلي موجود ويُقرأ
  const readme = await tools.TOOL_IMPLS.fs_read({ path: path.join(ROOT, 'README.md') }, ctx);
  assert.ok(readme.content, 'README يجب أن يُقرأ');
});

test('المادة 41/2: تحليل البنية وخريطة اعتماديات متحقَّق منها', async () => {
  const deps = await tools.TOOL_IMPLS.repo_deps({ path: ROOT }, ctx);
  assert.ok(!deps.error);
  assert.ok(deps.filesScanned > 5, 'يجب مسح ملفات كافية');
  assert.ok(deps.internalEdges > 0, 'يجب اكتشاف استيرادات داخلية');
  assert.ok(deps.external.length > 0, 'يجب اكتشاف الحزم الخارجية');

  // كل حافة تحمل مصدرها وموقعها — لا تخمين
  for (const e of deps.edges.slice(0, 10)) {
    assert.ok(e.from, 'الحافة يجب أن تحمل الملف المصدر');
    assert.ok(e.to, 'الحافة يجب أن تحمل الهدف');
    assert.ok(e.kind, 'الحافة يجب أن تحمل نوع العلاقة');
    assert.ok(Number.isInteger(e.line) && e.line > 0, 'الحافة يجب أن تحمل رقم السطر');
  }
});

test('المادة 41/3: طرح أسئلة عن الملفات ومصادر المعلومات', async () => {
  // بحث حقيقي عن رمز في المستودع
  const hits = await tools.TOOL_IMPLS.fs_search(
    { path: ROOT, query: 'TOOL_POLICY', limit: 10 }, ctx);
  assert.ok(!hits.error);
  assert.ok(hits.count > 0, 'البحث يجب أن يجد الرمز');
  for (const h of hits.matches) {
    assert.ok(h.file, 'كل نتيجة تحمل ملفها');
    assert.ok(h.line > 0, 'كل نتيجة تحمل رقم سطرها — دليل قابل للتحقق');
  }

  // قراءة الموضع المحدد فعلاً
  const first = hits.matches[0];
  const file = await tools.TOOL_IMPLS.fs_read({ path: first.file }, ctx);
  assert.ok(file.content, 'الملف المصدر يجب أن يُقرأ');
  const lines = file.content.split('\n');
  assert.ok(lines[first.line - 1].includes('TOOL_POLICY'),
    'السطر المشار إليه يجب أن يحوي الرمز فعلاً — الدليل صحيح');
});

test('المادة 41/4: تحديد أثر تغيير ملف على بقية المشروع', async () => {
  const impact = await tools.TOOL_IMPLS.repo_impact(
    { path: ROOT, file: 'cortex-policy.js' }, ctx);
  assert.ok(!impact.error);
  assert.equal(impact.target, 'cortex-policy.js');
  assert.ok(impact.dependedByCount > 0,
    'cortex-policy مطلوبة من ملفات أخرى — أثر التغيير يجب رصده');
  assert.ok(impact.affectedFiles.length > 0, 'يجب إنتاج قائمة الملفات المتأثرة');

  // كل ملف متأثر مذكور يجب أن يكون موجوداً فعلاً
  for (const f of impact.affectedFiles.slice(0, 5)) {
    assert.ok(existsSync(path.join(ROOT, f)), `الملف المتأثر ${f} يجب أن يكون موجوداً`);
  }
});

test('المادة 41/5: تنفيذ تعديل داخل بيئة آمنة', async () => {
  // نعمل داخل مجلد مؤقت تحت جذر مسموح صريح — لعزل الأثر دون لمس المشروع
  const dir = mkdtempSync(path.join(tmpdir(), 'cortex-ref-'));
  const sandboxCtx = { allowedRoots: [dir] };
  try {
    const target = path.join(dir, 'sample.js');
    writeFileSync(target, 'const x = 1;\nconst y = 2;\n');

    // كتابة ملف جديد داخل البيئة الآمنة
    const w = await tools.TOOL_IMPLS.fs_write(
      { path: path.join(dir, 'new.js'), content: 'export const z = 3;\n' }, sandboxCtx);
    assert.ok(!w.error, `الكتابة يجب أن تنجح: ${w.error || ''}`);
    assert.equal(w.created, true, 'يجب إعلان إنشاء ملف جديد');
    assert.ok(existsSync(path.join(dir, 'new.js')));

    // تحرير دقيق
    const e = await tools.TOOL_IMPLS.fs_edit(
      { path: target, find: 'const x = 1;', replace: 'const x = 42;' }, sandboxCtx);
    assert.ok(!e.error, `التحرير يجب أن ينجح: ${e.error || ''}`);
    assert.ok(readFileSync(target, 'utf8').includes('const x = 42;'),
      'التغيير يجب أن يُطبَّق فعلاً على القرص');

    // التحرير يرفض المقطع غير الفريد
    const dup = await tools.TOOL_IMPLS.fs_edit(
      { path: target, find: 'const', replace: 'let' }, sandboxCtx);
    assert.ok(dup.error, 'المقطع غير الفريد يجب أن يُرفض');
    assert.ok(dup.error.includes('غير فريد'), `السبب يجب أن يوضح: ${dup.error}`);

    // الأدوات ترفض خارج الجذور المسموحة (لا تسرّب)
    const outside = await tools.TOOL_IMPLS.fs_write(
      { path: path.join(ROOT, 'should-not-be-created.txt'), content: 'x' }, sandboxCtx);
    assert.ok(outside.error, 'الكتابة خارج الجذور المسموحة مرفوضة');
    assert.equal(existsSync(path.join(ROOT, 'should-not-be-created.txt')), false,
      'الملف يجب ألا يُنشأ فعلاً — لا تسرّب');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('المادة 41/6: تشغيل الاختبارات والتحقق من الفرق الناتج', async () => {
  // التشغيل المتداخل: node --test داخل node --test غير مدعوم من Node نفسه.
  // خارج سياق الاختبارات نتحقق كاملاً؛ وداخله نتحقق من الكشف والأمر بصدق.
  const nested = Boolean(process.env.NODE_TEST_CONTEXT);

  const run = await tools.TOOL_IMPLS.run_tests({ path: ROOT, timeout: 250000 }, ctx);
  assert.ok(!run.error || run.error.includes('اختبارات'), `تشغيل الاختبارات: ${run.error || ''}`);
  assert.ok(run.command, 'يجب اكتشاف أمر الاختبارات');
  assert.equal(run.detected, 'package.json:scripts.test', 'يجب الاكتشاف من الحزمة');
  // §41/6: الأمر المكتشف من package.json:scripts.test يجب أن يشغّل الاختبارات
  // فعلاً. العطل 2026-10-20: كان الشرط حرفياً `includes('node --test')` — فقد صار
  // زائفاً بعد أن تحوّل `npm test` إلى `node tests/run-suite.cjs` (المشغّل الذي
  // يزرع بيئة حتمية ثم يستدعي node --test). الصواب: نقبل أي أمر يشغّل node --test
  // مباشرةً أو عبر مشغّل داخلي؛ والقاعدة الأقوى تبقى أنه يعمل فعلاً (durationMs>0
  // والنتائج أدناه)، لا شكل نصّه.
  const isRealTestRun = /node\s+--test/.test(run.command) || /run-suite\.cjs/.test(run.command);
  assert.ok(isRealTestRun, `الأمر يجب أن يكون تشغيل اختبارات فعلياً (وجد: ${run.command})`);
  assert.ok(run.durationMs > 0, 'يجب قياس المدة');

  // كشف الأمر نفسه يجب أن يكون حتمياً ومطابقاً لما في الحزمة
  const detected = await tools.detectTestCommand(ROOT);
  assert.equal(detected.command, run.command, 'الكشف يجب أن يكون ثابتاً');
  assert.equal(detected.detected, 'package.json:scripts.test');

  if (!nested) {
    // خارج سياق الاختبارات: نتحقق من النتائج الفعلية
    assert.ok(run.passed > 0, `يجب قراءة عدد الناجحة — قُرئ ${run.passed}`);
    assert.ok(typeof run.output === 'string' && run.output.length > 0, 'يجب التقاط الخرج');

    // المادة 41/6: الحالة تُعلن بصدق — الإخفاق لا يُخفى (دستور §46/1)
    if (run.failed !== null && run.failed > 0) {
      assert.equal(run.ok, false, 'وجود إخفاق يعني ok=false');
    } else {
      assert.equal(run.ok, true, 'بلا إخفاق يعني ok=true');
    }
  }
});

test('المادة 41/7: حفظ التقرير والقرارات والنتائج', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, type TEXT)');
  db.exec('CREATE TABLE note_links(source TEXT, target TEXT, kind TEXT, PRIMARY KEY(source,target,kind))');
  db.exec('CREATE TABLE tasks(id TEXT)');
  schema.migrate(db);

  // تسجيل قرار في سجل التدقيق
  db.prepare('INSERT INTO audit_log(at, type, scope, tool, payload) VALUES(?,?,?,?,?)')
    .run(new Date().toISOString(), 'reference_test', 'repo', 'run_tests',
         JSON.stringify({ passed: 70, verified: true }));

  const row = db.prepare('SELECT type, tool, payload FROM audit_log').get();
  assert.equal(row.type, 'reference_test');
  assert.ok(JSON.parse(row.payload).passed > 0);

  // الإصدارات تُحفظ للمستند المستورد
  db.prepare('INSERT INTO document_versions(doc_id, version, fingerprint, imported_at) VALUES(?,?,?,?)')
    .run('doc1', 1, 'abc123', new Date().toISOString());
  const ver = db.prepare('SELECT doc_id, version, fingerprint FROM document_versions').get();
  assert.equal(ver.doc_id, 'doc1');
  assert.equal(ver.fingerprint, 'abc123');
});

test('المادة 41/8: إعادة التشغيل واستعادة حالة المهمة', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cortex-resume-'));
  const dbFile = path.join(dir, 'state.db');
  const runId = 'reference-run';

  // ── الجلسة الأولى: تُنشأ المهام وتُنفّذ جزئياً ──
  {
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, type TEXT)');
    db.exec('CREATE TABLE note_links(source TEXT, target TEXT, kind TEXT, PRIMARY KEY(source,target,kind))');
    db.exec('CREATE TABLE tasks(id TEXT)');
    schema.migrate(db);

    const store = orc.createStore(db);
    store.createTasks([
      { id: 'a', runId, role: 'analyst', goal: 'g1', dependsOn: [] },
      { id: 'b', runId, role: 'builder', goal: 'g2', dependsOn: [] },
      { id: 'c', runId, role: 'tester', goal: 'g3', dependsOn: ['a'] }
    ]);
    store.markDone('a', { answer: 'أُنجز قبل التعطل' });
    // 'b' يبقى queued، 'c' ينتظر 'a' المنجزة
    db.close();
  }

  // ── إعادة التشغيل: نفتح نفس القاعدة ونستأنف ──
  {
    const db = new DatabaseSync(dbFile);
    schema.migrate(db);
    const store = orc.createStore(db);

    const before = store.listTasks(runId);
    assert.equal(before.find(t => t.id === 'a').status, 'done',
      'المهمة المنجزة يجب أن تُستعاد منجزة');
    assert.equal(before.find(t => t.id === 'b').status, 'queued',
      'المعلّقة يجب أن تُستعاد معلّقة');

    const executed = [];
    const o = new orc.Orchestrator({
      store,
      maxParallel: 2,
      runAgent: async (goal) => { executed.push(goal); return { answer: goal }; }
    });

    const resumed = await o.resume(runId);

    assert.equal(executed.includes('g1'), false,
      'المهمة المنجزة قبل التعطل لا تُعاد (دستور §36)');
    assert.ok(executed.includes('g2'), 'المعلّقة تُستأنف');
    assert.ok(executed.includes('g3'), 'التابعة تُنفّذ بعد استيفاء شرطها');

    const after = store.listTasks(runId);
    for (const t of after) {
      assert.ok(['done', 'failed', 'blocked'].includes(t.status),
        `لا مهمة تبقى معلّقة — ${t.id} حالته ${t.status}`);
    }
    assert.equal(after.find(t => t.id === 'a').status, 'done');
    db.close();
  }

  rmSync(dir, { recursive: true, force: true });
});

test('المادة 41: النظام يميّز بين المستورد والاستنتاج (دستور §6)', () => {
  // معلومة مستوردة = معتمدة
  assert.equal(schema.isVerifiedKnowledge('imported'), true);
  // استنتاج الوكيل = غير معتمد
  assert.equal(schema.isVerifiedKnowledge('inferred'), false);
  // فرضية = صفر ثقة
  assert.equal(schema.isVerifiedKnowledge('hypothesis'), false);
  // قرار بشري = معتمد
  assert.equal(schema.isVerifiedKnowledge('decided'), true);
});

test('المادة 41: كل أنواع الكيانات الثمانية معرّفة (دستور §5)', () => {
  const expected = ['note', 'project', 'document', 'file', 'repo', 'task', 'decision', 'knowledge'];
  for (const k of expected) {
    assert.ok(schema.KINDS.includes(k), `النوع ${k} يجب أن يكون معرّفاً`);
  }
});
