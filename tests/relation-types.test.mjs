/**
 * حارس أنواع العلاقات — يمنع رجوع «4 أنواع فقط من 9 دستورية».
 *
 * العطل الأصلي (مؤكد حياً): `cortex-core.js:26` كان يملك مجموعة محلية
 * `new Set(['contains','references','parent_project','wikilink'])` — فأنواع §7
 * التسعة (depends_on, contradicts, risks, …) تُرفض بـ 400 رغم تعريفها في المخطط.
 *
 * عزل مُصلَح (2026-10-27): كان الاختبار يشتغل على الخادم الحي (3737) بأصله
 * الحقيقي — فتتسرّب ملاحظات rel-type-a/b إلى خزنة المستخدم (قيس فعلياً: 16
 * ملاحظة متراكمة). الآن كل تشغيل يحصل على APP_ROOT مؤقت ومنفذ مشتق من PID،
 * فلا ترى العين الحية أي أثر — والعقد (الأنواع التسعة مقبولة والمخترع مرفوض) هو نفسه.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sessionToken } from './_session.mjs';

const ROOT = process.cwd();
const PORT = 4100 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;

let child = null;
let tmpRoot = null;
async function boot() {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'cortex-reltypes-'));
  process.env.CORTEX_BASE = BASE; // رمز الجلسة يُقرأ من نفس الخادم المعزول
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, APP_ROOT: tmpRoot, APP_PORT: String(PORT) }
  });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/status'); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('الخادم المعزول لم يستجب');
}

async function post(p, body) {
  const headers = { 'Content-Type': 'application/json' };
  const tok = await sessionToken({ base: BASE }).catch(() => null);
  if (tok) headers['X-Cortex-Session'] = tok;
  const r = await fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.text() };
}

// أنواع §7 التسعة نصاً من cortex-schema
const CONSTITUTIONAL = ['depends_on', 'derives_from', 'resulted_in', 'responsible_for', 'belongs_to', 'contradicts', 'risks', 'tested_by', 'affected_by'];
// الأنواع القديمة تبقى صالحة (توافق خلفي)
const LEGACY = ['contains', 'references', 'parent_project', 'wikilink'];

test('العلاقات — الأنواع التسعة الدستورية مقبولة (على خادم معزول)', async (t) => {
  await boot();
  t.after(() => {
    try { if (child) child.kill(); } catch {}
    try { if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  });

  const a = 'rel-type-a-' + Date.now();
  const b = 'rel-type-b-' + Date.now();
  await post('/api/notes', { id: a, title: 'عنصر أ', content: 'محتوى اختبار الأنواع', type: 'note' });
  await post('/api/notes', { id: b, title: 'عنصر ب', content: 'محتوى اختبار الأنواع', type: 'note' });

  const rejected = [];
  for (const kind of [...CONSTITUTIONAL, ...LEGACY]) {
    const r = await post('/api/links', { source: a, target: b, type: kind });
    if (r.status >= 400) rejected.push(`${kind} → ${r.status}`);
  }
  assert.deepEqual(rejected, [], 'أنواع مرفوضة: ' + rejected.join(', '));

  // الأنواع الدستورية تحديداً — لا يكفي أن الأنواع القديمة تعمل
  const constitutionalOk = [];
  for (const kind of CONSTITUTIONAL) {
    const r = await post('/api/links', { source: a, target: b, type: kind });
    if (r.status < 400) constitutionalOk.push(kind);
  }
  assert.equal(constitutionalOk.length, CONSTITUTIONAL.length,
    'أنواع دستورية ناجحة ' + constitutionalOk.length + '/' + CONSTITUTIONAL.length);

  // نوع مخترع يجب أن يُرفض (الحارس ليس فضفاضاً)
  const junk = await post('/api/links', { source: a, target: b, type: 'totally_made_up_kind' });
  assert.ok(junk.status >= 400, 'نوع مخترع يجب أن يُرفض: ' + junk.status);

  // برهان العزل نفسه: الخزنة الحية على المنفذ 3737 (إن كانت تعمل) لا تحتوي هذين العنصرين
  const live = await fetch('http://127.0.0.1:3737/api/notes').then(r => r.json()).catch(() => null);
  if (live && Array.isArray(live.notes)) {
    const leaked = live.notes.some(n => n.id === a || n.id === b);
    assert.equal(leaked, false, 'عزل مكسور: ملاحظات الاختبار تسربت للخزنة الحية');
  }
});
