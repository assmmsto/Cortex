import fsp from 'node:fs/promises';
import path from 'node:path';
import { startLiveServer } from './_live-server.mjs';

const SRV = await startLiveServer({ autonomy: 'supervised' });
const { base, root } = SRV;
const H = () => SRV.headers();
const post = (u, b) => fetch(base + u, { method: 'POST', headers: H(), body: JSON.stringify(b) });
try {
  // ملاحظة أساس
  const mk = await post('/api/notes', { title: 'Agent Probe', body: '# Agent Probe\n\nProject: Probe\n', project: 'Probe' }).then(r => r.json());
  const probeId = mk.note?.id || mk.id;
  console.log('noteId', probeId);
  await fsp.writeFile(path.join(root, 'data', 'settings.json'), JSON.stringify({
    ai: { provider: 'mock', model: '', temperature: 0.2 },
    agent: { defaultMode: 'project', autonomy: 'supervised' }, lang: 'ar',
  }, null, 1));

  const sse = await post('/api/agent/run', { goal: 'أضف مهمة "مهمة حوكمة تجريبية" لـ @omar', project: 'Probe', noteId: probeId }).then(r => r.text());
  const done = sse.split('\n\n').filter(c => c.startsWith('data:')).map(c => c.slice(5).trim()).filter(Boolean).map(s => JSON.parse(s)).find(m => m.type === 'agent_done');
  console.log('mutations', (done?.result?.mutations || []).length, 'pending', JSON.stringify(done?.result?.pending || [], null, 1).slice(0, 1200));

  const pend = await fetch(base + '/api/agent/pending', { headers: H() }).then(r => r.json());
  console.log('pendingList', JSON.stringify(pend.mutations || []).slice(0, 800));

  const ex = await post('/api/agent/execute', { mutations: pend.mutations, project: 'Probe' }).then(r => r.json());
  console.log('execute', JSON.stringify(ex).slice(0, 900));
  await new Promise(r => setTimeout(r, 1500));
  const after = await fetch(base + '/api/notes/' + probeId, { headers: H() }).then(r => r.json());
  console.log('BODY>>>', JSON.stringify(after.note?.body));
  const tasks = await fetch(base + '/api/tasks?project=Probe', { headers: H() }).then(r => r.json());
  console.log('tasks', JSON.stringify(tasks.tasks || []).slice(0, 600));
} finally { await SRV.stop(); }
