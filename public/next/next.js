/* ═══════════════════════════════════════════════════════════════
   Cortex Next (N1) — واجهة حية بجانب الكلاسيكية.
   المبادئ: كلمات لا أيقونات · اللغة تحكي ما يحدث فعلاً · لا تغيير صامت ·
   كل إدراج محتوى عبر textContent (لا حقن HTML) · الوصول الكامل عبر /api الفعلي.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

/* ── بناء DOM بأمان ── */
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};
const $ = (id) => document.getElementById(id);
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node; };

/* ── جلسة الخادم والاتصال ── */
let TOKEN = '';
async function ensureToken() {
  if (TOKEN) return TOKEN;
  try {
    const r = await fetch('/api/session');
    const j = await r.json();
    TOKEN = (j && j.token) || '';
  } catch { TOKEN = ''; }
  return TOKEN;
}
async function apiGet(path) {
  await ensureToken();
  const r = await fetch(path, { headers: TOKEN ? { 'X-Cortex-Session': TOKEN } : {} , credentials: 'same-origin' });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: 'رد غير متوقع' }; }
}
async function apiPost(path, body) {
  await ensureToken();
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
    credentials: 'same-origin',
    body: JSON.stringify(body || {})
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { error: 'رد غير متوقع' }; }
}

/* ── صياغات بشرية ── */
function relTime(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'قبل لحظات';
  if (m < 60) return 'قبل ' + m + ' دقيقة';
  const h = Math.floor(m / 60);
  if (h < 24) return 'قبل ' + h + ' ساعة';
  const d = Math.floor(h / 24);
  return d === 1 ? 'أمس' : 'قبل ' + d + ' أيام';
}
/* اسم الأداة → جملة يفهمها الإنسان */
const TOOL_AR = {
  search_notes: 'يبحث في معرفتك', get_note: 'يقرأ عنصراً من معرفتك', list_tasks: 'يتفقّد المهام',
  project_state: 'يراجع حالة المشروع', find_gaps: 'يفحص الفجوات', find_contradictions: 'يفحص التعارضات',
  summarize_document: 'يلخّص مستنداً', extract_meeting_actions: 'يستخرج عناصر تنفيذية',
  resolve_reference: 'يحل مرجعاً غامضاً', suggest_links: 'يقترح روابط', use_skill: 'يحمل مهارة تشغيلية',
  create_note: 'يجهّز عنصراً جديداً', append_tasks: 'يجهّز مهاماً', append_section: 'يكتب قسماً',
  link_note: 'يجهّز ربطاً', living_note: 'يحدّث لوحة الحالة الحية', runs_list: 'يتفقّد تشغيلاته',
  budget_report: 'يراجع ميزانية اليوم', schedule_list: 'يتفقّد جدوله', schedule_add: 'يجهّز مهمة مجدولة',
  schedule_toggle: 'يعدّل مهمة مجدولة', schedule_remove: 'يجهّز إزالة مهمة', run_cancel: 'يجهّز إيقاف تشغيل',
  find_gaps2: 'يفحص الفجوات', repo_index: 'يفهرس المشروع فيقرأ بنيته', repo_tree: 'يستعرض شجرة المشروع',
  repo_deps: 'يحلل علاقات الملفات — من يعتمد على من', repo_impact: 'يتتبع أثر التغيير',
  git_status: 'يتفقّد حالة المستودع', git_log: 'يقرأ سجل المستودع', git_diff: 'يفحص الفروقات',
  fs_list: 'يستعرض مجلداً', fs_read: 'يقرأ ملفاً', fs_stat: 'يفحص ملفاً', fs_search: 'يبحث داخل الملفات',
  fs_write: 'يجهّز كتابة ملف', fs_edit: 'يجهّز تعديل ملف', fs_mkdir: 'يجهّز إنشاء مجلد',
  shell_exec: 'يجهّز أمراً في بيئة محصورة', run_tests: 'يشغّل الاختبارات', read_test_result: 'يقرأ نتيجة الاختبارات',
  project_absorb: 'يحتضن المشروع: يمسح الملفات ويبني خريطته', memory_slice: 'يجلب سياق الملف وارتباطاته',
  project_trail: 'يراجع مسير العمل على المشروع', trail_append: 'يسجّل خطوة في المسير',
  import_file: 'يجهّز استيراداً', import_repo: 'يجهّز استيراد مستودع'
};
const toolAr = (t) => TOOL_AR[t] || ('يشغّل خطوة: ' + t);

