'use strict';
/**
 * فحص جاهزية النشر العام — أداة دائمة (لا تحتاج تشغيل حزم الاختبار).
 *
 * الاستعمال:  node tools/oss-check.cjs
 *
 * لماذا وُجدت: قبل النشر اكتُشف أن تقريرَي تدقيق (كتبهما وكلاء) حملا **مفتاح
 * مزود حقيقياً** دخل الالتزامات، ولا شيء كان يمنع ذلك. هذه الأداة تجعل الجاهزية
 * قابلة للقياس والتكرار قبل أي `git push` عام: ملفات النشر · الحزمة · الأسرار ·
 * الخزنة · البيانات الحسّاسة · حالة الشجرة.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

let ok = 0;
let bad = 0;
const chk = (label, cond, detail = '') => {
  if (cond) { ok += 1; console.log('  ✔ ' + label + (detail ? ' — ' + detail : '')); }
  else { bad += 1; console.log('  ✖ ' + label + (detail ? ' — ' + detail : '')); }
};
const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { out: (r.stdout || '').trim(), code: r.status };
};

console.log('— ملفات النشر —');
for (const f of ['LICENSE', 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'SECURITY.md', '.editorconfig', '.gitignore', 'package.json', '.github/workflows/ci.yml']) {
  chk(f, fs.existsSync(path.join(ROOT, f)));
}

console.log('— الحزمة لا تحوي بيانات مستخدم —');
{
  // npm على ويندوز يحتاج shell لتنفيذ npm.cmd (EINVAL بلا shell منذ Node 20)
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status === 0 && r.stdout) {
    try {
      const files = JSON.parse(r.stdout)[0].files.map((x) => x.path);
      const banned = files.filter((x) => /^(vault|data|\.perch|node_modules|\.git)\//.test(x));
      chk('npm pack بلا vault/data/.perch', banned.length === 0, files.length + ' ملفاً' + (banned.length ? ' · تسرّب: ' + banned.slice(0, 4).join(',') : ''));
    } catch (e) { chk('npm pack (تحليل الخرج)', false, String(e.message).slice(0, 60)); }
  } else {
    chk('npm pack', false, String((r.stderr || r.error && r.error.message || '')).slice(0, 80));
  }
}

console.log('— أسرار في المتعقَّب —');
{
  const tracked = git(['ls-files']).out.split('\n').filter(Boolean);
  const secretish = tracked.filter((f) => /(^|\/)(\.env|session\.token|mcp\.token|audit\.key|\.keystore|settings\.json)$/.test(f) || /\.(pem|p12|key)$/.test(f));
  chk('لا ملف سرّي متعقّب', secretish.length === 0, secretish.slice(0, 4).join(',') || 'نظيف');

  const PATTERN = 'sk-[A-Za-z0-9]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}';
  const g = spawnSync('git', ['grep', '-l', '-I', '-E', PATTERN, '--', '.', ':(exclude)tests/*'], { encoding: 'utf8' });
  const hits = (g.stdout || '').trim();
  chk('لا مفاتيح حقيقية في المتعقَّب (خارج الاختبارات)', hits === '', hits ? hits.split('\n').slice(0, 4).join(', ') : 'نظيف');
}

console.log('— البيانات المحلية خارج git —');
{
  chk('vault/ غير متعقّب', git(['ls-files', 'vault']).out === '', (fs.existsSync(path.join(ROOT, 'vault')) ? fs.readdirSync(path.join(ROOT, 'vault')).filter((f) => f.endsWith('.md')).length + ' ملاحظة على القرص' : 'لا مجلد'));
  chk('data/ غير متعقّب', git(['ls-files', 'data']).out === '');
  const dirty = git(['status', '--short']).out.split('\n').filter(Boolean);
  chk('الشجرة نظيفة (لا عمل غير ملتزم)', dirty.length === 0, dirty.length ? dirty.length + ' ملفاً: ' + dirty.slice(0, 3).join(' · ') : 'نظيفة');
}

console.log('— المفتاح المُسرَّب سابقاً لم يعد في الشجرة —');
{
  const r = spawnSync('git', ['grep', '-l', '-E', 'sk-U', '--', '.'], { encoding: 'utf8' });
  chk('لا أثر لمفتاح sk-U في الشجرة العاملة', !(r.stdout || '').trim());
}

console.log(`\nFIN_oss ${ok} نجح · ${bad} فشل`);
process.exit(bad === 0 ? 0 : 1);