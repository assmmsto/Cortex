import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLiveServer } from './_live-server.mjs';

const SRV = await startLiveServer({ autonomy: 'supervised' });
const { base } = SRV;
const H = () => SRV.headers();
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-prof-'));
try {
  const root = path.join(dir, 'bundle');
  await fsp.mkdir(root, { recursive: true });
  for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(root, `p-${String(i).padStart(3, '0')}.txt`), `P ${i}\n`, 'utf8');
  const t = Date.now();
  const rr = await fetch(base + '/api/import', { method: 'POST', headers: H(), body: JSON.stringify({ path: root }) }).then(x => x.json());
  console.log('bundle60', Date.now() - t, 'ms created', rr.created);
} finally { await fsp.rm(dir, { recursive: true, force: true }); await SRV.stop(); }