/* ── الترويسة الحية ── */
let currentRunId = null;
function setStatus(kind, em, rest) {
  const dot = $('stt-dot'), e = $('status-em'), r = $('status-rest');
  if (dot) { dot.classList.toggle('busy', kind === 'busy'); dot.style.background = kind === 'bad' ? 'var(--bad)' : (kind === 'busy' ? '' : 'var(--ok)'); }
  if (e) e.textContent = em;
  if (r) r.textContent = rest ? (' ' + rest) : '';
}
async function refreshHeader() {
  const [active, runs, pending] = await Promise.all([
    apiGet('/api/agent/runs/active').catch(() => null),
    apiGet('/api/agent/runs').catch(() => null),
    apiGet('/api/agent/pending').catch(() => null)
  ]);
  const act = (active && Array.isArray(active.active)) ? active.active : [];
  const rec = (runs && Array.isArray(runs.recent)) ? runs.recent : [];
  const pn = (pending && Array.isArray(pending.mutations)) ? pending.mutations.length : 0;
  const chip = $('approvals-chip');
  if (chip) { chip.classList.toggle('hidden', pn === 0); const n = $('approvals-n'); if (n) n.textContent = String(pn); }
  if (currentRunId) return; // حلقة نشطة في هذه الصفحة — لا نزاحمها
  if (act.length) {
    const g = String(act[0].goal || '').slice(0, 60);
    setStatus('busy', 'أعمل الآن على:', g);
  } else if (rec.length) {
    const last = rec[0];
    const auto = last.trigger === 'schedule';
    setStatus('idle', 'متفرّغ —', 'آخر عمل ' + relTime(last.lastAt || last.startedAt) + (auto ? ' (تلقائي)' : ''));
  } else {
    setStatus('idle', 'متفرّغ —', 'لم أعمل بعد');
  }
}

/* ── التوجيه بين الشاشات ── */
function goView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
  const v = $('v-' + name);
  if (v) v.classList.add('on');
  document.querySelectorAll('.nv').forEach(b => b.classList.toggle('on', b.getAttribute('data-view') === name));
  if (name === 'projects') loadProjects();
  if (name === 'knowledge') loadKnowledge();
  if (name === 'abroad') loadAbroad();
}
document.querySelectorAll('.nv').forEach(b => b.addEventListener('click', () => goView(b.getAttribute('data-view'))));
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    goView(goto.getAttribute('data-goto'));
    const fill = goto.getAttribute('data-fill');
    if (fill) { const inp = $('goal-input'); if (inp) { inp.value = fill; inp.focus(); } }
  }
});

/* ═══════════════ الوكيل — المحادثة الحية ═══════════════ */
const feed = () => $('feed');
function feedBottom() { const f = feed(); if (f) f.scrollTop = f.scrollHeight; }

