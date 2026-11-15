/**
 * حارس مسار الاعتماد — يمنع رجوع «المسودات المعتمدة تُرفض».
 *
 * عطلان مؤكدان حياً كشفهما السرب:
 *  1) `execute()` كانت قائمتها 6 أدوات معرفة فقط ⇒ كل مسودة خارجية
 *     (fs_write/fs_edit/fs_mkdir/shell_exec/run_tests) تُرفض بـ«أداة غير مسموحة».
 *  2) بوابة السياسة في `execTool` كانت ترجع للافتراضي `['vault']` وحده ⇒
 *     «scope not granted: filesystem» حتى بعد تمرير جذور الأداة.
 * والنظام كان يعلن النجاح طبقتين فوق عطل حقيقي.
 *
 * القاعدة الصحيحة: الاعتماد الصريح **يُنفّذ**، والسياسة تبقى حاكمة
 * (refuse ترفض دائماً)، والحدود والجذور المسموحة تبقى مفروضة.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const { createCore } = require(path.join(ROOT, 'cortex-core.js'));
const { createAgent } = require(path.join(ROOT, 'cortex-agent.js'));
const os = require('node:os');

/* جذر معزول لكل اختبار: العطل المُثبت 2026-10-20 — `createCore({root: ROOT})`
   يقرأ data/audit.log المشترك، وسقف الكتابة اليومي (DAILY_LIMITS.fs=60) يُحسب
   منه، فتفشل هذه الاختبارات بـ«daily limit reached for fs (60)» بعد جولات
   تطوير عادية — أي أن نتيجتها تعتمد على ما شُغّل قبلها لا على الكود. الآن كل
   اختبار يبني جذره المؤقت الخاص (+ ميزانية يومية مرتفعة للاختبار فقط). */
function build() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-approve-'));
  fs.mkdirSync(path.join(tmpRoot, 'data', 'vault'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'vault'), { recursive: true });
  // إعدادات دنيا لازمة للوكيل (بدون شبكة، مزود mock محلي)
  fs.writeFileSync(path.join(tmpRoot, 'data', 'settings.json'),
    JSON.stringify({ ai: { provider: 'mock', model: '', temperature: 0.2 }, agent: { defaultMode: 'project', autonomy: 'supervised' }, lang: 'ar' }, null, 1));
  const core = createCore({ root: tmpRoot, projectRoot: ROOT });
  core.__tmpRoot = tmpRoot;
  const agent = createAgent({
    core,
    callModel: async () => ({ text: '{}' }),
    parseJsonLoose: () => ({}),
    cut: (s, n) => String(s).slice(0, n),
  });
  return { core, agent, tmpRoot };
}
const SCOPE = ['vault', 'filesystem', 'repo', 'sandbox'];

test('مسار الاعتماد — ينفّذ فعلاً ولا يكتفي بإعلان النجاح', async (t) => {
  const { agent, tmpRoot } = build();
  const target = path.join(tmpRoot, 'data', 'vault', '_approve-guard-test.md');
  t.after(() => { try { fs.rmSync(target, { force: true }); } catch {} });

  const out = await agent.execute(
    [{ tool: 'fs_write', args: { path: target, content: 'محتوى الاعتماد' } }],
    { project: '', allowedScopes: SCOPE, autonomy: 'supervised', lang: 'ar' }
  );

  // 1) لم يفشل
  assert.deepEqual(out.failed, [], 'لا فشل في التنفيذ المعتمد: ' + JSON.stringify(out.failed));
  // 2) نُفّذ فعلاً — لا مجرد «مسودة بانتظار موافقة»
  assert.equal(out.applied.length, 1, 'إجراء واحد نُفِّذ');
  assert.ok(!out.applied[0].queued, 'لم تُعَد كمسودة معلّقة');
  // 3) الأثر الحقيقي على القرص — الدليل القاطع
  assert.ok(fs.existsSync(target), 'الملف كُتب فعلاً على القرص');
  assert.equal(fs.readFileSync(target, 'utf8'), 'محتوى الاعتماد');
});

test('مسار الاعتماد — أداة خارج النطاق تبقى مرفوضة', async (t) => {
  const { agent, tmpRoot } = build();
  const target = path.join(tmpRoot, 'data', 'vault', '_scope-test.md');
  t.after(() => { try { fs.rmSync(target, { force: true }); } catch {} });

  // نطاق vault فقط: fs_write (filesystem) يجب أن يُرفض
  const out = await agent.execute(
    [{ tool: 'fs_write', args: { path: target, content: 'x' } }],
    { project: '', allowedScopes: ['vault'], autonomy: 'supervised', lang: 'ar' }
  );
  assert.equal(out.applied.length, 0, 'لا يُنفَّذ بلا نطاق مصرّح');
  assert.ok(out.failed.length === 1, 'فشل واحد معلن');
  assert.ok(!fs.existsSync(target), 'الملف لم يُكتب — النطاق محترم');
});

test('مسار الاعتماد — أداة مجهولة تبقى مرفوضة', async (t) => {
  const { agent, tmpRoot } = build();
  const out = await agent.execute(
    [{ tool: 'totally_made_up_tool', args: {} }],
    { project: '', allowedScopes: SCOPE, autonomy: 'supervised', lang: 'ar' }
  );
  assert.equal(out.applied.length, 0, 'أداة مجهولة لا تُنفَّذ');
  assert.equal(out.failed.length, 1, 'رفض معلن');
});

test('مسار الاعتماد — الجذور المسموحة تبقى مفروضة (لا كتابة خارجها)', async (t) => {
  const { agent, tmpRoot } = build();
  // مسار خارج كل الجذور المسموحة
  const outside = 'C:/Windows/Temp/cortex-escape-test.md';
  const out = await agent.execute(
    [{ tool: 'fs_write', args: { path: outside, content: 'should not happen' } }],
    { project: '', allowedScopes: SCOPE, autonomy: 'supervised', lang: 'ar' }
  );
  const wrote = fs.existsSync(outside);
  if (wrote) fs.rmSync(outside, { force: true });
  assert.ok(!wrote, 'لا كتابة خارج الجذور المسموحة');
  assert.ok(out.failed.length >= 1, 'الرفض معلن: ' + JSON.stringify(out.applied));
});
