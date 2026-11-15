import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLiveServer } from './_live-server.mjs';

const SRV = await startLiveServer({ autonomy: 'supervised' });
const { base } = SRV;
const H = () => SRV.headers();
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-prof2-'));
const times = [];
try {
  for (let i = 0; i < 60; i++) {
    const t = Date.now();
    const r = await fetch(base + '/api/notes', {
      method: 'POST', headers: H(),
      body: JSON.stringify({ title: `note ${i} ${Date.now()}`, content: `# n${i}\n`, project: 'Prof' }),
    });
    if (r.status >= 400) { console.log('ERR', r.status, (await r.text()).slice(0, 200)); break; }
    times.push(Date.now() - t);
  }
  const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  console.log('first5', times.slice(0, 5), 'avg', avg(times.slice(0, 5)));
  console.log('last5', times.slice(-5), 'avg', avg(times.slice(-5)));
  console.log('total', times.reduce((a, b) => a + b, 0), 'ms for', times.length);
} finally { await fsp.rm(dir, { recursive: true, force: true }); await SRV.stop(); }
