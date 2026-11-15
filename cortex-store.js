'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  doc_type TEXT,
  project TEXT,
  importance INTEGER DEFAULT 0,
  links_count INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  fingerprint TEXT
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  project TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  owner TEXT,
  due TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS note_links(
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'wikilink',
  PRIMARY KEY(source, target, kind)
);
CREATE TABLE IF NOT EXISTS health_history(
  project TEXT NOT NULL,
  score INTEGER NOT NULL,
  item_count INTEGER DEFAULT 0,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project, status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project);
CREATE INDEX IF NOT EXISTS idx_health_project ON health_history(project, at);
`;

// Layer 2 — مرآة منظمة من vault داخل SQLite.
// كل الاستعلامات بمعاملات مُعلمة فقط: لا دمج نصوص ولا format في SQL إطلاقًا.
function createStore({ root }) {
  const dbFile = path.join(path.resolve(root), 'data', 'cortex.db');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  // WAL يسمح بقراءات متزامنة مع كاتب واحد، و busy_timeout ينهي الانتظار بخطأ
  // بدل التعليق الأبدي عند تنافس الاتصالات — بدونهما تتجمّد الواجهة كلها
  // أثناء أي تشغيل طويل (عطل مؤكد: الخادم لا يستجيب مدة عمل الفريق).
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 8000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  /* ترقية في المكان: قاعدة أُنشئت قبل إضافة fingerprint لا تحصل على العمود من
     CREATE TABLE IF NOT EXISTS. بلا هذا الترقّي يفشل INSERT كلياً فيسقط معه
     كل المزامنة (عطل مقيس: tasks=0 في اختبار المخزن). */
  try {
    const cols = db.prepare('PRAGMA table_info(notes)').all().map(c => c.name);
    if (!cols.includes('fingerprint')) db.exec('ALTER TABLE notes ADD COLUMN fingerprint TEXT');
  } catch { /* قاعدة قديمة/مقفلة: المزامنة تُبلّغ عن فشلها لاحقاً */ }

  const q = {
    clearNotes: db.prepare('DELETE FROM notes'),
    clearTasks: db.prepare('DELETE FROM tasks'),
    /* إصلاح 2026-11-12: العمود fingerprint كان يُنشأ في المخطط ولا يُكتب أبداً
       (قياس: 0/362 صفاً) ⇒ كشف التكرار معطّل بالكامل. البصمة تُحسب أصلاً في
       noteFromFile، فالسلك الوحيد المفقود كان هنا. */
    insertNote: db.prepare('INSERT INTO notes(id, title, type, doc_type, project, importance, links_count, created_at, updated_at, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    insertTask: db.prepare('INSERT INTO tasks(id, note_id, project, text, status, owner, due, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    insertLink: db.prepare('INSERT OR IGNORE INTO note_links(source, target, kind) VALUES (?, ?, ?)'),
    allTasks: db.prepare('SELECT id, note_id, project, text, status, owner, due, updated_at FROM tasks ORDER BY updated_at DESC, id'),
    allHealth: db.prepare('SELECT project, score, item_count, at FROM health_history ORDER BY at DESC LIMIT 5000'),
    lastHealth: db.prepare('SELECT score, item_count, at FROM health_history WHERE project = ? ORDER BY at DESC LIMIT 1'),
    insertHealth: db.prepare('INSERT INTO health_history(project, score, item_count, at) VALUES (?, ?, ?, ?)'),
    countsByType: db.prepare('SELECT type, COUNT(*) AS n FROM notes GROUP BY type ORDER BY n DESC')
  };

  function sync({ notes = [], tasks = [], links = [] }) {
    db.exec('BEGIN');
    try {
      q.clearNotes.run();
      for (const n of notes) {
        q.insertNote.run(n.id, n.title, n.type, n.docType || null, n.project || null, Number(n.importance) || 0, Number(n.linksCount) || 0, n.createdAt || null, n.updatedAt || null, n.fingerprint || null);
      }
      q.clearTasks.run();
      for (const t of tasks) {
        q.insertTask.run(t.id, t.noteId, t.project || null, t.text, t.status || 'open', t.owner || null, t.due || null, t.updatedAt || null);
      }
      /* حذف **ما تملكه الإسقاطة فقط** (إصلاح 2026-11-14):
         كان `DELETE FROM note_links` يمحو الجدول كله ثم يُعيد كتابة wikilinks،
         فأي علاقة مُستنتجة (depends_on/references/belongs_to) تُمحى عند أول
         مزامنة — قياس حيّ: استُنتج 1285 علاقة فصار الجدول 14 صفاً، ولهذا كانت
         التغطية «0 من 9» دائماً. الملكية بالـorigin: صفوف الإسقاطة بلا origin،
         وصفوف الاستنتاج تحمل أصلها. الفحص وقت كل مزامنة لأن الترحيل قد يُضيف
         العمود بعد إنشاء المخزن (خزنة جديدة). */
      const hasOrigin = db.prepare('PRAGMA table_info(note_links)').all().some((c) => c.name === 'origin');
      db.prepare(hasOrigin
        ? "DELETE FROM note_links WHERE origin IS NULL OR origin IN ('wikilink:auto','decision_project')"
        : 'DELETE FROM note_links').run();
      for (const l of links) {
        q.insertLink.run(l.source, l.target, l.kind || 'wikilink');
      }
      db.exec('COMMIT');
      return { ok: true, notes: notes.length, tasks: tasks.length, links: links.length };
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      return { ok: false, error: e.message };
    }
  }

  function recordHealth(project, score, itemCount, at) {
    try {
      const last = q.lastHealth.get(String(project));
      const fresh = last && (Date.now() - new Date(last.at).getTime()) < 3600 * 1000;
      if (fresh && last.score === Math.round(Number(score) || 0) && last.item_count === Math.round(Number(itemCount) || 0)) {
        return { recorded: false };
      }
      q.insertHealth.run(String(project), Math.round(Number(score) || 0), Math.round(Number(itemCount) || 0), at);
      return { recorded: true };
    } catch (e) {
      return { recorded: false, error: e.message };
    }
  }

  function listTasks({ project = '', status = '', owner = '' } = {}) {
    let rows = q.allTasks.all();
    if (project) rows = rows.filter(r => (r.project || '') === project);
    if (status) rows = rows.filter(r => (r.status || '') === status);
    if (owner) rows = rows.filter(r => (r.owner || '').toLowerCase().includes(String(owner).toLowerCase()));
    return rows;
  }

  function healthHistory({ project = '', limit = 100 } = {}) {
    let rows = q.allHealth.all();
    if (project) rows = rows.filter(r => (r.project || '') === project);
    return rows.slice(0, Math.max(1, Math.min(Number(limit) || 100, 1000)));
  }

  function typeCounts() { return q.countsByType.all(); }

  function close() { try { db.close(); } catch {} }

  /**
   * §36: إعادة المهام المعلّقة إلى المسار — الاستئناف الحقيقي.
   * العطل الأصلي: الدالة غير موجودة أصلاً، و`Orchestrator.resume` يشترطها
   * فيرمي دائماً، ولا مسار API يناديها — وبقيت مهام running عالقة أياماً.
   * القاعدة: المعلّقة (queued/running) تعود queued، والمنجزة/الفاشلة لا تُعاد.
   */
  function requeuePending(runId) {
    const rid = String(runId || '').trim();
    if (!rid) throw new Error('runId مطلوب للاستئناف');
    const rows = db.prepare('SELECT id, status FROM agent_tasks WHERE run_id = ?').all(rid);
    const resumable = rows.filter((r) => ['queued', 'running', 'blocked'].includes(String(r.status || '')));
    const stmt = db.prepare("UPDATE agent_tasks SET status = 'queued', started_at = NULL, finished_at = NULL, error = NULL WHERE id = ?");
    let requeued = 0;
    for (const r of resumable) { try { stmt.run(r.id); requeued++; } catch {} }
    return { requeued, total: rows.length, ids: resumable.map((r) => r.id) };
  }

  /** كل التشغيلات التي فيها مهام عالقة — تُستخدم عند الإقلاع وفي بوابة §36 */
  function stuckRuns() {
    try {
      return db.prepare(
        "SELECT run_id, COUNT(*) AS n FROM agent_tasks WHERE status IN ('running','blocked') GROUP BY run_id ORDER BY n DESC"
      ).all();
    } catch { return []; }
  }

  return { dbFile, sync, recordHealth, listTasks, healthHistory, typeCounts, requeuePending, stuckRuns, close };
}

module.exports = { createStore, SCHEMA };