function addSay(text) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'who', 'أنت'));
  wrap.appendChild(el('div', 'said', text));
  feed().appendChild(wrap); feedBottom();
  return wrap;
}
function addAgentBlock() {
  const wrap = el('div');
  wrap.appendChild(el('div', 'who agent', 'كورتكس'));
  feed().appendChild(wrap); feedBottom();
  return wrap;
}
function addStep(host, label) {
  const prev = host.querySelector('.step.now');
  if (prev) { prev.classList.remove('now'); prev.classList.add('done'); }
  const row = el('div', 'step now');
  row.appendChild(el('span', 'dt'));
  row.appendChild(el('span', null, label));
  host.appendChild(row); feedBottom();
  return row;
}
function finishStep(host, ok) {
  const now = host.querySelector('.step.now');
  if (now) { now.classList.remove('now'); now.classList.add(ok ? 'done' : 'done'); if (!ok) now.querySelector('.dt').style.background = 'var(--bad)'; }
}
function addSourceRows(host, sources) {
  if (!sources || !sources.length) return;
  const box = el('div', 'card');
  box.appendChild(el('div', 't', 'أحدث ما اطّلعت عليه'));
  box.appendChild(el('div', 'ss muted small', 'عيّنة مما قرأت في هذه الخطوة — لا القائمة كاملة.'));
  sources.slice(0, 6).forEach(s => {
    const row = el('div', 'src-row');
    if (s.file) {
      row.appendChild(el('span', null, '📄 ملف: ' + String(s.file).replace(/\\/g, '/').split('/').slice(-2).join('/')));
      const lk = el('button', 'lk', 'افتح الملف');
      lk.onclick = () => openFileDrawer(s.file);
      row.appendChild(lk);
    } else {
      row.appendChild(el('span', null, '🧠 ' + (s.title || s.id || '')));
      const lk = el('button', 'lk', 'اقرأ العنصر');
      lk.onclick = () => openNoteDrawer(s.id);
      row.appendChild(lk);
    }
    box.appendChild(row);
  });
  host.appendChild(box); feedBottom();
}
function addDecisionCard(host, pending) {
  const box = el('div', 'ask');
  box.appendChild(el('div', 't', 'أحتاج إذنك — لم أنفّذ بعد'));
  box.appendChild(el('div', null, 'جهّزت ' + pending.length + ' تغيير ينتظر موافقتك. لن أكتب شيئاً قبل قرارك:'));
  const ul = el('ul');
  pending.forEach(m => {
    const what = (m.tool === 'create_note') ? ('إنشاء عنصر: ' + String((m.args || {}).title || ''))
      : (m.tool === 'fs_write' || m.tool === 'fs_edit') ? ((m.tool === 'fs_write' ? 'كتابة ملف: ' : 'تعديل ملف: ') + String((m.args || {}).path || ''))
      : (m.tool === 'append_tasks') ? ('إضافة مهام إلى: ' + String((m.args || {}).noteId || ''))
      : (toolAr(m.tool));
    ul.appendChild(el('li', null, what));
  });
  box.appendChild(ul);
  const row = el('div', 'row');
  const ok = el('button', 'btn pri', 'اعتمد واكتبها في معرفتي');
  const no = el('button', 'btn quiet', 'ارفض');
  const note = el('span', 'muted small');
  ok.onclick = async () => {
    ok.disabled = true; no.disabled = true;
    const r = await apiPost('/api/agent/execute', { mutations: pending });
    note.textContent = (r && r.applied && r.applied.length) ? ('✓ نُفّذ: ' + r.applied.length) : ('تعذّر: ' + ((r && r.error) || 'راجع السجل'));
    ok.classList.add('hidden'); no.classList.add('hidden');
    refreshHeader();
  };
  no.onclick = async () => {
    ok.disabled = true; no.disabled = true;
    await apiPost('/api/agent/pending/reject', {});
    note.textContent = 'ارفضتها — لم أكتب شيئاً.';
    ok.classList.add('hidden'); no.classList.add('hidden');
    refreshHeader();
  };
  row.appendChild(ok); row.appendChild(no); row.appendChild(note);
  box.appendChild(row);
  host.appendChild(box); feedBottom();
}

