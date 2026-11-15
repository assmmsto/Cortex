/**
 * C3 — حارس صدق حالة التشغيل: تشغيلٌ انتهى وقد **سجّل كل كتاباته مسودات**
 * لم يُنفَّذ منه شيء، فلا يُعلن `ok:true` بلا موافقة خارجية.
 *
 * العطل المُثبت حياً: `runScheduledTask` (server.js:4659) كان يُنهي التشغيل
 * بـ`run_finished {ok:true}` دون فحص `out.pending` — وتشغيلاتٌ حقيقية في القاعدة
 * (`run-1794600072969`, `run-1794692777125`) تحمل ok:true ونتيجتها "queued:
 * مسودة بانتظار موافقتك". أي أن الدفتر يقول «نجح» والفعل لم يحدث.
 *
 * القاعدة: النجاح يحتاج عقدةً حقيقية — mutations>0 أو pending==0 أو لا أثر مطلوب.
 * وما دام كل شيء مسودة: الحالة `awaiting_approval` لا `ok:true`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();

/** يقلع خادماً معزولاً على جذر مؤقت (لا لمس لبيانات المنتج). */
async function bootServer() {
  const { startLiveServer } = await import('./_live-server.mjs');
  return startLiveServer({ provider: 'mock', autonomy: 'supervised' });
}

test('C3 · تشغيل全网ي مسودات لا يُعلن ok:true (awaiting_approval)', async (t) => {
  const SRV = await bootServer();
  t.after(async () => { await SRV.stop(); });
  const headers = SRV.headers();

  // مهمة جزئية هدفها يدفع الوكيل لكتابة (mock ينفّذ create_note بمسودة في supervised)
  // الهدف يطابق نمط mockRun الحقيقي (append_tasks) — أداة كتابة تُسجَّل مسودة في supervised
  const add = await fetch(SRV.base + '/api/agent/schedule', {
    method: 'POST', headers, body: JSON.stringify({ action: 'add', goal: 'أضف مهمة "مراجعة خطة الإطلاق" لـ@lead', every_hours: 1 }),
  });
  assert.equal(add.status, 200, 'إضافة المهمة');
  const addJson = await add.json();
  const taskId = addJson.task?.id;
  assert.ok(taskId, `المهمة أُنشئت — الرد: ${JSON.stringify(addJson).slice(0, 200)}`);
  const listed = await (await fetch(SRV.base + '/api/agent/schedule', { headers })).json();
  assert.ok((listed.tasks || []).some(x => x.id === taskId), 'المهمة تظهر في قائمة المجدول');

  const run = await fetch(SRV.base + '/api/agent/schedule', {
    method: 'POST', headers, body: JSON.stringify({ action: 'run-now', id: taskId }),
  });
  assert.equal(run.status, 200, 'تشغيل الآن');
  const body = await run.json();
  const r = body.run || {};
  assert.ok(Number(r.pending || 0) > 0, `المتوقع مسودة معلّقة، القياس: pending=${r.pending} mutations=${r.mutations} answer="${String(r.answer || '').slice(0, 80)}"`);
  assert.equal(r.ok, false, 'المسودات غير المعتمدة ليست نجاحاً');
  assert.equal(r.outcome, 'awaiting_approval', `النتيجة الصريحة يجب أن تكون awaiting_approval، القياس: ${r.outcome}`);

  // والدفتر: الحدث الختامي لا يقول ok:true
  const runs = await (await fetch(SRV.base + '/api/agent/runs?limit=10', { headers })).json();
  const mine = (runs.runs || []).find(x => x.runId === r.runId);
  assert.ok(mine, 'التشغيل يظهر في الدفتر');
  assert.notEqual(mine.terminal, null, 'التشغيل مختوم');
});
