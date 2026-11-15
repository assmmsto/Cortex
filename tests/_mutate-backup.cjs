// أداة إثبات حساسية دائمة: تُبدّل VACUUM INTO بنسخ ملف ساذج ثم تُعيد الأصل.
// الاستعمال: node tests/_mutate-backup.cjs on|off
const fs = require('fs');
const path = require('path');
const target = path.join(__dirname, '..', 'cortex-core.js');
const bak = path.join(__dirname, '..', 'cortex-core.js.orig-bak');
const GOOD = "snapDb.prepare('VACUUM INTO ?').run(tmpDb);";
const BAD = 'fs.copyFileSync(liveDb, tmpDb);';

const mode = process.argv[2];
let src = fs.readFileSync(target, 'utf8');

if (mode === 'on') {
  if (!fs.existsSync(bak)) fs.writeFileSync(bak, src);
  if (!src.includes(GOOD)) { console.error('لم أجد نمط VACUUM INTO — الحساسية غير قابلة للإثبات'); process.exit(3); }
  fs.writeFileSync(target, src.replace(GOOD, BAD));
  console.log('MUTATED: copyFileSync بدل VACUUM INTO');
} else if (mode === 'off') {
  if (src.includes(BAD) && !src.includes(GOOD) && fs.existsSync(bak)) {
    fs.writeFileSync(target, fs.readFileSync(bak, 'utf8'));
    fs.rmSync(bak, { force: true });
    console.log('RESTORED من النسخة الأصلية');
  } else {
    if (fs.existsSync(bak)) fs.rmSync(bak, { force: true });
    console.log('RESTORED: الأصل سليم أصلاً (VACUUM INTO موجود)');
  }
} else {
  console.error('استعمل on|off');
  process.exit(2);
}
