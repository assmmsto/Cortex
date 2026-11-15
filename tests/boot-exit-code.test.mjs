/**
 * C5 — حارس رمز الخروج: فشل الربط يجب أن يُبلَّغ كفشل (رمز ≠ 0).
 *
 * العطل المُثبت (2026-11-15): `server.on('error')` كان يستدعي `process.exit(0)`
 * عند EADDRINUSE — أي أن "المنفذ مشغول" يُبلَّغ للمشغّل كـ«نجاح». القياس:
 * `exitCode = 0` مع `EADDRINUSE` في السجل. النتيجة: `supervisor.bat` (يخرج من
 * الحلقة عند الرمز 0) لا يعيد المحاولة أبداً، وأي أداة تعتمد على الرمز ترى
 * خادماً "انتهى بسلام" وهو لم يُقلع.
 *
 * القاعدة: رمز 0 محفوظ للإنهاء المتعمد؛ تعارض المنفذ = فشل قابل لإعادة المحاولة
 * (رمز 2 صريح، لأن 1 قد يُلتبس بالقتل على ويندوز).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function blockedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('C5 · منفذ مشغول ⇒ رمز خروج فشل لا صفر', async (t) => {
  const { srv, port } = await blockedPort();
  t.after(() => new Promise((r) => srv.close(r)));
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-boot-'));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      APP_PORT: String(port),
      APP_ROOT: appRoot,
      CORTEX_NO_WATCHDOG: '1',
      CORTEX_TEST_MODE: '1',
      CORTEX_ALLOWED_ROOTS: [ROOT, os.tmpdir()].join(path.delimiter),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve('timeout'); }, 30000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });

  assert.notEqual(code, 'timeout', `الخادم لم ينتهِ خلال 30ث — المخرج: ${out.slice(-300)}`);
  assert.notEqual(code, 0, `فشل الربط يُبلَّغ كنجاح (الرمز 0) — يجب رمز فشل صريح. المخرج: ${out.slice(-300)}`);
  assert.match(out, /EADDRINUSE|already in use/i, 'سبب الفشل مذكور في المخرج');
});
