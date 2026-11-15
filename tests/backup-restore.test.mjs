import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionToken } from './_session.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function waitFor(url, ms = 60000) {
  const start = Date.now();
  return (async () => {
    while (Date.now() - start < ms) {
      try { const r = await fetch(url); if (r.ok) return; } catch { /* لم يقلع بعد */ }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`Timeout waiting for ${url}`);
  })();
}

test('BACKUP-1: نسخة تُرى وتُستعاد فعلاً (تُرجع المحتوى المحذوف)', async (t) => {
  /* العطل الذي يمنعه (2026-11-15): createBackup موجودة، لكن لا قائمة ولا استعادة
     من الواجهة — أي نسخة بلا استعادة = طمأنينة بلا قدرة. */
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-bk-'));
  const port = 3991 + (process.pid % 200);
  const child = spawn('node', ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, APP_ROOT: root, APP_PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/ping`);
  const token = await sessionToken({ base });
  const h = { 'Content-Type': 'application/json', ...(token ? { 'X-Cortex-Session': token } : {}) };

  // 1) ملاحظة أصلية
  const created = await (await fetch(`${base}/api/notes`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ title: 'نسخة-اختبار', project: 'BK', content: 'محتوى أصلي لا يجب أن يضيع.' }),
  })).json();
  const id = created.note && created.note.id;
  assert.ok(id, 'أُنشئت الملاحظة');

  // 2) نسخة احتياطية
  const bk = await (await fetch(`${base}/api/backup`, { method: 'POST', headers: h, body: '{}' })).json();
  assert.ok(bk.fileName, `نسخة أُنشئت: ${JSON.stringify(bk).slice(0, 120)}`);

  const list = await (await fetch(`${base}/api/backups`, { headers: h })).json();
  assert.ok(list.count >= 1, 'القائمة تعرض النسخة');
  assert.ok(list.items.some((x) => x.name === bk.fileName), 'اسم النسخة مطابق');

  // 3) تعديل يمحو المحتوى الأصلي
  await fetch(`${base}/api/notes`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ id, title: 'نسخة-اختبار', project: 'BK', content: 'محتوى مُستبدل.' }),
  });
  const afterEdit = await (await fetch(`${base}/api/notes/${encodeURIComponent(id)}`, { headers: h })).json();
  assert.ok(String(JSON.stringify(afterEdit)).includes('مُستبدل'), 'التعديل وقع');

  // 4) استعادة
  const rest = await (await fetch(`${base}/api/backups/restore`, {
    method: 'POST', headers: h, body: JSON.stringify({ name: bk.fileName }),
  })).json();
  assert.equal(rest.ok, true, `الاستعادة نجحت: ${JSON.stringify(rest).slice(0, 160)}`);
  assert.ok(rest.written > 0, `ملفات مكتوبة: ${rest.written}`);
  assert.ok(rest.safety, 'نسخة أمان أُنشئت قبل الاستعادة');

  // 5) المحتوى الأصلي عاد
  const restored = await (await fetch(`${base}/api/notes/${encodeURIComponent(id)}`, { headers: h })).json();
  const text = JSON.stringify(restored);
  assert.ok(text.includes('أصلي'), 'المحتوى الأصلي استُعيد');
  assert.ok(!text.includes('مُستبدل'), 'التعديل لم يبقَ');
});
