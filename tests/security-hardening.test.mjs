/**
 * تقوية الإطلاق المفتوح (2026-11-05): كانت الترويسات الأمنية غائبة تماماً،
 * وكان يمكن ربط الخادم على 0.0.0.0 بلا أي تحذير رغم أنه محلي بلا HTTPS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveServer, freePort } from './_live-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ترويسات الأمان موجودة على الصفحة والـ API', async (t) => {
  const srv = await startLiveServer();
  t.after(async () => { await srv.stop(); });

  for (const p of ['/', '/api/status']) {
    const r = await fetch(srv.base + p);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', `nosniff على ${p}`);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', `منع التأطير على ${p}`);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', `المرجع على ${p}`);
    const csp = r.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors 'none'/, `CSP على ${p}`);
    assert.match(csp, /default-src 'self'/, `CSP افتراضي على ${p}`);
  }
});

test('الربط على واجهة غير محلية مرفوض افتراضياً — محلي أولاً', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, APP_HOST: '0.0.0.0', APP_PORT: String(port), CORTEX_NO_WATCHDOG: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += String(d); });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 15000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 1, `يجب أن يرفض ويخرج بـ1 — خرج بـ ${code}`);
  assert.match(err, /CORTEX_ALLOW_REMOTE/, 'رسالة الرفض تشرح التجاوز الصريح');
});