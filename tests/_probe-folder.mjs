import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLiveServer } from './_live-server.mjs';

const SRV = await startLiveServer({ autonomy: 'supervised' });
try {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cortex-folder-'));
  await fsp.writeFile(path.join(dir, 'a.md'), '# A\n\nx\n', 'utf8');
  await fsp.writeFile(path.join(dir, 'b.txt'), 'b\n', 'utf8');
  await fsp.mkdir(path.join(dir, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'sub', 'c.md'), '# C\n\ny\n', 'utf8');
  const r = await fetch(SRV.base + '/api/import', { method: 'POST', headers: SRV.headers(), body: JSON.stringify({ path: dir }) });
  const j = await r.json();
  console.log('STATUS', r.status);
  console.log('KEYS', Object.keys(j));
  console.log('folder', j.folder, 'scanned', j.scanned, 'created', j.created, 'root', j.root);
  console.log('perFile', JSON.stringify((j.perFile || []).slice(0, 5), null, 1));
  await fsp.rm(dir, { recursive: true, force: true });
} finally { await SRV.stop(); }
