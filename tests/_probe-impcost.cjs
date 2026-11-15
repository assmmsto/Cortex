const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');
const fs = require('node:fs');
const imp = require(path.join(__dirname, '..', 'cortex-import.js'));

(async () => {
  const root = path.join(os.tmpdir(), 'cortex-profimp-' + Date.now());
  await fsp.mkdir(root, { recursive: true });
  for (let i = 0; i < 100; i++) await fsp.writeFile(path.join(root, `f-${String(i).padStart(3, '0')}.txt`), `T ${i}\n`);
  const t0 = Date.now();
  const out = await imp.importFolder({ path: root, allowedRoots: [root] });
  console.log('importFolder100', Date.now() - t0, 'ms scanned', out.scanned, 'ok', (out.perFile || []).filter(p => !p.error).length);
  // إحصاء النوع: 100 ملف صغير — القياس الثاني بلا كتابة قاعدة
  const t1 = Date.now();
  for (const f of fs.readdirSync(root).slice(0, 20)) {
    await imp.importFile({ path: path.join(root, f), allowedRoots: [root] });
  }
  console.log('importFile20', Date.now() - t1, 'ms');
  await fsp.rm(root, { recursive: true, force: true });
})();
