/**
 * المبادرة المجدولة — عقد الإدارة الكامل على خادم معزول:
 *  1) إضافة مهمة مجدولة (هدف + كل N ساعة) عبر POST /api/agent/schedule.
 *  2) المهمة الجديدة «مستحقة فوراً» (بلا last_run_at) وتظهر due=true.
 *  3) «شغّلها الآن» ينفّذها فعلاً: تدقيق scheduled_task_run + جلسة برسالتين
 *     (هدف + جواب) + last_run_at يُضبط فتصبح due=false.
 *  4) تعطيل ثم حذف يعملان، وسقوف التحقق ترفض المدخلات الفاسدة.
 * كل ذلك بجذر APP_ROOT مؤقت — لا لمس للبيانات الحية.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionToken } from './_session.mjs';

const ROOT = process.cwd();
const PORT = 4500 + (process.pid % 400);
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let tmpRoot = null;

async function call(method, p, payload) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = await sessionToken({ base: BASE }).catch(() => null);
  if (tok) headers['X-Cortex-Session'] = tok;
  const r = await fetch(BASE + p, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test('المهام المجدولة: إضافة ⇒ مستحقة ⇒ تشغيل الآن ⇒ جلسة+تدقيق ⇒ تعطيل/حذف', async t => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cortex-schedtasks-'));
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, APP_ROOT: tmpRoot, APP_PORT: String(PORT) }
  });
  t.after(() => {
    try { if (child) child.kill(); } catch {}
    try { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }

  // 1) اللوحة الافتراضية: 6 ساعات فعلياً (غياب الإعداد = افتراضي يعمل — لا سكوت أبدي)
  const sch0 = await call('GET', '/api/agent/schedule');
  assert.equal(sch0.status, 200);
  assert.equal(sch0.body.effectiveHours, 6, 'الافتراضي الفعلي 6 ساعات');
  assert.equal(sch0.body.tasks.length, 0);

  // 2) الإضافة + الاستحقاق الفوري
  const add = await call('POST', '/api/agent/schedule', { action: 'add', goal: 'راجع مهامي المفتوحة واذكر المتأخر', every_hours: 6 });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const taskId = add.body.task.id;
  assert.ok(taskId, 'مُعرّف المهمة عاد');
  const sch1 = await call('GET', '/api/agent/schedule');
  const task1 = sch1.body.tasks.find(x => x.id === taskId);
  assert.ok(task1, 'المهمة ظاهرة');
  assert.equal(task1.due, true, 'مستحقة فوراً (لم تُشغَّل بعد)');

  // 3) تشغيل فوري: تنفيذ فعلي + جلسة برسالتين + تدقيق + last_run_at
  const run = await call('POST', '/api/agent/schedule', { action: 'run-now', id: taskId });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.ok, true, 'التشغيل نجح');
  assert.ok(run.body.run.sessionId, 'جلسة أُنشئت للمهمة');

  const sch2 = await call('GET', '/api/agent/schedule');
  const task2 = sch2.body.tasks.find(x => x.id === taskId);
  assert.ok(task2.last_run_at, 'وقت آخر تشغيل سُجّل');
  assert.equal(task2.due, false, 'لم تعد مستحقة بعد التشغيل');

  const audit = readFileSync(path.join(tmpRoot, 'data', 'audit.log'), 'utf8');
  assert.ok(audit.includes('scheduled_task_run'), 'التشغيل مُدقَّق');
  assert.ok(audit.includes('agent_schedule_added'), 'الإضافة مُدقَّقة');

  // الجلسة تحمل الهدف والجواب (عقد الاستمرارية)
  const sessionsDir = path.join(tmpRoot, 'sessions');
  const dir = existsSync(sessionsDir) ? sessionsDir : path.join(tmpRoot, 'data', 'sessions');
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const schedSession = files.map(f => JSON.parse(readFileSync(path.join(dir, f), 'utf8'))).find(s => s.id === run.body.run.sessionId);
  assert.ok(schedSession, 'ملف الجلسة موجود');
  assert.equal(schedSession.messages.length, 2, 'هدف + جواب في الجلسة');

  // 4) تعطيل ثم حذف
  const tog = await call('POST', '/api/agent/schedule', { action: 'toggle', id: taskId, enabled: false });
  assert.equal(tog.status, 200);
  assert.equal(tog.body.tasks.find(x => x.id === taskId).enabled, false, 'التعطيل انعكس');
  const rem = await call('POST', '/api/agent/schedule', { action: 'remove', id: taskId });
  assert.equal(rem.status, 200);
  assert.equal(rem.body.tasks.length, 0, 'الحذف انعكس');

  // 5) سقوف التحقق
  const bad1 = await call('POST', '/api/agent/schedule', { action: 'add', goal: '', every_hours: 6 });
  assert.equal(bad1.status, 400, 'هدف فارغ مرفوض');
  const bad2 = await call('POST', '/api/agent/schedule', { action: 'add', goal: 'مهمة', every_hours: 0.01 });
  assert.equal(bad2.status, 400, 'تكرار أقل من 15 دقيقة مرفوض');
  const bad3 = await call('POST', '/api/agent/schedule', { action: 'run-now', id: 'nope' });
  assert.equal(bad3.status, 404, 'مهمة غير موجودة = 404');

  // 6) سجل النبضات يحمل نبضة الإقلاع (دليل المبادرة الذاتية بلا ضغطة)
  // النبضة تبدأ بعد ~1.5ث وتستغرق ~2ث (مستجدات+موجز+ذاكرة) — انتظار محدود لا نوم ثابت
  let ticks = { body: { items: [] } };
  for (let i = 0; i < 40; i++) {
    ticks = await call('GET', '/api/agent/ticks');
    if ((ticks.body.items || []).length > 0) break;
    await new Promise(r => setTimeout(r, 400));
  }
  assert.equal(ticks.status, 200);
  assert.ok(ticks.body.items.length >= 1, 'سجل النبضات غير فارغ بعد انتظار محدود');
  const startup = ticks.body.items.find(x => x.reason === 'startup');
  assert.ok(startup, 'نبضة الإقلاع مسجلة');
  assert.equal(startup.ok, true, 'نبضة الإقلاع نجحت');
  assert.equal(startup.memoryRefreshed, true, 'ذاكرة الوكيل حُدّثت في النبضة');
});

/**
 * النبضة **الدورية** (interval) — الدليل الذي علّقه المدقق المستقل C:
 * «كل النبضات المرصودة startup؛ لا دليل على إطلاق نبضة interval واحدة».
 * العقد: المؤقت المسلَّح يعيد تسليح نفسه، فنبضة ثانية (بلا لمس أي شيء) تصل.
 * CORTEX_SCHED_MINUTES يقبل كسوراً (0.04د = 2.4ث) ليبقى الاختبار ثوانياً.
 */
test('النبضة الدورية تنطلق من تلقاء نفسها (interval بلا أي طلب)', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'cortex-interval-'));
  const port = 4900 + (process.pid % 90);
  const base = `http://127.0.0.1:${port}`;
  const child2 = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, APP_ROOT: root, APP_PORT: String(port), CORTEX_SCHED_MINUTES: '0.04' }
  });
  t.after(() => {
    try { child2.kill(); } catch {}
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/status'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  let intervalTick = null;
  for (let i = 0; i < 50 && !intervalTick; i++) {
    const r = await fetch(base + '/api/agent/ticks').then(x => x.json()).catch(() => null);
    intervalTick = (r?.items || []).find(x => x.reason === 'interval');
    if (!intervalTick) await new Promise(r2 => setTimeout(r2, 500));
  }
  assert.ok(intervalTick, 'نبضة interval انطلقت من تلقاء نفسها');
  assert.equal(intervalTick.ok, true, 'نبضة interval نجحت');
  const audit = readFileSync(path.join(root, 'data', 'audit.log'), 'utf8');
  assert.ok(audit.includes('"reason":"interval"'), 'نبضة interval مُدقَّقة');
});