let sending = false;
async function sendGoal() {
  if (sending) return;
  const inp = $('goal-input');
  const goal = (inp && inp.value || '').trim();
  if (!goal) return;
  if (inp) inp.value = '';
  sending = true;
  const send = $('send-btn'); if (send) send.disabled = true;
  addSay(goal);
  const host = addAgentBlock();
  const stepsBox = el('div', 'steps');
  host.appendChild(stepsBox);
  setStatus('busy', 'أعمل الآن على:', goal.slice(0, 60));
  let hadError = null;
  try {
    const res = await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(TOKEN ? { 'X-Cortex-Session': TOKEN } : {}) },
      credentials: 'same-origin',
      body: JSON.stringify({ goal })
    });
    if (!res.ok || !res.body) throw new Error('تعذّر الاتصال (' + res.status + ')');
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = ''; let doneEv = null;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const ln of lines) {
        const s = ln.trim(); if (!s.startsWith('data:')) continue;
        let ev; try { ev = JSON.parse(s.slice(5).trim()); } catch { continue; }
        if (ev.type === 'run_started' && ev.runId) {
          currentRunId = ev.runId;
          const stop = el('button', 'btn quiet sm', 'أوقف العمل');
          stop.onclick = async () => { await apiPost('/api/agent/cancel', { runId: ev.runId }); stop.disabled = true; stop.textContent = 'أبلغته — سيتوقف عند الخطوة التالية'; };
          const row = el('div', 'row'); row.appendChild(stop); host.appendChild(row);
        } else if (ev.type === 'agent_step' && ev.step) {
          const st = ev.step;
          finishStep(stepsBox, !(st.result && st.result.error));
          addStep(stepsBox, toolAr(st.tool) + (st.result && st.result.error ? ' — تعذّر: ' + String(st.result.error).slice(0, 70) : ''));
        } else if (ev.type === 'agent_done') {
          doneEv = ev.result || {};
        }
      }
      if (doneEv) break;
    }
    finishStep(stepsBox, true);
    if (!doneEv) throw new Error('انقطع البث قبل النتيجة');
    if (doneEv.error) hadError = String(doneEv.error);
    if (doneEv.cancelled) {
      const w = el('div', 'card'); w.appendChild(el('div', 't', 'أوقفت العمل بطلبك — لم أكتب شيئاً بقي معلقاً.'));
      host.appendChild(w);
    } else if (hadError) {
      const w = el('div', 'card err-card');
      w.appendChild(el('div', 't', 'تعذّر إكمال المهمة'));
      w.appendChild(el('div', 'small', hadError.slice(0, 300)));
      host.appendChild(w);
    } else {
      const ans = String(doneEv.answer || '').trim();
      if (ans) host.appendChild(el('div', 'reply', ans));
      addSourceRows(host, doneEv.sources);
      if (doneEv.pending && doneEv.pending.length) addDecisionCard(host, doneEv.pending);
      if (doneEv.artifact && doneEv.artifact.noteId) {
        const box = el('div', 'card result');
        box.appendChild(el('span', 'badge', 'النتيجة'));
        const a = el('div', 't', 'حفظت الناتج الكامل في معرفتك');
        box.appendChild(a);
        const lk = el('button', 'btn quiet sm', 'افتح الناتج');
        lk.onclick = () => openNoteDrawer(doneEv.artifact.noteId);
        const row = el('div', 'row'); row.appendChild(lk);
        box.appendChild(row);
        host.appendChild(box);
      }
    }
  } catch (e) {
    if (stepsBox) finishStep(stepsBox, false);
    const w = el('div', 'card err-card');
    w.appendChild(el('div', 't', 'تعذّر إكمال المهمة'));
    w.appendChild(el('div', 'small', String(e.message || e).slice(0, 300)));
    host.appendChild(w);
  } finally {
    currentRunId = null;
    sending = false;
    if (send) send.disabled = false;
    feedBottom();
    refreshHeader();
    loadAbroad(); // يحدّث سجل «في غيابي» وعدّاده فور انتهاء أي تشغيل — لا انتظار تحديث دوري
  }
}
$('send-btn').addEventListener('click', sendGoal);
$('goal-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGoal(); } });
document.querySelectorAll('#examples .btn').forEach(b => b.addEventListener('click', () => {
  const inp = $('goal-input'); if (inp) { inp.value = b.getAttribute('data-goal') || ''; inp.focus(); }
}));

/* ═══════════════ في غيابي ═══════════════ */
async function loadAbroad() {
  const host = clear($('abroad-body'));
  const sub = $('abroad-sub');
  const runs = await apiGet('/api/agent/runs');
  const rec = (runs && Array.isArray(runs.recent)) ? runs.recent : [];
  const hint = $('abroad-hint'); if (hint) hint.textContent = rec.length ? ('(' + rec.length + ')') : '';
  if (!rec.length) {
    if (sub) sub.textContent = 'لم أعمل وحدي بعد — عندما تشغّل مهام مجدولة أو تشغيلات، ستجدها هنا بأزمنتها ونتائجها.';
    const b = el('div', 'empty-block'); b.appendChild(el('h2', null, 'سجلّي فارغ الآن'));
    b.appendChild(el('p', null, 'كل تشغيل — من المحادثة أو تلقائياً — يترك أثراً هنا، بلغة واضحة لا سجلات تقنية.'));
    host.appendChild(b);
    return;
  }
  if (sub) sub.textContent = 'آخر ' + rec.length + ' تشغيل — الأحدث أولاً.';
  let lastDay = '';
  rec.forEach(r => {
    const at = r.lastAt || r.startedAt;
    const day = at ? new Date(at).toLocaleDateString('ar', { weekday: 'long', day: 'numeric', month: 'long' }) : '—';
    if (day !== lastDay) { lastDay = day; host.appendChild(el('div', 'day', day)); }
    const row = el('div', 'entry');
    row.appendChild(el('span', 'tm', at ? new Date(at).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }) : '—'));
    const tx = el('div', 'tx');
    const term = String(r.terminal || '');
    const okRun = term === 'run_finished';
    const goal = String(r.goal || '').slice(0, 90);
    const auto = r.trigger === 'schedule' ? 'تلقائياً: ' : 'بطلبك: ';
    tx.appendChild(el('span', null, auto + goal));
    tx.appendChild(el('span', okRun ? 'ok-tag' : 'bad-tag', okRun ? ' — أنجز' : (term === 'run_failed' ? ' — تعثّر' : ' — ' + (term || '…'))));
    tx.appendChild(el('span', 'muted small', ' · ' + relTime(at) + (okRun && r.artifacts ? '' : '')));
    row.appendChild(tx);
    host.appendChild(row);
  });
}

