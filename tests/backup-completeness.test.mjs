// tests/backup-completeness.test.mjs — §24 + §38: النسخة التي تُنقذ الملفات
// وتُفقد الذاكرة = نسخة كاذبة. هذا الاختبار يفشل إن لم تحوِ النسخة القاعدة.
// الأصل: createBackup() كانت تنسخ vault/ و settings.json و sessions/ و history/
// و0 صف من data/cortex.db (حُقن 2892 صفاً: notes/agent_tasks/audit_log/...).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const root = path.resolve(import.meta.dirname, '..');

// قارئ ZIP مركزي (نفس منطق buildZip معكوساً) — بلا مكتبات
function unzipEntry(buf, want) {
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) !== 0x04034b50) { i += 1; continue; }
    const method = buf.readUInt16LE(i + 8);
    const csize = buf.readUInt32LE(i + 18);
    const nlen = buf.readUInt16LE(i + 26);
    const elen = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nlen).toString('utf8');
    const ds = i + 30 + nlen + elen;
    const data = buf.slice(ds, ds + csize);
    if (name === want) return method === 0 ? data : zlib.inflateRawSync(data);
    i = ds + csize;
  }
  return null;
}

/* عزل إلزامي (درس 2026-10-24): createCore() بلا جذر كان يكتب churn في **خزنة
   المنتج الحية** — قِيس: 330 ملاحظة churn-* تراكمت في vault/. كل اختبار هنا
   يقلع جذرَه المؤقت ويبذر ملاحظة بمهمة (الادعاءان notes>0 وtasks>0). */
async function isolatedCore() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
  fs.mkdirSync(path.join(tmp, 'vault'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  const { createCore } = require(path.join(root, 'cortex-core.js'));
  const core = createCore({ root: tmp, projectRoot: root });
  if (core.ready) await core.ready;
  await core.saveNote({ title: 'Backup Probe', type: 'doc', content: '# Backup Probe\n\n- [ ] مهمة النسخ @tester\n' });
  // المرآة تُتزامن بتأخير 800ms افتراضياً — النسخة تحتاج القاعدة ممتلئة الآن
  await core.syncStore(true);
  return { core, tmp, close: () => { try { core.store && core.store.close(); } catch { /* أُغلق سابقاً */ } } };
}

test('النسخة الاحتياطية تحوي القاعدة (لا الملفات فقط) وتُسترجَع فعلاً', async () => {
  const { core, tmp, close } = await isolatedCore();
  try {
    const r = await core.createBackup();

    assert.equal(r.dbIncluded, true, 'يجب أن تُعلن النسخة تضمين القاعدة');

    const buf = fs.readFileSync(r.path);
    const dbBuf = unzipEntry(buf, 'data/cortex.db');
    assert.ok(dbBuf && dbBuf.length > 0, 'data/cortex.db يجب أن يكون داخل النسخة');

    // إثبات الاسترجاع: نفتح القاعدة المستخرجة ونقرأ المعرفة المبذورة
    const tmpDb = path.join(os.tmpdir(), `backup-restore-${Date.now()}-${process.pid}.sqlite`);
    fs.writeFileSync(tmpDb, dbBuf);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(tmpDb);
    try {
      const notes = db.prepare('SELECT COUNT(*) c FROM notes').get().c;
      const tasks = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
      assert.ok(notes > 0, `يجب أن تُسترجَع الملاحظات، وُجد ${notes}`);
      assert.ok(tasks > 0, `يجب أن تُسترجَع المهام، وُجد ${tasks}`);
    } finally {
      db.close();
      fs.rmSync(tmpDb, { force: true });
    }
    fs.rmSync(r.path, { force: true });
  } finally { close(); fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); }
});

