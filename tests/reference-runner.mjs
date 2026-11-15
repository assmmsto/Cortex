import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * مُشغّل الاختبار المرجعي — دستور المادة 41.
 *
 * node --test لا يدعم التشغيل المتداخل لـ node --test (قيد في Node نفسه)،
 * والاختبار 41/6 يتطلب تشغيل مجموعة الاختبارات كاملة والتحقق من نتائجها.
 * لذلك نُشغّله منفرداً خارج سياق الاختبارات ليتحقق التحقق الكامل.
 *
 * الاستخدام: node tests/reference-runner.mjs
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn(
  process.execPath,
  ['--test', path.join('tests', 'reference.test.mjs')],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env } }
);

child.on('exit', code => process.exit(code === null ? 1 : code));
child.on('error', err => {
  console.error('تعذّر تشغيل الاختبار المرجعي:', err.message);
  process.exit(1);
});
