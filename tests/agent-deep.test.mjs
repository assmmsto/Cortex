/* اختبارات سلوكية عميقة لحلقة الوكيل والمنسّق — تشغيل حقيقي بلا شبكة.
   node --test tests/agent-deep.test.mjs
   البيئة تُضبط قبل أي require حتى تُقرأ السقوف والجذور المسموحة صحيحة. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-deep-'));

process.env.AGENT_DAILY_WRITES = '100000';
process.env.CORTEX_DAILY_FS = '100000';
process.env.CORTEX_DAILY_VAULT = '100000';
process.env.CORTEX_DAILY_EXEC = '100000';
process.env.CORTEX_DAILY_IMPORT = '100000';
process.env.CORTEX_TEST_MODE = '1';
process.env.CORTEX_ALLOWED_ROOTS = [PROJECT, TMP, os.tmpdir()].join(path.delimiter);

const { createCore } = require(path.join(PROJECT, 'cortex-core.js'));
const { createAgent } = require(path.join(PROJECT, 'cortex-agent.js'));
const extTools = require(path.join(PROJECT, 'cortex-tools-external.js'));
const policy = require(path.join(PROJECT, 'cortex-policy.js'));
const orch = require(path.join(PROJECT, 'cortex-orchestrator.js'));

/* ── أدوات الاختبار ─────────────────────────────────────────── */
function parseJsonLoose(text) {
  const s = String(text == null ? '' : text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  if (start < 0) throw new Error('no json object in model output');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)); }
  }
  throw new Error('unbalanced json in model output');
}
const cut = (s, n = 240) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)}…` : t; };

function freshCore(settings = {}) {
  const root = fs.mkdtempSync(path.join(TMP, 'root-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'vault'), { recursive: true });
  const base = {
    agent: { autonomy: 'supervised', language: 'ar' },
    ai: { provider: 'deepseek', model: 'deepseek-chat', apiKey: '' },
  };
  const merged = { ...base, ...settings, agent: { ...base.agent, ...(settings.agent || {}) }, ai: { ...base.ai, ...(settings.ai || {}) } };
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify(merged, null, 2), 'utf8');
  return createCore({ root, projectRoot: PROJECT });
}

// سكربت نصميمه: كل نداء يعيد خطوة النموذج التالية. نلتقط الرسائل والنظام لفحص ما رآه النموذج فعلاً.
function makeAgent(core, steps, opts = {}) {
  const calls = [];
  let i = 0;
  const callModel = async (settings, messages, meta = {}) => {
    calls.push({ settings, messages, meta });
    const spec = steps[Math.min(i, steps.length - 1)];
    i += 1;
    const out = typeof spec === 'function' ? spec(messages, meta) : spec;
    return { text: typeof out === 'string' ? out : JSON.stringify(out) };
  };
  const agent = createAgent({ core, callModel, parseJsonLoose, cut });
  // توقيع الوكيل الحقيقي: run(params, emit, subCtx) — نلفّه بواجهة (goal, params, subCtx)
  const run = (goal, params = {}, subCtx = {}) => agent.run({ goal, ...params }, null, subCtx);
  return { agent: { ...agent, run }, calls };
}
const action = (name, args = {}, thought = 'خطوة') => ({ thought, action: { name, args } });
const done = (answer = 'انتهى') => ({ done: true, answer });
const lastUser = (call) => {
  const m = (call.messages || []).filter(x => x.role === 'user').pop();
  return m ? String(m.content || '') : '';
};

/* ── 1) أداة ترمي: يجب أن تُبلَّغ الحلقة بنتيجة فاشلة لا أن تنهار ── */
test('أداة ترمي استثناءً: الحلقة تُبلَّغ بالفشل وتكمل', async () => {
  const core = freshCore();
  const boom = path.join(core.root, 'boom.txt');
  fs.writeFileSync(boom, 'x', 'utf8');
  const original = extTools.TOOL_IMPLS.fs_read;
  assert.equal(typeof original, 'function', 'fs_read يجب أن يكون موجوداً');
  extTools.TOOL_IMPLS.fs_read = () => { throw new Error('انفجار محاكى في الأداة'); };
  try {
    const { agent } = makeAgent(core, [action('fs_read', { path: boom }), done('أكملت بعد الفشل')]);
    const r = await agent.run('اقرأ الملف ثم أبلغني', { autonomy: 'autonomous' });
    /* العقد الجوهري: الفشل يُبلَّغ ويُسجَّل مرة واحدة ويُكمل — لا انهيار ولا تكرار.
       عدد الخطوات الكلي قد يزيد عن الأدوات بسبب «التوجيه الحتمي» للأسئلة
       (2026-10-28: سؤال ملف/مستودع يستدعي repo_index من عنصر التحكم في الخطوة 2)
       — لذا نقيس على الأداة ذاتها لا على الإجمالي. */
    assert.equal(r.steps.filter(s => s.tool === 'fs_read').length, 1, 'الأداة الفاشلة تُسجَّل مرة واحدة ولا تُعاد');
    const boomStep = r.steps.find(s => s.tool === 'fs_read');
    assert.match(String(boomStep.result?.error || ''), /انفجار محاكى/);
    assert.equal(r.answer, 'أكملت بعد الفشل');
  } finally {
    extTools.TOOL_IMPLS.fs_read = original;
  }
});

/* ── 2) أداة غير موجودة: تُرفض برسالة مفهومة ولا تُنفَّذ ولا تُسقط الحلقة ── */
test('أداة غير موجودة: رفض واضح وخطوة مسجّلة بلا تنفيذ', async () => {
  const core = freshCore();
  const { agent, calls } = makeAgent(core, [action('ghost_tool', { x: 1 }), done('توقفت')]);
  const r = await agent.run('نفّذ أداة وهمية', { autonomy: 'autonomous' });
  assert.equal(r.steps.length, 1, 'النداء على أداة غير موجودة يجب أن يُسجَّل في المسار');
  assert.equal(r.steps[0].note, 'unknown-tool');
  assert.match(String(r.steps[0].result.error), /أداة غير مسموحة/);
  assert.equal(r.answer, 'توقفت');
  assert.match(lastUser(calls[1]), /أداة غير مسموحة|غير معروفة/);
});

/* ── 3) بلوغ MAX_STEPS: توقف حتمي برسالة سقف لا حلقة مفتوحة ── */
test('بلوغ MAX_STEPS يوقف الحلقة ويعلن السقف', async () => {
  const core = freshCore();
  const steps = Array.from({ length: 14 }, (_, i) => action('get_note', { id: `n${i}` }));
  const { agent, calls } = makeAgent(core, steps);
  const r = await agent.run('اقرأ ملاحظات كثيرة', { autonomy: 'autonomous' });
  // السقف 12 لا 8 (قرار مُقاس 2026-10-28: أسئلة المستودع تحتاج 7-9 قراءات مشروعة —
  // والتقرير §11). السكربت 14 خطوة لإثبات أن الحلقة تتوقف عند السقف ولا تُكمل.
  assert.equal(r.steps.length, 12, 'سقف الخطوات يجب أن يكون 12');
  assert.equal(calls.length, 12);
  assert.match(String(r.answer || ''), /الحد|سقف|خطوات/i);
});

/* ── 4) supervised: الأداة الكتابية تُحجز في الانتظار ولا تمسّ الملفات ── */
test('supervised يحجز create_note في الانتظار بلا تعديل', async () => {
  const core = freshCore();
  const before = (await core.readNotes()).length;
  const { agent } = makeAgent(core, [action('create_note', { title: 'ملاحظة ممنوعة', body: 'نص', tags: [] }), done('حجزت')]);
  const r = await agent.run('أنشئ ملاحظة', {});
  assert.equal(r.pending.length, 1);
  assert.equal(r.mutations.length, 0);
  const after = await core.readNotes();
  assert.equal(after.length, before);
});

/* ── 5) تصعيد الوضع من الحمولة: مرفوض، الإعدادات هي الحاكم ── */
test('طلب autonomy=autonomous من الحمولة لا يتجاوز إعداد supervised', async () => {
  const core = freshCore({ agent: { autonomy: 'supervised' } });
  const before = (await core.readNotes()).length;
  const { agent } = makeAgent(core, [action('create_note', { title: 'تصعيد مرفوض', body: 'نص', tags: [] }), done('تم')]);
  const r = await agent.run('أنشئ ملاحظة', { autonomy: 'autonomous' });
  assert.equal(r.mutations.length, 0, 'لا كتابة فعلية عند التصعيد');
  assert.equal(r.pending.length, 1, 'الطلب المصعَّد يجب أن يُحجز للاعتماد');
  assert.equal((await core.readNotes()).length, before);
  assert.equal(r.policy, 'supervised');
});

/* ── 6) بوابة السياسة تتلقى اسم الوضع نصاً لا دالة ── */
test('execTool يمرّر autonomy نصياً إلى policy.evaluate', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  const original = policy.evaluate;
  const seen = [];
  policy.evaluate = function patched(req) { seen.push({ tool: req && req.tool, autonomy: req && req.autonomy }); return original(req); };
  try {
    const { agent } = makeAgent(core, [action('create_note', { title: 'نمط مستقل', body: 'نص', tags: [] }), done('تم')]);
    await agent.run('أنشئ ملاحظة', { autonomy: 'autonomous' });
  } finally {
    policy.evaluate = original;
  }
  assert.ok(seen.length >= 1, 'يجب أن تُستدعى السياسة مرة على الأقل');
  for (const s of seen) assert.equal(typeof s.autonomy, 'string', `autonomy وصل ${typeof s.autonomy} إلى السياسة: ${String(s.autonomy).slice(0, 60)}`);
  assert.equal(seen[0].autonomy, 'autonomous');
});

/* ── 7) دور scout: لا أدوات كتابية ── */
test('دور scout ممنوع من create_note', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  const before = (await core.readNotes()).length;
  const { agent } = makeAgent(core, [action('create_note', { title: 'كتابة من مستطلع', body: 'نص', tags: [] }), done('انتهى')]);
  const r = await agent.run('أنشئ ملاحظة', { autonomy: 'autonomous' }, { role: 'scout' });
  assert.equal(r.mutations.length, 0);
  assert.equal((await core.readNotes()).length, before);
  assert.match(String(r.steps[0]?.result?.error || ''), /الدور|scout|صلاحي/);
});

/* ── 8) دور scout: قراءة مسموحة + توجيه الدور حاضر في رسالة النظام ── */
test('دور scout يقرأ ويستلم توجيهه في رسالة النظام', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  await core.saveNote({ title: 'خريطة المستودع', body: 'ملاحظة عربية للقراءة', tags: [] });
  const { agent, calls } = makeAgent(core, [action('search_notes', { query: 'المستودع' }), done('قرأت')]);
  const r = await agent.run('استطلع الملاحظات', { autonomy: 'autonomous' }, { role: 'scout' });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].result.error, undefined);
  const sys = String(calls[0].meta.system || '');
  assert.match(sys, /scout|استطلاع|مستطلع/, 'توجيه الدور غائب عن رسالة النظام');
});

/* ── 9) دور scribe: الكتابة مسموحة (ضبط إيجابي يمنع تعميم المنع) ── */
test('دور scribe يكتب فعلاً في الوضع المستقل', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  const before = (await core.readNotes()).length;
  const { agent } = makeAgent(core, [action('create_note', { title: 'محضر اجتماع', body: 'قرار عربي', tags: [] }), done('كتبت')]);
  const r = await agent.run('اكتب محضراً', { autonomy: 'autonomous' }, { role: 'scribe' });
  assert.equal(r.mutations.length, 1);
  assert.equal((await core.readNotes()).length, before + 1);
});

/* ── 10) نص عربي في الحمولة والوسائط: لا تشويه ولا قصّ ── */
test('العربية تصل كما هي في الهدف والوسائط والمخزون', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  const body = 'الاجتماع: ناقشنا ترحيل قاعدة البيانات، والقرار: التأجيل أسبوعين. الملاحظة تحتوي «اقتباساً» ورمزاً #٤٢.';
  const { agent, calls } = makeAgent(core, [
    action('create_note', { title: 'محضر ترحيل قاعدة البيانات', content: body, tags: ['عربي'] }),
    done('لخّصت المحضر العربي')
  ]);
  const r = await agent.run('أنشئ محضر ترحيل قاعدة البيانات بالعربية', { autonomy: 'autonomous' });
  const wrapped = lastUser(calls[0]);
  assert.match(wrapped, /أنشئ محضر ترحيل قاعدة البيانات بالعربية/, 'الهدف العربي لم يصل حرفياً');
  assert.equal(r.mutations.length, 1);
  assert.equal(r.mutations[0].title, 'محضر ترحيل قاعدة البيانات');
  const raw = fs.readdirSync(core.vaultDir).map(f => fs.readFileSync(path.join(core.vaultDir, f), 'utf8')).join('\n');
  assert.match(raw, /التأجيل أسبوعين/, 'نص عربي فُقد عند التخزين');
  assert.match(raw, /«اقتباساً»/, 'علامات الترقيم العربية شُوّهت');
  assert.equal(r.answer, 'لخّصت المحضر العربي');
});

/* ── 11) حلقة التكرار: نفس الاقتراح حرفياً لا يُعاد إلى ما لا نهاية ── */
test('تكرار نفس الاقتراح يوقف الحلقة ببيان صريح', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  const { agent, calls } = makeAgent(core, [action('search_notes', { query: 'نفس الشيء' }, 'أكرر')]);
  const r = await agent.run('ابحث بلا توقف', { autonomy: 'autonomous' });
  assert.ok(calls.length < 8, `الحلقة استمرت ${calls.length} نداءات رغم تكرار الاقتراح نفسه`);
  assert.match(String(r.answer || ''), /تكرار|عَلِق|لا يتقدّم|بلا تقدّم/);
});

/* ── 12) الإيقاف ثم الاستئناف: لا تنفيذ أثناء الإيقاف، ويعود بعد الإزالة ── */
test('الإيقاف يمنع التنفيذ والاستئناف يعيده', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  fs.writeFileSync(core.pausedFile, 'paused', 'utf8');
  const { agent } = makeAgent(core, [done('استؤنف')]);
  const blocked = await agent.run('أي هدف', { autonomy: 'autonomous' });
  assert.match(String(blocked.error || ''), /موقوف|متوقف|paused/i);
  fs.unlinkSync(core.pausedFile);
  const r = await agent.run('أي هدف', { autonomy: 'autonomous' });
  assert.equal(r.answer, 'استؤنف');
});

/* ── 13) تنفيذ متزامن على نفس الوكيل: عزل الخطوات والنتائج ── */
test('تشغيلان متزامنان لا تتلوث خطواتهما', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  await core.saveNote({ title: 'ألف', body: 'محتوى ألف', tags: [] });
  await core.saveNote({ title: 'بيت', body: 'محتوى بيت', tags: [] });
  let n = 0;
  // السكربت يقرر من رسائل التشغيل نفسه (لا عدّاد مشترك) حتى يكون العزل هو ما يُختبر
  const script = (messages) => {
    n += 1;
    const list = messages || [];
    const goal = String(list.find(m => m.role === 'user')?.content || '');
    const alreadyActed = list.some(m => m.role === 'assistant' && /"action"/.test(String(m.content || '')));
    if (alreadyActed) return done('انتهى');
    return action('search_notes', { query: goal.includes('ألف') ? 'ألف' : 'بيت' });
  };
  const { agent } = makeAgent(core, [script]);
  const [ra, rb] = await Promise.all([
    agent.run('مهمة ألف', { autonomy: 'autonomous' }),
    agent.run('مهمة بيت', { autonomy: 'autonomous' }),
  ]);
  assert.equal(ra.steps.length, 1);
  assert.equal(rb.steps.length, 1);
  assert.match(JSON.stringify(ra.steps[0].result), /ألف/);
  assert.match(JSON.stringify(rb.steps[0].result), /بيت/);
  assert.notEqual(JSON.stringify(ra.steps[0].result), JSON.stringify(rb.steps[0].result));
  assert.equal(ra.mutations.length + rb.mutations.length, 0);
});

/* ── 14) المنسّق: تفكيك حتمي بأدوار معروفة ثم تنفيذ فعلي ── */
test('المنسّق يفكّك الهدف وينفّذ مهاماً بأدوار معروفة', async () => {
  const store = orch.createStore(':memory:');
  const seenRoles = [];
  const runAgent = async (goal, subCtx) => { seenRoles.push(subCtx.role); return { answer: `تم ${subCtx.role}` }; };
  const o = new orch.Orchestrator({ store, runAgent, callModel: async () => { throw new Error('no model'); }, maxParallel: 2 });
  const { tasks } = await orch.decompose('أعد تقرير الحالة', { callModel: null });
  assert.ok(tasks.length >= 2, 'التفكيك الحتمي يجب أن ينتج مهام');
  for (const t of tasks) assert.ok(orch.ROLES[t.role], `دور غير معروف: ${t.role}`);
  const res = await o.run('أعد تقرير الحالة');
  assert.equal(res.summary.total, tasks.length);
  assert.equal(res.summary.done, tasks.length);
  assert.equal(res.verified, true);
  assert.deepEqual(seenRoles.slice().sort(), tasks.map(t => t.role).sort());
});

/* ── 15) المنسّق: فشل مهمة يُعزل، التابع يُحجب، التشغيل لا ينهار ── */
test('فشل مهمة في المنسّق يُعزل ويحجب التابع', async () => {
  const store = orch.createStore(':memory:');
  const runAgent = async (goal, subCtx) => { if (subCtx.role === 'analyst') throw new Error('عطل محلل محاكى'); return { answer: 'ok' }; };
  const o = new orch.Orchestrator({ store, runAgent, callModel: async () => { throw new Error('no model'); }, maxParallel: 2 });
  const res = await o.run('حلّل ثم نفّذ');
  assert.ok(res.summary.failed >= 1, 'يجب أن تُسجَّل مهمة فاشلة');
  assert.ok(res.summary.blocked >= 1, 'يجب أن يُحجب التابع');
  assert.equal(res.verified, false);
  assert.ok(res.tasks.every(t => !['queued', 'running'].includes(t.status)), 'لا مهمة معلّقة بعد الانتهاء');
});

/* ── 16) المنسّق: التوازي محترم ولا يتجاوز maxParallel ── */
test('المنسّق يحترم سقف التوازي', async () => {
  const store = orch.createStore(':memory:');
  let live = 0, peak = 0, calls = 0;
  const runAgent = async () => {
    live += 1; calls += 1; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 25));
    live -= 1;
    return { answer: 'ok' };
  };
  const steps = [{ id: 't1', role: 'analyst', goal: 'أ', dependsOn: [] }, { id: 't2', role: 'critic', goal: 'ب', dependsOn: [] }, { id: 't3', role: 'verifier', goal: 'ج', dependsOn: [] }, { id: 't4', role: 'monitor', goal: 'د', dependsOn: [] }];
  const callModel = async () => ({ tasks: steps });
  const o = new orch.Orchestrator({ store, runAgent, callModel, maxParallel: 2 });
  const res = await o.run('أربع مهام مستقلة');
  assert.equal(res.summary.total, 4);
  assert.equal(calls, 4);
  assert.ok(peak <= 2, `تجاوز التوازي المسموح: ${peak}`);
  assert.ok(peak >= 2, 'لم يُستغل التوازي إطلاقاً');
});

/* ── 17) دور critic: تحليل مسموح وكتابة مرفوضة + توجيه الدور حاضر ── */
test('دور critic يحلّل ويمنع الكتابة', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  await core.saveNote({ title: 'خطة الإطلاق', body: 'خطة عربية للتحليل', tags: [] });
  const before = (await core.readNotes()).length;
  const { agent, calls } = makeAgent(core, [
    action('create_note', { title: 'تسلل من ناقد', body: 'نص', tags: [] }),
    action('find_gaps', { project: '' }),
    done('دقّقت')
  ]);
  const r = await agent.run('دقّق خطة الإطلاق', { autonomy: 'autonomous' }, { role: 'critic' });
  assert.equal(r.mutations.length, 0, 'الناقد لا يكتب');
  assert.equal((await core.readNotes()).length, before);
  assert.match(String(r.steps[0]?.result?.error || ''), /الدور|critic|صلاحي/);
  assert.equal(r.steps[1]?.result?.error, undefined, 'أداة التحليل المسموحة لم تُنفّذ');
  const sys = String(calls[0].meta.system || '');
  assert.match(sys, /critic|ناقد|نقد/, 'توجيه الدور غائب عن رسالة النظام');
});

/* ── 18) مسار الاعتماد execute: الوضع يصل نصاً إلى السياسة ── */
test('execute يمرّر autonomy نصياً لا دالة', async () => {
  const core = freshCore({ agent: { autonomy: 'autonomous' } });
  const original = policy.evaluate;
  const seen = [];
  policy.evaluate = function patched(req) { seen.push({ tool: req && req.tool, autonomy: req && req.autonomy }); return original(req); };
  let res;
  try {
    const { agent } = makeAgent(core, [done('لا شيء')]);
    res = await agent.execute([{ tool: 'create_note', args: { title: 'معتمد', content: 'نص معتمد', tags: [] } }], { requestedAutonomy: 'autonomous' });
  } finally {
    policy.evaluate = original;
  }
  assert.equal(res.applied.length, 1, `التنفيذ المعتمد فشل: ${JSON.stringify(res.failed)}`);
  assert.ok(seen.length >= 1);
  for (const s of seen) assert.equal(typeof s.autonomy, 'string', `autonomy وصل ${typeof s.autonomy} إلى السياسة في مسار الاعتماد`);
  assert.equal(seen[0].autonomy, 'autonomous', 'الوضع الفعلي ضاع في مسار الاعتماد');
});
