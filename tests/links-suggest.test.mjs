/**
 * الربط الذكي — عقد §7 (لا علاقة بلا مصدر وثقة وزمن) على خادم معزول:
 *  1) /api/links/suggest يقترح من تشابه فعلي (تقاطع مصطلحات) بلا أي كتابة.
 *  2) /api/links/approve يكتب في note_links مع origin/confidence/evidence.
 *  3) /api/confidence يعيد العلاقة بأصلها وثقتها (قراءة العقد لا الادعاء).
 *  4) نوع علاقة مخترع يُرفض 400، وعنصر مفقود 404.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionToken } from './_session.mjs';

const ROOT = process.cwd();
const PORT = 4950 + (process.pid % 40);
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

test('الربط الذكي: اقتراح من تشابه فعلي ثم اعتماد بمصدر وثقة (§7)', async t => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cortex-links-'));
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

  // ثلاث ملاحظات: اثنتان تتشاركان مصطلحات أمنية، وواحدة لا صلة لها
  await call('POST', '/api/notes', { id: 'sec-a', title: 'أمن المنصة', content: 'توثيق الجلسات وتشفير المفاتيح ومراجعة الصلاحيات على البوابة.' });
  await call('POST', '/api/notes', { id: 'sec-b', title: 'صلاحيات الوصول', content: 'مراجعة الصلاحيات وتشفير المفاتيح وضبط الجلسات في الإنتاج.' });
  await call('POST', '/api/notes', { id: 'cake', title: 'وصفة كعك', content: 'دقيق وسكر وزبدة وحرارة الفرن مئة وثمانون.' });

  // 1) الاقتراح: sec-b وارد من تشابه فعلي، وcake غائب، وبلا كتابة
  const sug = await call('GET', '/api/links/suggest?noteId=sec-a');
  assert.equal(sug.status, 200, JSON.stringify(sug.body));
  assert.equal(sug.body.noteId, 'sec-a');
  const targets = sug.body.suggestions.map(s => s.target);
  assert.ok(targets.includes('sec-b'), `sec-b ضمن الاقتراحات — وُجد: ${targets.join(', ')}`);
  assert.ok(!targets.includes('cake'), 'العنصر غير المتصل لم يُقترح');
  const cand = sug.body.suggestions.find(s => s.target === 'sec-b');
  assert.ok(cand.confidence > 0 && cand.confidence <= 1, 'ثقة المشتقة في نطاق معقول');
  assert.ok(cand.reason && cand.reason.length > 10, 'لكل اقتراح علة مفهومة');
  assert.equal(cand.kind, 'references');

  // 2) الاعتماد: يكتب في note_links بمصدر وثقة وزمن (addRelation يعيد ok+source+target+origin…)
  const appr = await call('POST', '/api/links/approve', { source: 'sec-a', target: 'sec-b', kind: 'references', confidence: 0.5, reason: 'تقاطع مصطلحات أمنية' });
  assert.equal(appr.status, 200, JSON.stringify(appr.body));
  assert.equal(appr.body.ok, true, 'العلاقة أُضيفت فعلاً');
  assert.equal(appr.body.origin, 'agent-suggest-approved', 'الأصل محفوظ من البوابة نفسها');

  // 3) قراءة العقد: /api/confidence يعيد الأصل والثقة
  const conf = await call('GET', '/api/confidence?id=sec-a');
  assert.equal(conf.status, 200);
  const rel = (conf.body.outgoing || []).find(r => r.target === 'sec-b');
  assert.ok(rel, `العلاقة ظاهرة في القراءة — outgoing: ${JSON.stringify(conf.body.outgoing).slice(0, 200)}`);
  assert.equal(rel.kind, 'references');
  assert.equal(rel.origin, 'agent-suggest-approved');
  assert.ok(Number(rel.confidence) === 0.5, 'الثقة المعتمدة محفوظة');
  assert.ok(rel.extractedAt, 'زمن الاستخراج محفوظ');
  assert.ok(rel.evidence && String(rel.evidence).includes('approvedBy'), 'دليل الاعتماد محفوظ');

  // 4) الحدود: نوع مخترع مرفوض، عنصر مفقود 404
  const badKind = await call('POST', '/api/links/approve', { source: 'sec-a', target: 'sec-b', kind: 'totally_made_up_kind' });
  assert.equal(badKind.status, 400, 'نوع مخترع مرفوض');
  const missing = await call('POST', '/api/links/approve', { source: 'sec-a', target: 'ghost' });
  assert.equal(missing.status, 404, 'عنصر مفقود = 404');

  // 5) بعد الاعتماد، sec-b لم يعد ضمن اقتراحات sec-a (لا تكرار عرض)
  const sug2 = await call('GET', '/api/links/suggest?noteId=sec-a');
  assert.ok(!sug2.body.suggestions.map(s => s.target).includes('sec-b'), 'المعتمد لا يُقترح مجدداً');
});
