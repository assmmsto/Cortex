/**
 * الإدارة الذاتية (خطة الاستوديو W4): الوكيل يفهم أوامر الإدارة من الجملة —
 * يعرض جدوله، يضيف مهمة مجدولة، ويحذفها — والتنفيذ كله عبر مسودات الاعتماد
 * (alwaysDraft في السياسة)، على خادم معزول بمزوّد مزيّف محلي.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, setScript: (s) => { script = s; count = 0; }, close: () => server.close() })));
}

const action = (name, args = {}) => JSON.stringify({ action: { name, args } });
const done = (answer) => JSON.stringify({ done: true, answer });

async function runStream(base, H, goal) {
  const res = await fetch(base + '/api/agent/run', { method: 'POST', headers: H, body: JSON.stringify({ goal }) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let result = null;
  for (;;) {
    const { done: d, value } = await reader.read(); if (d) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const ln of lines) {
      const s = ln.trim(); if (!s.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
      if (ev.type === 'agent_done') result = ev.result;
    }
  }
  return result;
}
async function approveAll(base, H) {
  const pend = await fetch(base + '/api/agent/pending').then((r) => r.json());
  const muts = pend.mutations || [];
  if (!muts.length) return { applied: [], failed: [] };
  return fetch(base + '/api/agent/execute', { method: 'POST', headers: H, body: JSON.stringify({ mutations: muts }) }).then((r) => r.json());
}

test('الإدارة الذاتية: عرض الجدولة، إضافة مهمة بالجملة عبر مسودة، ثم حذفها', async (t) => {
  const fake = await startFakeProvider();
  const tmp = mkdtempSync(path.join(tmpdir(), 'cortex-sched-tools-'));
  const port = 4910 + (process.pid % 70);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, APP_ROOT: tmp, APP_PORT: String(port), CORTEX_ALLOW_LOCAL_URL: '1' } });
  t.after(() => {
    try { child.kill(); } catch { /* بعد */ }
    try { fake.close(); } catch { /* بعد */ }
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* بعد */ }
  });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(base + '/api/status'); if (r.ok) break; } catch { /* بعد */ } await sleep(250); }
  const tok = (await fetch(base + '/api/session', { headers: { 'Sec-Fetch-Site': 'same-origin' } }).then((r) => r.json())).token;
  const H = { 'Content-Type': 'application/json', 'X-Cortex-Session': tok };
  const settingsFile = path.join(tmp, 'data', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.ai = { provider: 'openai-compatible', model: 'scripted', baseUrl: `http://127.0.0.1:${fake.port}/v1`, openaiBaseUrl: `http://127.0.0.1:${fake.port}/v1`, apiKey: 'test', temperature: 0.1 };
  settings.agent = { ...(settings.agent || {}), autonomy: 'supervised' };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));

  /* ١) «ما جدولتي؟» — قراءة فورية بلا مسودة */
  fake.setScript([{ text: action('schedule_list') }, { text: done('عرضت الجدولة') }]);
  const out1 = await runStream(base, H, 'ما مهامي المجدولة الآن؟');
  assert.ok(out1 && !out1.error, 'تشغيل العرض نجح');
  const pend1 = await fetch(base + '/api/agent/pending').then((r) => r.json());
  assert.equal((pend1.mutations || []).length, 0, 'القراءة لا تخلّف مسودة');

  /* ٢) «كل يوم راجع مهامي» — تُسجَّل مسودة، والاعتماد ينشئ المهمة فعلاً */
  fake.setScript([{ text: action('schedule_add', { goal: 'راجع مهامي المفتوحة', every_hours: 24 }) }, { text: done('أضفت المهمة كمسودة') }]);
  const out2 = await runStream(base, H, 'جدول مهمة كل 24 ساعة: راجع مهامي المفتوحة');
  assert.ok(out2 && !out2.error, 'تشغيل الإضافة نجح');
  const appr = await approveAll(base, H);
  assert.equal(appr.applied.length, 1, 'المسودة اعتُمدت ونُفّذت');
  const sch1 = await fetch(base + '/api/agent/schedule').then((r) => r.json());
  assert.equal(sch1.tasks.length, 1, 'المهمة المجدولة أُنشئت فعلاً');
  assert.equal(sch1.tasks[0].goal, 'راجع مهامي المفتوحة', 'الهدف مطابق');
  const audit = readFileSync(path.join(tmp, 'data', 'audit.log'), 'utf8');
  assert.ok(audit.includes('agent_schedule_added'), 'الإنشاء مُدوَّن في التدقيق');

  /* ٣) «احذف مهمة الفحص» — بالجملة: مسودة، اعتماد، ثم حذف فعلي */
  const taskId = sch1.tasks[0].id;
  fake.setScript([{ text: () => action('schedule_remove', { id: taskId }) }, { text: done('حذفت المهمة كمسودة') }]);
  const out3 = await runStream(base, H, 'احذف مهمة الفحص المجدولة');
  assert.ok(out3 && !out3.error, 'تشغيل الحذف نجح: ' + JSON.stringify({ err: out3 && out3.error, ans: out3 && String(out3.answer || '').slice(0, 120), steps: out3 && (out3.steps || []).map((s) => s.tool) }));
  const appr3 = await approveAll(base, H);
  assert.equal(appr3.applied.length, 1, 'مسودة الحذف اعتُمدت');
  const sch2 = await fetch(base + '/api/agent/schedule').then((r) => r.json());
  assert.equal(sch2.tasks.length, 0, 'المهمة حُذفت فعلاً بالجملة');
});