test('النسخة متسقة ذرّياً: تُقرأ سليمة أثناء كتابة متزامنة (سلوك لا نص)', async () => {
  const { core, tmp: isoRoot, close } = await isolatedCore();
  try {

  // القياس الحيّ (بدل فحص أن الكود يحوي نص «VACUUM INTO» — فحص ثابت لا سلوك):
  // نكتب على القاعدة الحيّة **أثناء** إنشاء النسخة، ثم نتحقق أن النسخة الناتجة
  // قاعدة سليمة **وقابلة للقراءة الكاملة** (تكاملها مُثبت بـPRAGMA integrity_check).
  const { DatabaseSync } = require('node:sqlite');
  let writing = true;
  const churn = (async () => {
    for (let i = 0; i < 120 && writing; i++) {
      try { await core.saveNote({ title: `churn-${i}-${Date.now()}`, content: `# churn-${i}\n${'x'.repeat(400)}`, type: 'note' }); } catch { /* السقف أو القفل */ }
    }
  })();

  // ⭐ القياس الفاصل قبل النسخ: كل صف موجود **قبل** بدء النسخة يجب أن يكون فيها.
  // القياس السابق كان يقرأ الحيّ **بعد** النسخة، والكتابات مستمرة ⇒ الحيّ يتقدّم
  // صفاً أو أكثر على اللقطة فيظهر «نقص» كاذب (مُقاس: الحيّ 572 · النسخة 571) مع أن
  // النسخ ذرّي سليم. السقف الصحيح للأمانة: أرضية مُقاسة قبل اللقطة، لا بعدها.
  const preCount = (() => {
    const live = new DatabaseSync(path.join(core.dataDir, 'cortex.db'));
    try { return live.prepare('SELECT COUNT(*) c FROM notes').get().c; } finally { live.close(); }
  })();

  let r;
  try { r = await core.createBackup(); } finally { writing = false; await churn.catch(() => {}); }

  assert.equal(r.dbIncluded, true, 'يجب أن تُعلن النسخة تضمين القاعدة');
  const buf = fs.readFileSync(r.path);
  const dbBuf = unzipEntry(buf, 'data/cortex.db');
  assert.ok(dbBuf && dbBuf.length > 0, 'data/cortex.db يجب أن يكون داخل النسخة');

  // القاعدة المستخرجة تُفتح وتُقرأ كاملة — دليل ذرّية حقيقي.
  // القياس الصادق (مُثبت بقياس 2026-10-20): `journal_mode=wal` وملف `cortex.db-wal`
  // كان 4.2MB من بيانات غير مُدمَجة. نسخ `cortex.db` وحده يُنتج قاعدة **ناقصة**
  // لكنها **سليمة بنيوياً** ⇒ `integrity_check` يمرّ عليها! فالقياس البنيوي وحده
  // قياس كاذب. القياس الحقيقي: **عدد الصفوف** المُستخرَج مقابل الحيّ — النقص يكشف
  // النسخ غير الذرّي، ولا يمكن أن يمرّ بـ integrity_check.
  const tmp = path.join(os.tmpdir(), `cortex-atomic-${process.pid}.db`);
  fs.writeFileSync(tmp, dbBuf);
  let notes = 0, integrity = '';
  const db = new DatabaseSync(tmp);
  try {
    integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
    notes = db.prepare('SELECT COUNT(*) c FROM notes').get().c;
  } finally { db.close(); fs.rmSync(tmp, { force: true }); }
  fs.rmSync(r.path, { force: true });

  assert.equal(integrity, 'ok', `قاعدة النسخة سليمة بنيوياً (integrity_check=${integrity})`);
  assert.ok(notes > 0, `النسخة تحمل بيانات فعلاً (وُجد ${notes})`);
  // ⭐ القياس الفاصل: الذرّية تعني **صفر نقص** من الأرضية المقاسة قبل اللقطة.
  // حدّ القياس (مُقاس 2026-10-24): إبدال VACUUM INTO بـcopyFileSync لا يسقط هذا
  // الاختبار، لأن sqlite يعمل checkpoint عند إغلاق الاتصال في هذه البيئة فملف
  // cortex.db يحمل كل الصفوف. فالأرضية تحمي من «نسخة ناقصة/بلا قاعدة»، ولا تُدّعي
  // إثبات سلامة WAL أثناء كتابة متزامنة — الادعاء الأكبر يحتاج كتاباً دائماً مفتوحاً.
  assert.ok(notes >= preCount,
    `النسخة ذرّية: لا صفوف مفقودة (أرضية قبل النسخ ${preCount} · النسخة ${notes}) — نقص الصفوف = نسخ غير ذرّي`);
  } finally { close(); fs.rmSync(isoRoot, { recursive: true, force: true, maxRetries: 12, retryDelay: 120 }); }
});
