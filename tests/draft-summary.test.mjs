/**
 * C2 — حارس ملخص المسودة: كل أداة قابلة للاعتماد (WRITE/ALWAYS-DRAFT) يجب أن
 * يكون لبطاقة اعتمادها ملخص **غير فارغ**.
 *
 * العطل المُثبت حياً: `draftSummary` في cortex-agent.js تغطي 6 أدوات فقط من 17،
 * والمسودة الحيّة الوحيدة في `data/agent-pending.json` (project_absorb) كان
 * ملخصها المحفوظ `""` — فبطاقة الاعتماد تُعرض بلا وصف لما سيُنفَّذ.
 *
 * الاستيراد الحقيقي: تُحمَّل الوحدة وتُسأل كما يسألها الوكيل، لا نسخة من الكود.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const agent = require(path.join(ROOT, 'cortex-agent.js')).createAgent({});

// الأدوات التي تُسجَّل مسودةً وتحتاج وصفاً (لائحة §33 في cortex-agent.execute)
const APPROVABLE = [
  'create_note', 'append_tasks', 'append_section', 'link_note', 'living_note', 'extract_meeting_actions',
  'schedule_add', 'schedule_toggle', 'schedule_remove', 'run_cancel',
  'project_absorb', 'trail_append', 'import_path', 'import_url',
];

const ARGS = {
  create_note: { title: 'T' }, append_tasks: { noteId: 'n', tasks: [1] }, append_section: { noteId: 'n', heading: 'H' },
  link_note: { source: 'a', target: 'b' }, living_note: { project: 'p' }, extract_meeting_actions: { noteId: 'n' },
  schedule_add: { goal: 'g', every_hours: 6 }, schedule_toggle: { id: 'i', enabled: false }, schedule_remove: { id: 'i' },
  run_cancel: { runId: 'r' }, project_absorb: { path: 'a/b', project: 'p' }, trail_append: { project: 'p', entry: 'e' },
  import_path: { path: 'a/b' }, import_url: { url: 'https://x.test' },
};

test('C2 · كل أداة قابلة للاعتماد لها ملخص غير فارغ بالعربية', () => {
  const empty = APPROVABLE.filter((n) => !String(agent.draftSummary(n, ARGS[n] || {}, 'ar') || '').trim());
  assert.deepEqual(empty, [], `أدوات بلا ملخص: ${empty.join(', ')}`);
});

test('C2 · الملخص يذكر ما سيُنفَّذ (المسار/المشروع) لا نصاً عاماً', () => {
  const s = String(agent.draftSummary('project_absorb', { path: 'repo/src', project: 'Atlas' }, 'ar'));
  assert.ok(/repo\/src/.test(s) || /Atlas/.test(s), `ملخص project_absorb لا يذكر الهدف: "${s}"`);
  const t = String(agent.draftSummary('trail_append', { project: 'Atlas' }, 'ar'));
  assert.ok(/Atlas/.test(t), `ملخص trail_append لا يذكر المشروع: "${t}"`);
});

test('C2 · الإنجليزية تُخدم أيضاً (لا عربية في وضع en)', () => {
  const s = String(agent.draftSummary('import_path', { path: 'docs/a.md' }, 'en'));
  assert.ok(s && !/[\u0600-\u06FF]/.test(s), `الملخص الإنجليزي عربي: "${s}"`);
});
