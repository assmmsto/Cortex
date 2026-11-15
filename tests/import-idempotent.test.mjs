/**
 * تكرار الاستيراد (§19) — العقد المُقاس على خزنة حقيقية (2026-11-06).
 *
 * العطل الذي وُلد منه هذا الاختبار:
 *   • كشف التكرار كان يجري **بعد** core.saveNote، فيُنشأ ملف جديد في كل استيراد
 *     ثم يأتي الرد «استيراد مُعاد — لم تُنشأ نسخة ثانية». الحصيلة: 15 نسخة
 *     متطابقة (نفس البصمة) لملف واحد على خزنة المستخدم.
 *   • صف document_entities بلا ملف (بقايا جلسات) كان يمنع الاستيراد صامتاً:
 *     «مكرر» بلا أي نسخة موجودة.
 *   • سجل التدقيق في المسار كان يستعمل أعمدة غير موجودة (ts/action/target/details)
 *     فيفشل داخل try/catch صامتاً — قياس: 0 صفوف تدقيق لاستيرادات مكررة كثيرة.
 *
 * الفحوص هنا على خادم معزول: لا تلمس خزنة المستخدم ولا قاعدته.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveServer } from './_live-server.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(PROJECT_DIR, 'docs', 'TEST-PLAN.md');

const mdFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
/* الوكيل الخفي يكتب ملاحظاته الخاصة (agent-memory / morning-brief) — تُستثنى حتى
   لا يُنسب إليه ما ليس منه. القياس على العنصر الذي أنشأه الاستيراد وحده. */
const importedOnly = (names) => names.filter((f) => !/^(agent-memory|morning-brief)/.test(f));

test('الاستيراد المتكرر: لا نسخة ثانية، والصف البائد لا يمنع الاستيراد، والتدقيق مسجَّل', async (t) => {
  const srv = await startLiveServer();
  t.after(async () => { await srv.stop(); });

  const vault = path.join(srv.root, 'vault');
  const dbFile = path.join(srv.root, 'data', 'cortex.db');
  const H = { 'Content-Type': 'application/json', 'X-Cortex-Session': srv.token };

  const importOnce = async () => {
    const r = await fetch(srv.base + '/api/import', { method: 'POST', headers: H, body: JSON.stringify({ path: SRC, project: '' }) });
    assert.equal(r.status, 200, 'الاستيراد يرد 200');
    return r.json();
  };
  const rows = async (sql) => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbFile);
    const out = db.prepare(sql).all();
    db.close();
    return out;
  };

  // 1) استيراد أول ⇒ عنصر واحد بالضبط
  const before = mdFiles(vault);
  const first = await importOnce();
  await new Promise((r) => setTimeout(r, 900));
  const addedFirst = importedOnly(mdFiles(vault).filter((f) => !before.includes(f)));
  assert.equal(addedFirst.length, 1, 'الاستيراد الأول يُنشئ عنصراً واحداً');
  assert.equal(first.deduplicated, false, 'الاستيراد الأول ليس تكراراً');

  // 2) إعادة الاستيراد ⇒ لا عنصر جديد + إعلان تكرار + صف تدقيق حقيقي
  const snapshot = mdFiles(vault);
  const second = await importOnce();
  await new Promise((r) => setTimeout(r, 900));
  const addedSecond = importedOnly(mdFiles(vault).filter((f) => !snapshot.includes(f)));
  assert.equal(addedSecond.length, 0, 'الاستيراد المُعاد لا يُنشئ نسخة ثانية');
  assert.equal(second.deduplicated, true, 'الرد يعلن أنه تكرار');

  const auditDup = await rows("SELECT type FROM audit_log WHERE type = 'duplicate_rejected'");
  assert.ok(auditDup.length >= 1, 'التكرار مُسجَّل في التدقيق (كان يسقط صامتاً بأعمدة خاطئة)');

  // 3) صف بلا ملف (بقايا جلسات): يجب ألا يمنع الاستيراد
  const row = (await rows(`SELECT id FROM document_entities WHERE original_path = '${SRC.replace(/'/g, "''")}'`))[0];
  assert.ok(row && row.id, 'صف المستند موجود');
  fs.unlinkSync(path.join(vault, row.id + '.md'));

  const snapshot2 = mdFiles(vault);
  const third = await importOnce();
  await new Promise((r) => setTimeout(r, 1000));
  const addedThird = importedOnly(mdFiles(vault).filter((f) => !snapshot2.includes(f)));
  assert.equal(third.deduplicated, false, 'صف بلا ملف لا يُعلن «مكرر»');
  assert.equal(addedThird.length, 1, 'الاستيراد يُنشئ الملف من جديد بعد فقدانه');

  const auditStale = await rows("SELECT type FROM audit_log WHERE type = 'stale_duplicate_row_cleared'");
  assert.ok(auditStale.length >= 1, 'تنظيف الصف البائد مُسجَّل في التدقيق');

  // 4) الصف الجديد يشير إلى ملف موجود فعلاً (لا مرجع ميت)
  const fresh = (await rows(`SELECT id FROM document_entities WHERE original_path = '${SRC.replace(/'/g, "''")}'`))[0];
  assert.ok(fresh && fs.existsSync(path.join(vault, fresh.id + '.md')), 'صف المستند يشير إلى ملف حقيقي');
});