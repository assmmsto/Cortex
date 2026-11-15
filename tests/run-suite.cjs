#!/usr/bin/env node
/**
 * مشغّل الحزمة الجماعية لاختبارات Cortex.
 *
 * لماذا يوجد هذا الملف (درس 2026-10-20):
 *   `node --test tests/*.test.mjs` كان يفشل 18–21 مرة بلا أي عطل حقيقي في الكود.
 *   الأسباب الجذرية الثلاثة المقيسة بالأدلة:
 *     1. سقف الكتابة اليومي `DAILY_LIMITS.fs = 60` في cortex-policy.js يُحسب من
 *        `data/audit.log` — أي أن جولات التطوير تستهلك السقف، فتفشل الاختبارات
 *        بـ«daily limit reached for fs (60)». اختبار يعتمد على حالة يومية = غير حتمي.
 *     2. `CORTEX_ALLOWED_ROOTS` غير مُمرَّر، فاختبارات تستعمل مجلداً مؤقتاً
 *        (Temp) تُرفض بـ403 «خارج الجذور المسموحة».
 *     3. اختبارات تستدعي `createCore()` بلا `root` فتقرأ `obsimem-web/data`
 *        المشترك — تلوّث متقاطع بين الاختبارات.
 *
 * الإصلاح: بيئة واحدة حتمية تُزرع قبل تشغيل أي اختبار:
 *   - AGENT_DAILY_WRITES مرتفع  → لا فشل بسبب سقف استهلكته جولات سابقة.
 *   - CORTEX_ALLOWED_ROOTS يشمل جذر المشروع + Temp → اختبارات المجلدات المؤقتة تمر.
 *   - يبقى كل شيء آخر كما هو (لا تعطيل سياسة: الحدود تبقى مطبَّقة في المنتج).
 *
 * الاستعمال: npm test        (يزرع البيئة ثم يشغّل الحزمة)
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsx = require('node:fs');

const ROOT = path.resolve(__dirname, '..');

/**
 * قفل تفرّد — يمنع تشغيل حزمتين في وقت واحد (درس 2026-10-20).
 *
 * القياس: تشغيل `npm test` مرتين **متوازيين** أعطى 234/252 (18 إخفاقاً)، ثم
 * 251/252، ثم 256/256 عند التشغيل المفرد — بنفس الكود تماماً. السبب: الجولتان
 * تتسابقان على `data/audit.log` و`data/cortex.db` المشتركين، فتستهلك إحداهما
 * سقف الأخرى وتقرأ الأخرى بيانات لم تكتبها بعد.
 *
 * الحل: قفل ملف. الدخول (open بـ'wx') ذرّي على كل الأنظمة ⇒ لا جولتان متوازيتان.
 * القفل يتيم يُكتشف بفحص الـPID: إن كان المالك ميتاً يُستَلَم القفل بدل التعليق.
 * التخطّي الواعي متاح بـ CORTEX_ALLOW_CONCURRENT_TESTS=1 (لتشخيص متعمّد فقط).
 */
const LOCK = path.join(ROOT, 'data', '.test-suite.lock');

function ownerAlive(pid) {
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = موجود بلا صلاحية ⇒ حيّ
}

function acquireLock() {
  /* القفل الموحّد (tests/_suite-lock.cjs) يغطي حزمة الوحدات **وحزمة المتصفح** معاً.
     كان القفل القديم في data/.test-suite.lock يحمي هذه الحزمة وحدها، فتشغيل
     `test:browser` بالتوازي معها ظل يلوّث data/ ويعطي إخفاقات كاذبة
     (مُثبت: 9 عمليات متصاحبة ⇒ 5 أقسام «فاشلة» ثم 0 عند التشغيل المفرد). */
  let release;
  try {
    release = require('./_suite-lock.cjs').acquire('unit', { waitMs: 0 });
  } catch (e) {
    if (e && e.name === 'ConcurrentSuiteError') {
      console.error(`✖ ${e.message} — أوقفها أو استعمل CORTEX_ALLOW_CONCURRENT_TESTS=1`);
      process.exit(2);
    }
    throw e;
  }
  module.exports._release = release;
}
acquireLock();

