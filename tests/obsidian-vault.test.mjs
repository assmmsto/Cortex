import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

test('VAULT-1: خزنة Obsidian خارجية تُفتح كما هي — مجلدات، .obsidian متجاهل، تصادم أسماء', async (t) => {
  /* العطل الذي يمنعه هذا الاختبار (مقيس 2026-11-15): readNotes كانت تقرأ
     جذر vault فقط، فخزنة Obsidian بمجلداتها تبدو فارغة إلا من ملفات المستوى
     الأول. والمسار كان ثابتاً في <root>/vault فلا يمكن فتح خزنة قائمة. */
  const root = await mkdtemp(path.join(tmpdir(), 'cortex-vault-root-'));
  const vault = await mkdtemp(path.join(tmpdir(), 'cortex-obsidian-'));
  const port = 3983 + (process.pid % 300);

  await writeFile(path.join(vault, 'a.md'), '# A\n\nملاحظة في الجذر.\n', 'utf8');
  await mkdir(path.join(vault, 'sub', 'deep'), { recursive: true });
  await writeFile(path.join(vault, 'sub', 'a.md'), '# A2\n\nنفس الاسم في مجلد.\n', 'utf8');
  await writeFile(path.join(vault, 'sub', 'b.md'), '# B\n\n![[image.png]]\n', 'utf8');
  await writeFile(path.join(vault, 'sub', 'deep', 'c.md'), '# C\n\nعميق.\n', 'utf8');
  await mkdir(path.join(vault, '.obsidian'), { recursive: true });
  await writeFile(path.join(vault, '.obsidian', 'app.md'), '# يجب ألا يُقرأ\n', 'utf8');

  const child = spawn('node', ['server.js'], {
    cwd: projectDir,
    env: { ...process.env, APP_ROOT: root, APP_PORT: String(port), CORTEX_VAULT_DIR: vault },
    stdio: 'ignore',
  });
  t.after(() => child.kill());

  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/api/ping`);
  const token = await sessionToken({ base });
  const h = token ? { 'X-Cortex-Session': token } : {};

  const v = await (await fetch(`${base}/api/vault`, { headers: h })).json();
  assert.equal(v.ok, true, 'مسار الخزنة متاح');
  assert.equal(v.dir, path.resolve(vault), 'الخزنة الخارجية هي المستخدمة');
  assert.equal(v.source, 'env', 'المصدر: متغير البيئة');
  assert.equal(v.notes, 4, `أربع ملاحظات (بلا .obsidian): ${v.notes}`);
  assert.ok(v.nested >= 3, `ثلاث داخل مجلدات على الأقل: ${v.nested}`);
  assert.ok(v.folders >= 2, `مجلدان على الأقل: ${v.folders}`);
  assert.equal(v.attachments, 1, 'مرفق واحد مُستخرج');

  const list = await (await fetch(`${base}/api/notes`, { headers: h })).json();
  const ids = (list.notes || []).map((n) => n.id);
  assert.ok(ids.includes('a'), 'ملاحظة الجذر');
  assert.ok(ids.includes('b'), 'ملاحظة داخل مجلد');
  assert.ok(ids.includes('c'), 'ملاحظة عميقة');
  assert.ok(!ids.includes('app'), '.obsidian متجاهل');
  assert.equal(ids.filter((x) => x === 'a').length, 1, 'لا تكرار للمعرّف');
  assert.ok(ids.some((x) => x !== 'a' && x.endsWith('a')), 'الاسم المكرر أُعيد تسميته بمجلده');
});
