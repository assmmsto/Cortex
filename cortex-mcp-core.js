'use strict';
/* نواة MCP الموحّدة — نفس المعالجات لكل المنافذ (2026-10-30).
   العطل الذي أُغلق: المنطق كان يعيش داخل غلاف stdio وحده (mcp-memory-server.js)، فأي
   منفذ ثانٍ (HTTP /mcp في server.js) كان سيستدعي نسخة ثانية تتقادم. الآن: المنطق هنا
   مرة واحدة، والغلافان للنقل فقط. الدوال تبني كائن الرد وتعيده — لا ترسله — وكل
   غلاف يُرسل بطريقته (Content-Length للـstdio، JSON للـHTTP).
   المصادر: cortex-mcp-tools.js لقائمة الأدوات (مصدر واحد)، وcore/projectMemory
   الحقيقيان يُمرَّران من الغلاف. */
const { MCP_TOOLS: TOOLS } = require('./cortex-mcp-tools');

const VERSION = '5.0.0';

function createMcpCore({ core, projectMemory }) {
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const err = (id, message, code = -32000) => ({ jsonrpc: '2.0', id, error: { code, message } });
  const textContent = (text) => [{ type: 'text', text: String(text) }];
  const noteLine = (n, verbose = false) => {
    const tags = (n.fm?.tags || []).join(', ') || 'none';
    const line = `[${n.id}] ${n.title} · type:${n.classification?.primaryType || n.fm?.type || 'note'} · project:${n.projectName || '—'} · tags:${tags} · updated:${n.updatedAt.slice(0, 10)}`;
    return verbose ? `${line}\n${n.body.trim()}` : line;
  };

  /* أدوات الكتابة (2026-11-15): الوضع الافتراضي للوكلاء الخارجيين **قراءة فقط**.
     القاعدة: من لا يملك الخزنة لا يعدّلها بلا إذن صريح — يُفعّل من الإعدادات. */
  const WRITE_TOOLS = new Set([
    'memory_upsert_note', 'memory_delete_note', 'memory_rebuild_index',
    'agent_start_session', 'agent_capture_message', 'agent_update_living_note',
    'project_absorb', 'memory_record',
  ]);
  async function handle(message, opts = {}) {
    const { id, method, params } = message;
    const readOnly = opts && opts.readOnly === true;
    try {
      if (method === 'initialize') return ok(id, { protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'cortex-memory', version: VERSION } });
      if (method === 'notifications/initialized') return;
      if (method === 'notifications/cancelled') return;
      if (method === 'ping') return ok(id, {});
      if (method === 'prompts/list') return ok(id, { prompts: [] });
      if (method === 'resources/templates/list') return ok(id, { resourceTemplates: [] });
      if (method === 'tools/list') {
        const list = readOnly ? TOOLS.filter((t) => !WRITE_TOOLS.has(t.name)) : TOOLS;
        return ok(id, { tools: list });
      }
      if (method === 'resources/list') {
        const notes = await core.readNotes();
        return ok(id, { resources: notes.map(n => ({ uri: `memory://notes/${n.id}`, name: n.title, mimeType: 'text/markdown', description: `${n.classification.primaryType} · ${n.projectName || 'no-project'}` })) });
      }
      if (method === 'resources/read') {
        const noteId = (params?.uri || '').split('/').pop();
        const note = (await core.readNotes()).find(n => n.id === noteId);
        if (!note) return err(id, 'Note not found');
        return ok(id, { contents: [{ uri: params.uri, mimeType: 'text/markdown', text: note.content }] });
      }
      if (method !== 'tools/call') return err(id, `Unknown method: ${method}`, -32601);

      const name = params?.name;
      const a = params?.arguments || {};
      if (readOnly && WRITE_TOOLS.has(name)) {
        return err(id, `الوضع الحالي قراءة فقط: ${name} يعدّل الخزنة. فعّل الكتابة من إعدادات MCP في Cortex.`);
      }
      const notes = await core.readNotes();

      if (name === 'memory_search' || name === 'memory_semantic_search') {
        let topK = 8;
        try { topK = Number(core.getRetrievalConfig(await core.readSettings()).topK) || 8; } catch {}
        const out = await core.searchWithEmbeddings(String(a.query || ''), { limit: Math.min(Number(a.limit) || topK, 20), project: String(a.project || '') });
        const text = out.results.length ? out.results.map(r => `[${r.id}] ${r.title} · type:${r.type} · project:${r.project || '—'} · score:${r.score}\n  └ semantic:${r.semantic} lexical:${r.lexical} rerank:${r.rerankScore}\n  └ ${r.snippet}`).join('\n\n') : 'No matching notes.';
        return ok(id, { content: textContent(text) });
      }
      if (name === 'memory_resolve_reference') {
        const out = await core.resolveReference(String(a.query || ''), { activeProject: String(a.activeProject || ''), activeNoteId: String(a.activeNoteId || '') });
        return ok(id, { content: textContent(JSON.stringify(out, null, 2)) });
      }
      if (name === 'memory_dashboard') return ok(id, { content: textContent(JSON.stringify(await core.getDashboardData(), null, 2)) });
      if (name === 'memory_list_projects') {
        const model = core.buildBrainModel(notes);
        return ok(id, { content: textContent(JSON.stringify(model.projects, null, 2)) });
      }
      if (name === 'memory_get_note') {
        const note = notes.find(n => n.id === core.slugify(String(a.id || '')));
        if (!note) return err(id, `Note not found: ${a.id}`);
        return ok(id, { content: textContent(note.content) });
      }
      if (name === 'memory_upsert_note') {
        const note = await core.saveNote(a);
        return ok(id, { content: textContent(`Saved: ${note.title} (${note.id})`) });
      }
      if (name === 'memory_delete_note') {
        const deleted = await core.deleteNote(String(a.id || ''));
        return ok(id, { content: textContent(deleted ? `Deleted: ${a.id}` : `Not found: ${a.id}`) });
      }
      if (name === 'memory_recent') {
        const text = [...notes].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)).slice(0, Math.min(Number(a.limit) || 5, 30)).map(n => noteLine(n)).join('\n');
        return ok(id, { content: textContent(text || 'No notes.') });
      }
      if (name === 'memory_related') {
        const rel = core.relatedNotes(notes, String(a.id || ''), Math.min(Number(a.limit) || 6, 20));
        return ok(id, { content: textContent(rel.length ? rel.map(r => `${r.title} (${r.id}) score:${r.score}`).join('\n') : 'No related notes found.') });
      }
      if (name === 'memory_tag_search') {
        const tag = String(a.tag || '').toLowerCase();
        const filtered = notes.filter(n => (n.fm?.tags || []).some(t => String(t).toLowerCase().includes(tag))).sort((x, y) => (Number(y.fm?.importance) || 0) - (Number(x.fm?.importance) || 0));
        return ok(id, { content: textContent(filtered.length ? filtered.slice(0, Math.min(Number(a.limit) || 20, 50)).map(n => noteLine(n)).join('\n') : `No notes with tag: ${a.tag}`) });
      }
      if (name === 'memory_stats') {
        const review = await core.reviewWorkspace();
        const retrieval = await core.getRetrievalStatus();
        const lines = [`Notes: ${review.noteCount}`, `Documents: ${review.documentCount}`, `Projects: ${review.projectCount}`, `Health score: ${review.healthScore}`, `Index entries: ${retrieval.entryCount}`, `Embedding model: ${retrieval.model || retrieval.provider}`];
        return ok(id, { content: textContent(lines.join('\n')) });
      }
      if (name === 'memory_classify_note') {
        const note = notes.find(n => n.id === core.slugify(String(a.id || '')));
        if (!note) return err(id, 'Note not found');
        return ok(id, { content: textContent(JSON.stringify(note.classification, null, 2)) });
      }
      if (name === 'memory_extract_structured') {
        const note = notes.find(n => n.id === core.slugify(String(a.id || '')));
        if (!note) return err(id, 'Note not found');
        return ok(id, { content: textContent(JSON.stringify(core.extractStructuredInfo(note.body), null, 2)) });
      }
      if (name === 'memory_find_contradictions') {
        const note = notes.find(n => n.id === core.slugify(String(a.id || '')));
        if (!note) return err(id, 'Note not found');
        return ok(id, { content: textContent(JSON.stringify(core.detectContradictions(note, notes), null, 2)) });
      }
      if (name === 'memory_find_gaps') return ok(id, { content: textContent(JSON.stringify(core.findGaps(notes, String(a.project || '')), null, 2)) });
      if (name === 'memory_project_state') return ok(id, { content: textContent(JSON.stringify(await core.synthesizeProjectState(String(a.project || '')), null, 2)) });
      if (name === 'memory_rebuild_index') {
        const out = await core.rebuildVectorIndex({ force: a.force !== false });
        return ok(id, { content: textContent(JSON.stringify({ rebuilt: out.rebuilt, entryCount: out.index.entryCount, noteCount: out.index.noteCount, builtAt: out.index.builtAt, model: out.index.model }, null, 2)) });
      }
      if (name === 'memory_retrieval_status') return ok(id, { content: textContent(JSON.stringify(await core.getRetrievalStatus(), null, 2)) });
      if (name === 'agent_start_session') return ok(id, { content: textContent(JSON.stringify(await core.createSession(a), null, 2)) });
      if (name === 'agent_capture_message') return ok(id, { content: textContent(JSON.stringify(await core.appendSessionMessage(String(a.sessionId), { role: a.role, content: a.content }), null, 2)) });
      if (name === 'agent_review_context') return ok(id, { content: textContent(JSON.stringify(await core.buildContextPacket(String(a.query || ''), { project: String(a.project || '') }), null, 2)) });
      if (name === 'agent_next_best_action') return ok(id, { content: textContent(JSON.stringify(await core.nextBestAction(a), null, 2)) });
      if (name === 'agent_update_living_note') return ok(id, { content: textContent(JSON.stringify(await core.updateLivingNote(String(a.project || 'workspace')), null, 2)) });
      /* ── ذاكرة المشاريع لوكلاء البناء (2026-10-28) ── */
      if (name === 'project_absorb') {
        const out = await projectMemory.absorbProject({ path: String(a.path || ''), project: String(a.project || ''), refresh: a.refresh !== false });
        if (out.error) return err(id, out.error);
        const text = [
          `Absorbed: ${out.project} (${out.path})`,
          `Files: ${out.files} · internal edges: ${out.edges}${out.truncated ? ' · scan hit its cap (partial map)' : ''}`,
          `Entry points: ${out.entryPoints.join(', ') || '—'}`,
          `Top files: ${out.topFiles.slice(0, 8).map(f => `${f.path} (in:${f.inbound} out:${f.outbound})`).join(' · ') || '—'}`,
          `External packages: ${out.external.slice(0, 10).map(x => x.name).join(', ') || '—'}`,
          `Vault note: ${out.noteId} · maps: data/projects/${out.id}.map.json`,
          'Next: call memory_slice before edits, and memory_record after each action.'
        ].join('\n');
        return ok(id, { content: textContent(text) });
      }
      if (name === 'memory_slice') {
        const out = await projectMemory.buildMemorySlice({
          project: String(a.project || ''), path: String(a.path || ''),
          file: String(a.file || ''), query: String(a.query || ''), intent: String(a.intent || '')
        });
        if (out.error) return err(id, out.error);
        const text = [
          out.summary,
          out.targets.length ? `\nFull path: ${out.targets[0].fullPath}` : '',
          out.dependsOn.length ? `\nDepends on edges: ${out.dependsOn.slice(0, 12).join(' | ')}` : '',
          out.dependedBy.length ? `\nDepended by (files): ${out.dependedBy.slice(0, 12).join(', ')}` : '',
          out.relatedNotes.length ? `\nRelated notes:\n${out.relatedNotes.map(r => `  [${r.id}] ${r.title}${r.snippet ? ` — ${r.snippet}` : ''}`).join('\n')}` : '',
          '\nRead only the specific files above that you actually need.'
        ].filter(Boolean).join('');
        return ok(id, { content: textContent(text) });
      }
      if (name === 'memory_record') {
        const out = projectMemory.appendTrail({ project: String(a.project || ''), source: String(a.source || 'external'), entries: a.entries });
        if (out.error) return err(id, out.error);
        return ok(id, { content: textContent(`Recorded ${out.added} entr${out.added === 1 ? 'y' : 'ies'} for ${out.project} (trail now ${out.kept} entries${out.rotated ? ', oldest rotated' : ''}).`) });
      }
      if (name === 'project_trail') {
        const out = projectMemory.readTrail({ project: String(a.project || ''), limit: Number(a.limit) || 30 });
        const text = out.entries.length
          ? out.entries.map(e => `[${String(e.at).slice(0, 16)}] (${e.source}/${e.kind}${e.status ? `/${e.status}` : ''}) ${e.text}${e.files?.length ? ` — files: ${e.files.join(', ')}` : ''}`).join('\n')
          : `No trail recorded yet for ${out.project}.`;
        return ok(id, { content: textContent(text) });
      }
      return err(id, `Unknown tool: ${name}`);
    } catch (e) {
      return err(id, e.message);
    }
  }

  return { handle, VERSION, TOOLS };
}

module.exports = { createMcpCore };