// بيئة حتمية للاختبار — لا تعطّل المنتج، بل تمنع الفشل الكاذب:
const env = {
  ...process.env,
  // (1) سقف الكتابة اليومي: مرتفع كفاية لجولة اختبار كاملة. المنتج يبقى 25.
  AGENT_DAILY_WRITES: process.env.AGENT_DAILY_WRITES || '100000',
  // (2) الجذور المسموحة: جذر المشروع + Temp + مجلد جذور مخصّص للاختبارات.
  CORTEX_ALLOWED_ROOTS: [
    ROOT,
    os.tmpdir(),
    path.join(os.tmpdir(), 'cortex-test-roots'),
    process.env.CORTEX_ALLOWED_ROOTS || ''
  ].filter(Boolean).join(path.delimiter),
  // (3) الميزانيات اليومية: `DAILY_LIMITS` في cortex-policy.js تُحسب من
  //     data/audit.log المشترك، فجولات التطوير تستهلك سقف `fs` (60) وتفشل
  //     اختبارات بلا عطل حقيقي. رفع صريح للاختبار فقط؛ المنتج يبقى على الافتراضي.
  CORTEX_DAILY_FS: process.env.CORTEX_DAILY_FS || '100000',
  CORTEX_DAILY_VAULT: process.env.CORTEX_DAILY_VAULT || '100000',
  CORTEX_DAILY_EXEC: process.env.CORTEX_DAILY_EXEC || '100000',
  CORTEX_DAILY_IMPORT: process.env.CORTEX_DAILY_IMPORT || '100000',
  // منع أي محاولة اتصال شبكي حقيقي أثناء اختبار الحزمة (قرار المتجر: لا مزوّد حقيقي).
  CORTEX_TEST_MODE: '1',
  // عطل مُقاس 2026-10-28: حارس البقاء الخارجي كان يعيد تشغيل خوادم الاختبارات
  // المقتولة عمداً (أشباح على منافذ ثابتة أفسدت جولات retrieval/import-deep).
  // لا حارس في وضع الاختبار — الإصلاح البنيوي في server.js/watchdog.cjs.
  CORTEX_NO_WATCHDOG: '1'
};

// مجلد جذور مؤقت موجود فعلاً (بعض الأدوات تتحقق من الوجود)
const extraRoot = path.join(os.tmpdir(), 'cortex-test-roots');
try { fs.mkdirSync(extraRoot, { recursive: true }); } catch { /* غير حرج */ }

// اجمع ملفات الاختبار (بدل الاعتماد على توسيع `*` الذي يفشل عند shell:false)
const testsDir = path.join(ROOT, 'tests');
const files = fs.readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort()
  .map((f) => path.join(testsDir, f));

if (files.length === 0) {
  console.error('لا ملفات اختبار في tests/');
  process.exit(1);
}

console.log(`تشغيل ${files.length} ملف اختبار ببيئة حتمية`);
console.log(`  AGENT_DAILY_WRITES=${env.AGENT_DAILY_WRITES}`);
console.log(`  CORTEX_ALLOWED_ROOTS=${env.CORTEX_ALLOWED_ROOTS}`);
console.log('');

const res = spawnSync(
  process.execPath,
  // --test-timeout=300000 (درس 2026-10-22): بلا مهلة، أي اختبار يعلّق (عامل
  // mcp-client.test.mjs تجمّد 45+ دقيقة بابن حي fake-mcp-server) يعلّق الحزمة
  // كلها أبدياً ويحتجز القفل. 5 دقائق للاختبار الواحد: أبطأ اختبار فعلي 127ث.
  ['--test', '--test-concurrency=1', '--test-timeout=300000', ...files],
  // stdin = 'ignore' لا 'inherit': تشغيل الحزمة بلا طرفية (خلفية/CI/أنبوب) كان يفشل
  // بـ«stdin is not a tty» لأي اختبار يقرأ المدخل القياسي — والاختبارات لا تحتاج مدخلاً.
  { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] }
);

process.exit(res.status === null ? 1 : res.status);
