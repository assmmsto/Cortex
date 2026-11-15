'use strict';
/**
 * تنظيف ملاحظات الاختبار من الخزنة الحية — أداة صيانة صريحة (افتراضياً dry-run).
 *
 * الخلفية المقيسة (2026-10-27): أدوات فحص يدوية ومحاولة اختبار متسربة تركت
 * في خزنة المستخدم ملاحظات بأسماء اختبارية (prof-note-*, probe-*, rel-type-*,
 * اختبار-تدفق-*) — تلوّث الفهرسة والاسترجاع. القاعدة: الحذف لا يمس أي ملاحظة
 * إلا بمطابقة نمط اختباري صريح، ويمر عبر core.deleteNote (لقطة + تدقيق)،
 * والافتراضي عرض فقط حتى يُثبت العدد صراحة بـ --apply.
 *
 * الاستخدام:
 *   node tools/cleanup-test-notes.cjs            # عرض المرشحين فقط
 *   node tools/cleanup-test-notes.cjs --apply    # حذف فعلي (لقطة+تدقيق لكل عنصر)
 */
const path = require('node:path');
const { createCore } = require(path.join(__dirname, '..', 'cortex-core.js'));

// أنماط اختبارية ضيقة: id أو عنوان يطابق تماماً قالب اختبار معروف.
// ملاحظة صريحة: لا أنماط لملاحظات المخرجات (report-*) ولا موجز الصباح ولا ذاكرة
// الوكيل — تلك معرفة منتج حقيقية، لا تُمس إطلاقاً.
const ID_PATTERNS = [/^prof-note-\d+-\d+$/, /^probe-[a-z0-9]+$/i, /^rel-type-[ab]-\d+$/, /^mcp-guard-\d+$/, /^module(-[a-z0-9]+)?$/];
const TITLE_PATTERNS = [/^probe$/i, /^اختبار-تدفق-\d+$/, /^عنصر [أب]$/, /^p\d+$/, /^Module$/, /^هدف الحارس$/];

async function main() {
  const apply = process.argv.includes('--apply');
  const core = createCore();
  if (core.ready) await core.ready;
  const notes = await core.readNotes();
  const candidates = notes.filter(n =>
    ID_PATTERNS.some(re => re.test(n.id)) || TITLE_PATTERNS.some(re => re.test(String(n.title || '').trim()))
  );
  console.log(`الخزنة: ${notes.length} ملاحظة · المرشحون للحذف: ${candidates.length}`);
  for (const n of candidates.slice(0, 20)) console.log(`  - ${n.id} | ${n.title}`);
  if (candidates.length > 20) console.log(`  … و${candidates.length - 20} غيرها`);
  if (!apply) {
    console.log('\nوضع العرض فقط — لإتمام الحذف: node tools/cleanup-test-notes.cjs --apply');
    return;
  }
  let removed = 0;
  for (const n of candidates) {
    try { await core.deleteNote(n.id); removed++; } catch (e) { console.error(`فشل حذف ${n.id}: ${e.message}`); }
  }
  core.markVectorIndexDirty('cleanup-test-notes');
  await core.appendAudit({ type: 'cleanup_test_notes', removed, scanned: notes.length });
  console.log(`\nحُذفت ${removed} ملاحظة اختبارية (كل حذف له لقطة+تدقيق) وفُهرس الحذف كتلوّث للفهرس.`);
}

main().catch(e => { console.error('فشل التنظيف:', e.message); process.exit(1); });
