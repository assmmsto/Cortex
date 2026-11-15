#!/usr/bin/env node
/**
 * مشغّل حزمة الوحدات بملف-لكل-عملية.
 *
 * لماذا وُجد: تشغيل كل ملفات الاختبار في عملية node واحدة كان يسقط أحياناً
 * (٥ ملفات معاً ⇒ العملية تموت بعد ١٩ اختباراً بلا ملخّص، بينما كل ملف يمرّ
 * وحده ١٠٠٪ — حالة مشتركة بين خوادم الاختبار وقاعدة البيانات). العزل بعملية
 * لكل ملف يُلغي هذا التلوّث ويجعل الفشل منسوباً لملفه بلا لبس.
 *
 * الاستعمال: node tests/run-suite-files.cjs [--log path] [--only pattern]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const logArgIdx = process.argv.indexOf('--log');
const LOG = logArgIdx > -1 ? path.resolve(process.argv[logArgIdx + 1]) : path.join(os.tmpdir(), 'cortex-suite-files.log');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > -1 ? process.argv[onlyIdx + 1] : null;

const tmp = path.join(os.tmpdir(), 'cortex-test-roots');
try { fs.mkdirSync(tmp, { recursive: true }); } catch {}

const env = {
  ...process.env,
  AGENT_DAILY_WRITES: '100000',
  CORTEX_DAILY_FS: '100000',
  CORTEX_DAILY_VAULT: '100000',
  CORTEX_DAILY_EXEC: '100000',
  CORTEX_DAILY_IMPORT: '100000',
  CORTEX_TEST_MODE: '1',
  CORTEX_ALLOWED_ROOTS: [ROOT, os.tmpdir(), tmp].join(';'),
};

let files = fs.readdirSync(path.join(ROOT, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
if (ONLY) files = files.filter((f) => f.includes(ONLY));

const out = [];
let totalPass = 0;
let totalFail = 0;
const failedFiles = [];
const started = Date.now();

for (const file of files) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=300000', '--test-reporter=tap', path.join('tests', file)], {
    cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
  const text = `${res.stdout || ''}${res.stderr || ''}`;
  const pass = Number((text.match(/^# pass (\d+)/m) || [])[1] || 0);
  const fail = Number((text.match(/^# fail (\d+)/m) || [])[1] || 0);
  totalPass += pass; totalFail += fail;
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const clean = res.status === 0 && fail === 0;
  if (!clean) failedFiles.push(file);
  out.push(`\n===== ${file} — exit=${res.status} pass=${pass} fail=${fail} (${secs}s) =====\n${text}`);
  console.log(`${clean ? '✔' : '✖'} ${file}  pass=${pass} fail=${fail} (${secs}s)`);
}

const summary = [
  '',
  '──────── ملخّص حزمة الوحدات (ملف لكل عملية) ────────',
  `الملفات: ${files.length}`,
  `ناجح: ${totalPass}`,
  `فاشل: ${totalFail}`,
  `ملفات فيها فشل: ${failedFiles.length ? failedFiles.join(', ') : 'لا شيء'}`,
  `المدة: ${Math.round((Date.now() - started) / 1000)}s`,
  '',
].join('\n');

fs.writeFileSync(LOG, `${out.join('\n')}\n${summary}`, 'utf8');
console.log(summary);
console.log(`السجل الكامل: ${LOG}`);
process.exit(failedFiles.length ? 1 : 0);
