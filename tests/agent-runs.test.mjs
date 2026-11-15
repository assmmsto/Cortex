/**
 * التشغيل أوّل-درجة (خطة الاستوديو W1/W3/W5) — إثبات end-to-end على خادم معزول
 * بمزوّد نموذج مزيّف محلي (سكربتات محددة، بلا شبكة خارجية، CORTEX_ALLOW_LOCAL_URL=1):
 *
 *   ١) تشغيل مفرد يخلّف سجلاً دائماً: run_created → action → observation → approval_required → run_finished
 *      + المخرَج الأوّل-درجة: جواب >600 حرف يصير تقريراً في المعرفة (بطاقة artifact).
 *   ٢) المسودات: الكتابة في وضع الإشراف تُسجَّل مسودة، والاعتماد ينفّذ فعلاً ويظهر الأثر على القرص.
 *   ٣) الإلغاء حقيقي: طلبٌ أثناء انتظار النموذج يوقف الحلقة قبل الخطوة التالية —
 *      ولا يُستهلك نداء نموذج إضافي (يُقاس بعدّاد المزوّد).
 *   ٤) البث يتيح إعادة العرض من السجل (?since=) وينتهي بـ run_end عند الاكتمال.
 *   ٥) عقد الصلاحيات (W5): التعديل بلا confirm مرفوض 400، وبتأكيد يسري فعلاً — والسقوف تحكم السياسة.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── مزوّد مزيّف: يردّ بسكربت قابل للتبديل، وبطء اختياري لكل رد ── */
function startFakeProvider() {
  let script = [{ text: '{"done":true,"answer":"تم."}' }];
  let count = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const i = count++;
      const item = script[Math.min(i, script.length - 1)] || { text: '{}' };
      const text = typeof item.text === 'function' ? item.text() : item.text;
      if (item.delay) await sleep(item.delay);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion', model: 'scripted', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, setScript: (s) => { script = s; count = 0; }, getCount: () => count, close: () => server.close() });
    });
  });
}

const action = (name, args = {}) => JSON.stringify({ thought: 'خطوة ' + name, action: { name, args } });
const done = (answer) => JSON.stringify({ done: true, answer });

async function boot(port, tmp) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, APP_ROOT: tmp, APP_PORT: String(port), CORTEX_ALLOW_LOCAL_URL: '1' }
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/api/status'); if (r.ok) break; } catch { /* بعد */ }
    await sleep(250);
  }
  const tok = (await fetch(base + '/api/session', { headers: { 'Sec-Fetch-Site': 'same-origin' } }).then((r) => r.json())).token;
  return { child, base, H: { 'Content-Type': 'application/json', 'X-Cortex-Session': tok } };
}