/* ═══════════════ المشاريع ═══════════════ */
async function loadProjects() {
  const grid = clear($('projects-grid'));
  const empty = $('projects-empty');
  const maps = await apiGet('/api/projects/maps');
  const list = (maps && Array.isArray(maps.maps)) ? maps.maps : [];
  if (empty) empty.classList.toggle('hidden', list.length > 0);
  list.forEach(m => {
    const b = el('button', 'pcard');
    b.type = 'button';
    b.appendChild(el('span', 'n', m.project || m.id));
    b.appendChild(el('span', 'm'));
    b.lastChild.appendChild(el('b', null, String(m.files || 0) + ' ملفاً'));
    b.appendChild(el('span', 'm', 'آخر احتضان: ' + relTime(m.absorbedAt)));
    b.appendChild(el('span', 'm', m.path || ''));
    b.onclick = () => openProject(m);
    grid.appendChild(b);
  });
}
async function openProject(m) {
  goView('project');
  const name = m.project || m.id;
  $('proj-name').textContent = name;
  const body = clear($('proj-body'));
  const facts = $('proj-facts'); if (facts) facts.textContent = '';
  $('proj-ask').onclick = () => {
    goView('agent');
    const inp = $('goal-input');
    if (inp) { inp.value = 'في مشروع ' + name + ': '; inp.focus(); }
  };
  body.appendChild(el('div', 'vsub', 'أقرأ الخريطة ومسير العمل…'));
  const [map, trail] = await Promise.all([
    apiGet('/api/project/map?project=' + encodeURIComponent(name)),
    apiGet('/api/project/trail?project=' + encodeURIComponent(name) + '&limit=12')
  ]);
  clear(body);
  if (!map || map.error) { body.appendChild(el('div', 'card err-card', (map && map.error) || 'لا خريطة لهذا المشروع.')); return; }
  const c = map.counts || {};
  if (facts) facts.textContent = String(c.files || 0) + ' ملفاً · ' + String(c.internalEdges || 0) + ' علاقة · آخر احتضان ' + relTime(map.absorbedAt);

  const s1 = el('div', 'sect');
  s1.appendChild(el('h3', null, 'ما أعرفه عنه'));
  s1.appendChild(el('div', 'ss', 'من مسح فعلي للملفات — خرائط لا نسخ.'));
  const sum = el('div', 'line-row');
  sum.appendChild(el('span', null, 'كود: ' + (c.code || 0) + ' · اختبارات: ' + (c.tests || 0) + ' · مستندات: ' + (c.docs || 0)));
  s1.appendChild(sum);
  if ((map.entryPoints || []).length) {
    const ep = el('div', 'line-row');
    ep.appendChild(el('span', null, 'نقاط الدخول: '));
    (map.entryPoints || []).slice(0, 6).forEach(p => ep.appendChild(el('span', 'key mono', p)));
    s1.appendChild(ep);
  }
  if ((map.warnings || []).length) {
    (map.warnings || []).forEach(w => s1.appendChild(el('div', 'line-row warn', '⚠ ' + w)));
  }
  body.appendChild(s1);

  if ((map.topFiles || []).length) {
    const s2 = el('div', 'sect');
    s2.appendChild(el('h3', null, 'أهم ملفاته — ومن يعتمد على من'));
    s2.appendChild(el('div', 'ss', 'العلاقات من الاستيرادات الفعلية في الكود، لا تخمين.'));
    (map.topFiles || []).slice(0, 12).forEach(f => {
      const row = el('div', 'line-row');
      row.appendChild(el('span', 'mono', f.path));
      const role = { entry: 'نقطة دخول', test: 'اختبار', doc: 'وثيقة', config: 'إعداد', module: 'وحدة' }[f.type] || 'وحدة';
      row.appendChild(el('span', 'key', role));
      row.appendChild(el('span', 'muted small', 'يعتمد عليه: ' + (f.inbound || 0) + ' · يعتمد على: ' + (f.outbound || 0)));
      s2.appendChild(row);
    });
    body.appendChild(s2);
  }

  if (map.changes) {
    const s3 = el('div', 'sect');
    s3.appendChild(el('h3', null, 'ما تغيّر منذ آخر احتضان'));
    const row = el('div', 'line-row');
    row.appendChild(el('span', null, 'الملفات: ' + (map.changes.filesBefore ?? '—') + ' ← ' + (map.changes.filesAfter ?? '—') + ' · العلاقات: ' + (map.changes.edgesBefore ?? '—') + ' ← ' + (map.changes.edgesAfter ?? '—')));
    s3.appendChild(row);
    if ((map.changes.added || []).length) s3.appendChild(el('div', 'line-row', '+ دخلت أهم الملفات: ' + map.changes.added.join('، ')));
    if ((map.changes.removed || []).length) s3.appendChild(el('div', 'line-row', '− خرجت: ' + map.changes.removed.join('، ')));
    body.appendChild(s3);
  }

  const s4 = el('div', 'sect');
  s4.appendChild(el('h3', null, 'ما جرى عليه — مسير العمل'));
  const entries = (trail && Array.isArray(trail.entries)) ? trail.entries : [];
  if (!entries.length) {
    s4.appendChild(el('div', 'line-row', 'لا خطوات مسجّلة بعد — أي عمل على هذا المشروع سيُسجَّل هنا تلقائياً.'));
  } else {
    entries.slice(0, 10).forEach(e => {
      const row = el('div', 'line-row');
      row.appendChild(el('span', 'when', relTime(e.at)));
      row.appendChild(el('span', null, String(e.text || '').slice(0, 130)));
      row.appendChild(el('span', 'muted small', ' · ' + (e.source || '') ));
      s4.appendChild(row);
    });
  }
  body.appendChild(s4);
}
$('proj-back').addEventListener('click', () => goView('projects'));

