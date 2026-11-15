import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLiveServer } from './_live-server.mjs';

const SRV = await startLiveServer({ autonomy: 'supervised' });
const { base } = SRV;
const H = () => SRV.headers();
const post = (u, b) => fetch(base + u, { method: 'POST', headers: H(), body: JSON.stringify(b) });
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-perf-'));
try {
  // ملف واحد: ٣ مرات متتالية — يكشف تضخّم التكلفة مع نمو المخزن
  for (let i = 0; i < 3; i++) {
    const p = path.join(dir, `one-${i}.txt`);
    await fsp.writeFile(p, `PERF ONE ${i}\n`, 'utf8');
    const t0 = Date.now();
    const r = await post('/api/import', { path: p }).then(x => x.json());
    console.log(`single#${i}`, Date.now() - t0, 'ms', r.created ?? r.error);
  }
  // حزمة 120 ملفاً
  const root = path.join(dir, 'bundle');
  await fsp.mkdir(root, { recursive: true });
  for (let i = 0; i < 120; i++) await fsp.writeFile(path.join(root, `b-${String(i).padStart(3, '0')}.txt`), `B ${i}\n`, 'utf8');
  const t1 = Date.now();
  const rr = await post('/api/import', { path: root }).then(x => x.json());
  console.log('bundle120', Date.now() - t1, 'ms', 'scanned', rr.scanned, 'created', rr.created, 'skipped', rr.skipped);
  // حزمة ثانية 120 مختلفة — هل التكلفة تتبع عدد الملفات أم حجم المخزن؟
  const root2 = path.join(dir, 'bundle2');
  await fsp.mkdir(root2, { recursive: true });
  for (let i = 0; i < 120; i++) await fsp.writeFile(path.join(root2, `c-${String(i).padStart(3, '0')}.txt`), `C ${i}\n`, 'utf8');
  const t2 = Date.now();
  const r2 = await post('/api/import', { path: root2 }).then(x => x.json());
  console.log('bundle120b', Date.now() - t2, 'ms', 'created', r2.created, 'skipped', r2.skipped);
} finally { await fsp.rm(dir, { recursive: true, force: true }); await SRV.stop(); }
