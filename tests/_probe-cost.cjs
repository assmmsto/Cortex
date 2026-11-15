/* قياس تكلفة الحفظ/التدقيق — تشخيصي لا اختباري (خارج حزمة run-suite).
   عزل إلزامي (عطل مُقاس 2026-11-15): كان `createCore()` بلا جذر ⇒ الجذر = cwd
   = مجلد المشروع ⇒ كتب في data/ الحيّ وأنشأ 20 ملاحظة prof-note-* في خزنة
   المستخدم فعلاً. القياس على بيانات حقيقية بلا إذن ليس قياساً، بل تلويثاً. */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
process.env.CORTEX_TEST_MODE = '1';
const PROJECT = path.join(__dirname, '..');
const { createCore } = require(path.join(PROJECT, 'cortex-core.js'));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cost-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vault'), { recursive: true });
  const core = createCore({ root, projectRoot: PROJECT });
  if (core.ready) await core.ready;
  const t = async (label, n, fn) => {
    const t0 = Date.now();
    for (let i = 0; i < n; i++) await fn(i);
    console.log(label, Math.round((Date.now() - t0) / n), 'ms/op');
  };
  await t('appendAudit', 30, (i) => core.appendAudit({ type: 'probe', i }));
  await t('markVectorIndexDirty', 30, () => core.markVectorIndexDirty('probe'));
  await t('saveNote(tiny)', 20, (i) => core.saveNote({ title: `prof-note-${i}-${Date.now()}`, content: `# p${i}\n`, project: 'Prof' }));
  await t('readNotes', 10, () => core.readNotes());
  console.log('root =', root, '(معزول — لم يُلمس data/ المنتج)');
})();