/* ═══════════════ المعرفة ═══════════════ */
let KN = [];
async function loadKnowledge() {
  const list = clear($('kn-list'));
  list.appendChild(el('div', 'muted small', 'أقرأ معرفتك…'));
  const j = await apiGet('/api/notes');
  KN = (j && Array.isArray(j.notes)) ? j.notes : [];
  renderKnowledge('');
  const hint = $('kn-hint'); if (hint) hint.textContent = '(' + KN.length + ')';
}
function renderKnowledge(q) {
  const list = clear($('kn-list'));
  const query = String(q || '').trim().toLowerCase();
  const items = query
    ? KN.filter(n => (String(n.title || '') + ' ' + String(n.body || '')).toLowerCase().includes(query))
    : KN;
  const cnt = $('kn-count');
  if (cnt) cnt.textContent = items.length + ' من ' + KN.length + ' عنصراً' + (query ? (' — بحث: ' + q) : '');
  if (!items.length) {
    list.appendChild(el('div', 'empty-block', query ? 'لا نتيجة بهذا البحث.' : 'لا عناصر بعد — استورد من الواجهة الكلاسيكية «إضافة مصدر»، أو اطلب مني في المحادثة.'));
    return;
  }
  [...items].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 200).forEach(n => {
    const row = el('button', 'krow');
    row.type = 'button';
    row.appendChild(el('span', 'tt', n.title || n.id));
    row.appendChild(el('span', 'ty', n.classification && n.classification.primaryType || 'note'));
    row.appendChild(el('span', 'pj', (n.projectName || '') + ' · ' + relTime(n.updatedAt)));
    row.onclick = () => openNoteDrawer(n.id);
    list.appendChild(row);
  });
}
$('kn-search').addEventListener('input', (e) => renderKnowledge(e.target.value));
$('kn-refresh').addEventListener('click', () => loadKnowledge());

