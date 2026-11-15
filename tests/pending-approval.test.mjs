/**
 * C4 — حارس المسودات: اعتماد مسودة واحدة لا يمحو غير المعتمدات.
 *
 * العطل المُثبت (2026-11-15، الخادم الحيّ): `server.js:2494` كان يحذف
 * `data/agent-pending.json` **بالكامل** بعد أي تنفيذ معتمد. القياس: مسودتان
 * معلّقتان ⇒ اعتماد الأولى ⇒ المتبقي **0** (المسودة الثانية محيت بلا اعتماد).
 * أي أن المستخدم يفقد عملاً لم يوافق عليه ولم يره.
 *
 * القاعدة: الملف يحمل ما لم يُبتّ فيه. المعتمد يُزال بالهوية (أداة+وسائط)،
 * وما لم يُعتمد يبقى — وإن أُعيد اعتماد نفسه فلا يبقى له أثر (idempotent).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PENDING = 'agent-pending.json';

async function seedPending(SRV, mutations) {
  const file = path.join(SRV.root, 'data', PENDING);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), mutations }, null, 2), 'utf8');
}
async function readPending(SRV) {
  try { return JSON.parse(fs.readFileSync(path.join(SRV.root, 'data', PENDING), 'utf8')).mutations || []; }
  catch { return []; }
}

test('C4 · اعتماد مسودة يزيل المعتمد فقط ويُبقي الباقي', async (t) => {
  const { startLiveServer } = await import('./_live-server.mjs');
  const SRV = await startLiveServer({ provider: 'mock', autonomy: 'supervised' });
  t.after(async () => { await SRV.stop(); });
  const H = SRV.headers();

  const approved = { tool: 'create_note', args: { title: 'معتمدة', type: 'note', content: '# معتمدة' }, summary: 'إنشاء "معتمدة"' };
  const other = { tool: 'project_absorb', args: { path: '.', project: 'غير-معتمد' }, summary: 'احتضان مشروع غير-معتمد' };
  await seedPending(SRV, [approved, other]);

  const res = await fetch(SRV.base + '/api/agent/execute', {
    method: 'POST', headers: H, body: JSON.stringify({ mutations: [approved] }),
  });
  assert.equal(res.status, 200, 'التنفيذ المعتمد ينجح');
  const out = await res.json();
  assert.equal(out.applied?.length, 1, 'المعتمد نُفِّذ فعلاً');

  const left = await readPending(SRV);
  assert.equal(left.length, 1, `المسودة غير المعتمدة يجب أن تبقى — المتبقي ${JSON.stringify(left.map(m => m.summary))}`);
  assert.equal(left[0].tool, 'project_absorb', 'الباقي هو غير المعتمد تحديداً');
});

test('C4 · إعادة اعتماد نفس المسودة لا تُبقي أثراً مكرراً', async (t) => {
  const { startLiveServer } = await import('./_live-server.mjs');
  const SRV = await startLiveServer({ provider: 'mock', autonomy: 'supervised' });
  t.after(async () => { await SRV.stop(); });
  const H = SRV.headers();

  const m = { tool: 'create_note', args: { title: 'مكررة', type: 'note', content: '# مكررة' }, summary: 'إنشاء "مكررة"' };
  await seedPending(SRV, [m]);
  await fetch(SRV.base + '/api/agent/execute', { method: 'POST', headers: H, body: JSON.stringify({ mutations: [m] }) });
  assert.equal((await readPending(SRV)).length, 0, 'المعتمد أُزيل');

  // إعادة التنفيذ لنفس المسودة: لا مسودات متبقية، ولا فشل
  const again = await fetch(SRV.base + '/api/agent/execute', { method: 'POST', headers: H, body: JSON.stringify({ mutations: [m] }) });
  assert.equal(again.status, 200, 'إعادة الاعتماد لا تفشل');
  assert.equal((await readPending(SRV)).length, 0, 'لا أثر مكرر يُعاد إدخاله للطابور');
});
