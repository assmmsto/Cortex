/**
 * بوابة الإثبات في حلقة الوكيل (§4: «ادّعى نجاحاً بلا دليل = فشل»).
 *
 * العطل المقيس (حكم الوكالة 2026-10-25): الوكيل ينفّذ كتابة فعلية ثم يعلن done
 * بلا أي خطوة تحقق (لا اختبار ولا قراءة أثر) — ادعاء بلا دليل يمر بصمت.
 *
 * العقد المُختبَر هنا على حلقة reactRun حقيقية بنموذج مزيّف مبرمَج (callModel
 * محقون — لا شبكة):
 *   أ) كتابة (create_note في الوضع المستقل) ثم done ⇒ تُرفض مرة برسالة تصحيحية
 *      (رسالة ثالثة في السجل تحمل «قبل الإنهاء») ثم بعد أداة تحقق done تُقبل
 *      بـ verified=true وstepsUsed=4.
 *   ب) الإصرار: كتابة ثم done ثم done ⇒ يُقبل الرد لكن verified=false ويُسجَّل
 *      agent_done_unverified في التدقيق — لا صمت ولا منع كامل.
 *   ج) بلا كتابة: done مباشرة ⇒ verified=null وبلا رسالة تصحيحية (البوابة لا
 *      تعطل المحادثات القرائية).
 *   د) use_skill يمر عبر السياسة ويعيد تعليمات المهارة فعلاً.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCore } = require('../cortex-core.js');
const { createAgent } = require('../cortex-agent.js');
const { createSkills } = require('../cortex-skills.js');
const projectDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

function makeRoot(autonomy = 'autonomous') {
  const tmp = mkdtempSync(path.join(tmpdir(), 'cortex-gate-'));
  mkdirSync(path.join(tmp, 'data'), { recursive: true });
  mkdirSync(path.join(tmp, 'vault'), { recursive: true });
  writeFileSync(path.join(tmp, 'data', 'settings.json'), JSON.stringify({
    ai: { provider: 'openai-compatible', model: 'scripted', baseUrl: 'http://127.0.0.1:9/v1', openaiBaseUrl: 'http://127.0.0.1:9/v1', apiKey: 'test', temperature: 0.2 },
    memory: { retrieval: { provider: 'local-ngram', model: 'ngram-tfidf-v2', dimensions: 256, chunkSize: 900, chunkOverlap: 120, topK: 8, candidateMultiplier: 6, rerankStrategy: 'mmr', minScore: 0.02, minSemantic: 0.02, batchSize: 16 } },
    agent: { autonomy, language: 'ar' }
  }, null, 2));
  return tmp;
}

// محلّل JSON حرّ محلي (نفس عقد server.parseJsonLoose: أول { إلى آخر })
function parseLoose(text) {
  const s = String(text || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a === -1 || b === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function makeScriptedAgent(core, replies, skills = null) {
  const calls = [];
  let i = 0;
  const callModel = async (_settings, messages) => {
    calls.push(messages.map(m => ({ role: m.role, content: String(m.content || '') })));
    const text = replies[Math.min(i, replies.length - 1)];
    i++;
    return { text };
  };
  const agent = createAgent({ core, callModel, parseJsonLoose: parseLoose, cut: (s, n) => String(s || '').slice(0, n || 4000), skills });
  return { agent, calls };
}

const replyAction = (name, args, thought = '') => JSON.stringify({ thought, action: { name, args } });
const replyDone = (answer) => JSON.stringify({ done: true, answer });

test('بوابة الإثبات: كتابة بلا تحقق تُرفض مرة ثم تُقبل بدليل', async t => {
  const tmp = makeRoot('autonomous');
  const core = createCore({ root: tmp, projectRoot: projectDir });
  t.after(() => {
    try { core.store && core.store.close && core.store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  });

  const { agent, calls } = makeScriptedAgent(core, [
    // ملاحظة العقد: create_note يشتق المعرّف من العنوان (slug) — الوسيط id للقراءة فقط في الأدوات الأخرى
    replyAction('create_note', { title: 'gate-note', content: '# بوابة\n\nمحتوى إثبات.' }, 'سأنشئ الملاحظة'),
    replyDone('أنشأت الملاحظة.'),
    replyAction('get_note', { id: 'gate-note' }, 'أتحقق من وجودها'),
    replyDone('أنشأت الملاحظة وتحققت من وجودها بالقراءة.')
  ]);

  const out = await agent.run({ goal: 'أنشئ ملاحظة إثبات', autonomy: 'autonomous' });
  assert.equal(out.error || null, null, 'التشغيل لا يفشل');
  assert.equal(out.verified, true, 'كتابة + تحقق ⇒ verified=true');
  assert.equal(out.mutations.length, 1, 'الكتابة نُفّذت فعلاً (autonomous)');
  assert.equal(calls.length, 4, `أربع نداءات للنموذج (كتابة، done مرفوض، تحقق، done) — وُجد ${calls.length}`);
  // الرسالة المصححة وصلت النموذج فعلاً في النداء الثالث
  const thirdCall = JSON.stringify(calls[2]);
  assert.ok(thirdCall.includes('قبل الإنهاء'), 'رسالة الإلزام التحققي وصلت للنموذج');
  assert.ok(thirdCall.includes('run_tests') || thirdCall.includes('get_note'), 'الرسالة تسمي أدوات التحقق');

  const audit = readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  assert.ok(!audit.includes('agent_done_unverified'), 'لا وسم عدم-تحقق في مسار التحقق الناجح');
});

test('بوابة الإثبات: الإصرار يُوسم unverified في التدقيق بدل الصمت', async t => {
  const tmp = makeRoot('autonomous');
  const core = createCore({ root: tmp, projectRoot: projectDir });
  t.after(() => {
    try { core.store && core.store.close && core.store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  });

  const { agent, calls } = makeScriptedAgent(core, [
    replyAction('create_note', { title: 'gate-note-2', content: '# إصرار\n\nبلا تحقق.' }, 'سأكتب'),
    replyDone('تم.'),
    replyDone('تم بلا تحقق.')
  ]);

  const out = await agent.run({ goal: 'اكتب ملاحظة وأصر على الإنهاء', autonomy: 'autonomous' });
  assert.equal(out.verified, false, 'كتابة بلا دليل ⇒ verified=false موسومة');
  assert.equal(calls.length, 3, 'محاولتا done + الكتابة = ثلاث نداءات');
  const audit = readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  assert.ok(audit.includes('agent_done_unverified'), 'الوسم مُسجَّل في التدقيق (لا صمت)');
});

test('بوابة الإثبات: بلا كتابة لا إلزام ولا تعطيل', async t => {
  const tmp = makeRoot('autonomous');
  const core = createCore({ root: tmp, projectRoot: projectDir });
  t.after(() => {
    try { core.store && core.store.close && core.store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  });

  const { agent, calls } = makeScriptedAgent(core, [replyDone('قرأت وأجبت بلا كتابة.')]);
  const out = await agent.run({ goal: 'ما عدد ملاحظاتي؟' });
  assert.equal(out.verified, null, 'جولة قرائية ⇒ verified=null');
  assert.equal(calls.length, 1, 'نداء واحد بلا أي تصحيح');
});

test('use_skill: يمر بالسياسة ويعيد تعليمات المهارة الفعلية', async t => {
  const tmp = makeRoot('autonomous');
  const core = createCore({ root: tmp, projectRoot: projectDir });
  const skillsDir = path.join(tmp, 'skills');
  const skills = createSkills({ dir: skillsDir });
  skills.ensureDefaults();
  t.after(() => {
    try { core.store && core.store.close && core.store.close(); } catch {}
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  });

  const { agent } = makeScriptedAgent(core, [
    replyAction('use_skill', { name: 'run-tests' }, 'أحمّل مهارة الاختبارات'),
    replyDone('حمّلت المهارة.')
  ], skills);

  const out = await agent.run({ goal: 'كيف أتحقق من نتائج الاختبارات؟' });
  const step = out.steps.find(s => s.tool === 'use_skill');
  assert.ok(step, 'خطوة use_skill نُفّذت');
  const payload = JSON.stringify(step.result);
  assert.ok(payload.includes('run_tests'), 'تعليمات المهارة تذكر أداة run_tests الفعلية');
  assert.ok(!payload.includes('غير موجودة') && !step.result.error, 'المهارة وُجدت بلا خطأ');
  const audit = readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  assert.ok(audit.includes('agent_skill_used'), 'استخدام المهارة مُدقَّق');
});