/* ═══════════════ لوح العرض (عنصر/ملف) ═══════════════ */
async function openNoteDrawer(id) {
  if (!id) return;
  const v = $('veil'); v.classList.add('on');
  $('dr-title').textContent = '…';
  clear($('dr-meta')); $('dr-body').textContent = 'أفتح العنصر…';
  const j = await apiGet('/api/notes/' + encodeURIComponent(id));
  const n = j && j.note;
  if (!n) { $('dr-title').textContent = 'تعذّر'; $('dr-body').textContent = (j && j.error) || 'لم أجده.'; return; }
  $('dr-title').textContent = n.title || n.id;
  const meta = $('dr-meta');
  meta.appendChild(el('span', null, 'النوع: ' + ((n.classification && n.classification.primaryType) || 'note')));
  if (n.projectName) meta.appendChild(el('span', null, 'المشروع: ' + n.projectName));
  meta.appendChild(el('span', null, 'آخر تحديث: ' + relTime(n.updatedAt)));
  $('dr-body').textContent = String(n.body || n.content || '');
}
async function openFileDrawer(path) {
  if (!path) return;
  const v = $('veil'); v.classList.add('on');
  $('dr-title').textContent = String(path).replace(/\\/g, '/').split('/').slice(-2).join('/');
  clear($('dr-meta')); $('dr-meta').appendChild(el('span', 'mono', path));
  $('dr-body').textContent = 'أفتح الملف…';
  const j = await apiGet('/api/file?path=' + encodeURIComponent(path));
  if (j && j.ok) { $('dr-body').textContent = String(j.content || '') + (j.truncated ? '\n\n… (اقتُطع عند سقف العرض)' : ''); }
  else { $('dr-body').textContent = '⚠ ' + ((j && j.error) || 'تعذّر فتح الملف'); }
}
$('dr-x').addEventListener('click', () => $('veil').classList.remove('on'));
$('veil').addEventListener('click', (e) => { if (e.target === $('veil')) $('veil').classList.remove('on'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('veil').classList.remove('on'); });

/* ═══════════════ مركز التشغيل — بوابة القدرات كاملة (لا دفن) ═══════════════ */
const OPS = [
  { t: 'الخريطة التفاعلية', d: 'خريطة الترابط بين كل عناصرك — تكبير وسحب وجيران.', badge: 'على الكلاسيكية الآن · تُنقل لاحقاً', url: '/?view=graph' },
  { t: 'مزودو الذكاء والتكلفة', d: 'من يفكّر: النماذج، القدرات المفحوصة، الأسعار المعلَنة، الاختيار الآلي.', badge: 'على الكلاسيكية الآن · تُنقل لاحقاً', url: '/?view=providers' },
  { t: 'المصادر والتعلّم', d: 'الاستيراد بكل صيغه (56): ملفات ومجلدات ومستودعات وصفحات وصور.', badge: 'على الكلاسيكية الآن · تُنقل لاحقاً', url: '/?view=import' },
  { t: 'المستودعات والملفات', d: 'فهرسة المشاريع، تحليل الاعتماديات، تتبع الأثر، وفتح أي ملف للقراءة.', badge: 'على الكلاسيكية الآن · تُنقل لاحقاً', url: '/?view=repos' },
  { t: 'الأدوات والوصلات', d: 'خوادم MCP الداخلية والخارجية، والمهارات التشغيلية.', badge: 'على الكلاسيكية الآن · تُنقل لاحقاً', url: '/?view=tools' },
  { t: 'حماية وسجلات', d: 'المراقبة والحُكم والتدقيق والحجر والتراجع والنسخ — كل ضمانات النظام.', badge: 'على الكلاسيكية الآن · تُنقل لاحقاً', url: '/?view=governance' },
  { t: 'مراقبة التشغيلات', d: 'أحكام الجودة على كل تشغيل: الاكتمال، الأثر، الادعاءات المتحققة.', badge: 'على الكلاسيكية الآن · تُنقل لاحقاً', url: '/?view=monitor' },
  { t: 'جلسات الوكيل', d: 'أرشيف محادثاتك معي — يعود إليه وقتما تشاء.', badge: 'على الكلاسيكية الآن · تُنقل لاحقاً', url: '/' },
  { t: 'البحث الشامل', d: 'ابحث في كل شيء باختصار ⌘K من الواجهة الكلاسيكية.', badge: 'على الكلاسيكية الآن', url: '/' },
];
(function buildOps() {
  const grid = $('ops-grid');
  if (!grid) return;
  OPS.forEach(o => {
    const c = el('div', 'cap');
    c.appendChild(el('h3', null, o.t));
    c.appendChild(el('p', null, o.d));
    if (o.badge) c.appendChild(el('span', 'badge-soft', o.badge));
    const a = el('a', 'btn go', 'افتح في الواجهة الكلاسيكية ←');
    a.href = o.url;
    c.appendChild(a);
    grid.appendChild(c);
  });
})();

/* ── الإقلاع ── */
(async () => {
  await ensureToken();
  refreshHeader();
  loadKnowledge();            // ليملأ عدّاد المعرفة
  loadAbroad();               // ليملأ عدّاد في غيابي
  setInterval(refreshHeader, 8000);
})();