/** يقرأ بث /api/agent/run كاملاً؛ onStarted(runId) عند run_started، وresolve بنتيجة agent_done */
async function runStream(base, H, goal, onStarted) {
  const res = await fetch(base + '/api/agent/run', { method: 'POST', headers: H, body: JSON.stringify({ goal }) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let result = null;
  for (;;) {
    const { done: d, value } = await reader.read(); if (d) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) {
      const s = ln.trim(); if (!s.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
      if (ev.type === 'run_started' && onStarted) onStarted(ev.runId);
      if (ev.type === 'agent_done') result = ev.result;
    }
  }
  return result;
}

test('التشغيل أول-درجة: سجل دائم + مسودة اعتماد + مخرَج تقرير + إلغاء حقيقي + البث + العقد', async (t) => {
  const fake = await startFakeProvider();
  const tmp = mkdtempSync(path.join(tmpdir(), 'cortex-runs-'));
  const port = 4810 + (process.pid % 80);
  const { child, base, H } = await boot(port, tmp);
  t.after(() => {
    try { child.kill(); } catch { /* بعد */ }
    try { fake.close(); } catch { /* بعد */ }
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ }
  });
  // إعدادات المزوّد المزيّف في الجذر المعزول
  const settingsFile = path.join(tmp, 'data', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.ai = { provider: 'openai-compatible', model: 'scripted', baseUrl: `http://127.0.0.1:${fake.port}/v1`, openaiBaseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'test', temperature: 0.1 };
  settings.agent = { ...(settings.agent || {}), autonomy: 'supervised', language: 'ar' };
  const fsMod = await import('node:fs');
  fsMod.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  /* ── ١+٢: تشغيل يكتب مسودةً، والاعتماد ينفّذ، والجواب الطويل يصير تقريراً ── */
  fake.setScript([
    { text: action('create_note', { title: 'run-note', content: '# مسودة من وكيل\n\nمحتوى' }) },
    { text: done('أنشأت الملاحظة كمسودة. ' + 'تفاصيل '.repeat(110)) }
  ]);
  let runId = '';
  const out1 = await runStream(base, H, 'أنشئ ملاحظة run-note', (id) => { if (!runId) runId = id; });
  assert.ok(runId, 'run_started يحمل runId');
  assert.ok(out1 && !out1.error, 'التشغيل نجح: ' + JSON.stringify(out1 && out1.error));
  assert.ok(out1.artifact && out1.artifact.noteId, 'المخرَج الأوّل-درجة: تقرير حُفظ في المعرفة');
  assert.ok(out1.artifact.chars > 600, 'طول المخرَج > 600');
  assert.ok(out1.sessionId, 'ربط تلقائي بجلسة خيط');

  const got = await fetch(base + '/api/agent/runs/' + runId).then((r) => r.json());
  const types = got.events.map((e) => e.type);
  for (const want of ['run_created', 'action', 'observation', 'approval_required', 'run_finished']) {
    assert.ok(types.includes(want), `السجل الدائم يحمل ${want} — الموجود: ${types.join(',')}`);
  }
  const finEv = got.events.find((e) => e.type === 'run_finished');
  assert.equal(finEv.payload.artifact.noteId, out1.artifact.noteId, 'المخرَج مُسجَّل في حدث الختام');

  const pend = await fetch(base + '/api/agent/pending').then((r) => r.json());
  assert.equal((pend.mutations || []).length, 1, 'المسودة معلقة بانتظار الاعتماد');
  const exec = await fetch(base + '/api/agent/execute', { method: 'POST', headers: H, body: JSON.stringify({ mutations: pend.mutations }) }).then((r) => r.json());
  assert.equal(exec.applied.length, 1, 'الاعتماد نفّذ المسودة فعلاً');
  const notes = await fetch(base + '/api/notes').then((r) => r.json());
  const noteIds = (notes.notes || []).map((n) => n.id);
  assert.ok(noteIds.includes('run-note'), 'الملاحظة المعتمدة ظهرت في الخزنة');
  assert.ok(noteIds.includes(out1.artifact.noteId), 'التقرير موجود في الخزنة');

  /* ── ٣: الإلغاء حقيقي — يوقف قبل الخطوة التالية بلا نداء نموذج إضافي ── */
  fake.setScript([
    { text: action('get_note', { id: 'welcome' }), delay: 2500 },
    { text: done('يجب ألا تصل أبداً') } // حارس: لو استُدعي دلّ على أن الإلغاء لم يوقف
  ]);
  let rid2 = '';
  const runP = runStream(base, H, 'اقرأ الملاحظة الترحيبية', (id) => { if (!rid2) rid2 = id; });
  await sleep(900); // الإلغاء أثناء انتظار رد النموذج الأول
  const canc = await fetch(base + '/api/agent/cancel', { method: 'POST', headers: H, body: JSON.stringify({ runId: rid2 }) }).then((r) => r.json());
  assert.ok(canc.ok, 'طلب الإلغاء قُبل');
  const out2 = await runP;
  assert.equal(out2.cancelled, true, 'النتيجة موسومة cancelled');
  assert.equal(fake.getCount(), 1, `نداء واحد فقط للمزوّد (وُجد ${fake.getCount()}) — الحلقة توقفت قبل الخطوة التالية`);
  const got2 = await fetch(base + '/api/agent/runs/' + rid2).then((r) => r.json());
  const types2 = got2.events.map((e) => e.type);
  assert.ok(types2.includes('cancel_requested') && types2.includes('run_cancelled'), 'الإلغاء مُدوَّن: ' + types2.join(','));
  assert.equal(got2.summary.terminal, 'run_cancelled', 'الحالة الختامية cancelled');

  /* ── ٤: البث يعيد من السجل وينتهي بـ run_end ── */
  const sres = await fetch(base + '/api/agent/runs/stream?runId=' + runId + '&since=0');
  const sreader = sres.body.getReader(); const sdec = new TextDecoder(); let sbuf = ''; const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const { done: d, value } = await sreader.read(); if (d) break;
    sbuf += sdec.decode(value, { stream: true });
    const lines = sbuf.split('\n'); sbuf = lines.pop();
    for (const ln of lines) {
      if (!ln.startsWith('data:')) continue;
      try { const ev = JSON.parse(ln.slice(5).trim()); seen.push(ev.type); } catch { /* سطر جزئي */ }
    }
    if (seen.includes('run_end')) break;
  }
  assert.ok(seen.includes('run_event') && seen.includes('run_end'), 'البث يعيد الأحداث ثم يُغلق بـ run_end');

  /* ── ٥: عقد الصلاحيات — تأكيد إلزامي وسقوف تسري ── */
  const con = await fetch(base + '/api/agent/contract').then((r) => r.json());
  assert.ok(Object.keys(con.roles || {}).length >= 6, 'الأدوار الستة معروضة');
  assert.ok(con.limits && typeof con.limits.vault === 'number', 'السقوف معروضة');
  const noConfirm = await fetch(base + '/api/agent/contract-update', { method: 'POST', headers: H, body: JSON.stringify({ autonomy: 'autonomous' }) });
  assert.equal(noConfirm.status, 400, 'تعديل بلا تأكيد مرفوض');
  const withConfirm = await fetch(base + '/api/agent/contract-update', { method: 'POST', headers: H, body: JSON.stringify({ confirm: true, autonomy: 'assisted', limits: { vault: 3 } }) }).then((r) => r.json());
  assert.ok(withConfirm.ok, 'التعديل بتأكيد نجح');
  const con2 = await fetch(base + '/api/agent/contract').then((r) => r.json());
  assert.equal(con2.autonomy, 'assisted', 'الاستقلالية تبدّلت فعلاً');
  assert.equal(con2.limits.vault, 3, 'سقف vault تبدّل فعلاً');
  // الوحدة: السياسة تحترم السقف المُمرَّر
  const policy = require('../cortex-policy.js');
  const v = policy.evaluate({ tool: 'create_note', level: 'execute', scope: 'vault', allowedScopes: ['vault'], autonomy: 'autonomous', dailyUsed: { vault: 3 }, caps: { vault: 3 } });
  assert.equal(v.decision, 'refuse', 'السياسة ترفض عند بلوغ السقف المضبوط: ' + v.reason);
});
