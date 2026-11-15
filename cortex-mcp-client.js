'use strict';
/**
 * Cortex — عميل MCP (دستور §29، §30، §31)
 *
 * اتجاه الاستهلاك: يسمح لـ Cortex بالاتصال بخوادم MCP الخارجية، اكتشاف أدواتها
 * ومواردها، واستدعاؤها ضمن الصلاحيات المحددة فقط — واكتشاف القدرات الفعلية
 * لا أسماء التطبيقات. كل استدعاء يمر عبر بوابة الصلاحيات وسجل تدقيق.
 *
 * البروتوكول: JSON-RPC 2.0 على stdio بنمط NDJSON (سطر JSON واحد لكل رسالة).
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = Object.freeze({ name: 'cortex', version: '5.0.0' });
const MAX_PENDING = 100;          // سقف الطلبات المعلّقة — طلب جديد فوقه يُرفض
const MAX_ARGS_CHARS = 4000;      // اقتطاع الوسائط في السجل
const MAX_RESULT_CHARS = 4000;    // اقتطاع النتيجة في السجل
const MAX_CONTEXT_CHARS = 8000;   // اقتطاع مخرجات الخادم قبل إدخالها سياق الوكيل

// أنماط مشبوهة تُعزل قبل إدخال المحتوى الخارجي سياق الوكيل (حماية من حقن التعليمات)
const SUSPICIOUS_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions/gi,
  /أنت\s+الآن/g,
  /<system>/gi,
  /\[\/?INST\]/gi,
  /<<\/?SYS>>/gi,
  /system\s+prompt/gi,
];
const QUARANTINE = '[محتوى خارجي مُعزَل]';

// مفتاح أداة خارجية في جدول TOOL_POLICY: mcp__<server>__<tool>
function policyKey(server, tool) {
  return `mcp__${server}__${tool}`;
}

/**
 * إغلاق قيمة إلى نص محدود الطول — لا يفشل أبداً.
 */
function clip(value, maxChars = MAX_RESULT_CHARS) {
  if (value === null || value === undefined) return '';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/**
 * تسوية مخرجات MCP إلى نص: بروتوكول MCP يعيد `{ content: [{type, text}] }`.
 * الوكيل يحتاج نصاً مقروءاً لا JSON مُهرَّباً — التسوية قبل التنقية.
 */
function flattenContent(result) {
  if (!result || typeof result !== 'object') return result;

  const parts = [];
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.text === 'string') parts.push(item.text);
      else if (item.type === 'image') parts.push(`[صورة: ${item.mimeType || 'unknown'}]`);
      else if (item.type === 'resource') parts.push(`[مورد: ${item.uri || ''}]`);
    }
  }

  if (!parts.length) return result; // لا محتوى معياري — نمرّر كما هو (يشمل الأخطاء)

  const flat = parts.join('\n');
  return {
    text: flat,
    ...(result.isError ? { isError: true } : {}),
    ...(result.changedFiles ? { changedFiles: result.changedFiles } : {}),
    ...(result.needsApproval ? { needsApproval: result.needsApproval } : {}),
    ...(result.requiresApproval ? { requiresApproval: result.requiresApproval } : {})
  };
}

/**
 * تنقّي مخرجات الخادم الخارجي قبل إدخالها سياق الوكيل.
 * يستبدل أنماط التعليمات المشبوهة ويقتطع الطول.
 * @returns {{clean: string, stripped: number}}
 */
function sanitizeResult(result) {
  const source = result && typeof result === 'object' && 'text' in result ? result.text : result;
  const raw = clip(source, MAX_CONTEXT_CHARS);
  let stripped = 0;
  let clean = raw;
  for (const pattern of SUSPICIOUS_PATTERNS) {
    clean = clean.replace(pattern, () => { stripped += 1; return QUARANTINE; });
  }
  return { clean, stripped };
}

/**
 * عميل خادم MCP واحد. لكل `start()` إيقاف مضمون عبر `stop()`.
 */
class McpClient extends EventEmitter {
  constructor({ name, command, args = [], env = {}, cwd, timeoutMs = 30000, allowedTools = [], onCall, onNotification, framing = 'content-length' } = {}) {
    super();
    if (!name || typeof name !== 'string') throw new Error('MCP: اسم الخادم مطلوب');
    if (!command || typeof command !== 'string') throw new Error('MCP: أمر التشغيل مطلوب');

    this.name = name;
    this.command = command;
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.env = env && typeof env === 'object' ? { ...process.env, ...env } : { ...process.env };
    this.cwd = cwd || process.cwd();
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
    this.allowedTools = Array.isArray(allowedTools) ? allowedTools.map(String) : [];
    this.onCall = typeof onCall === 'function' ? onCall : null;
    // إطار النقل الصادر: 'content-length' (المعيار) أو 'ndjson'
    this.framing = framing === 'ndjson' ? 'ndjson' : 'content-length';
    this.onNotification = typeof onNotification === 'function' ? onNotification : null;

    this.child = null;
    this.startAttempted = false;
    this.closed = false;
    this.nextId = 1;
    // كشف تلقائي لإطار النقل: بعض الخوادم تتكلم Content-Length (المعيار) وبعضها
    // NDJSON. بدل إجبار المستخدم على ضبط الإطار يدوياً، إن لم يصل أي بايت من
    // الخادم بعد أول طلب نجرّب الإطار الآخر مرة واحدة.
    this.autoFraming = true;
    this.framingTried = new Set([this.framing]);
    this.bytesIn = 0;   // كم بايت وصل من stdout — يميّز «خادم صامت» عن «ردّ ناقص»
    this.pending = new Map();      // id -> { resolve, timer }
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrTail = '[]';
    this.capabilities = {};
    this.serverInfo = null;
    this.exitInfo = null;          // { code, signal } عند الخروج
    this.stderrLines = [];         // آخر أسطر stderr للتشخيص
  }

  // ── دورة الحياة ──

  start() {
    if (this.child) return this;
    if (this.startAttempted) throw new Error('MCP: لا يمكن إعادة تشغيل عميل أُوقف — أنشئ عميلاً جديداً');
    this.startAttempted = true;

    // stdio: ['pipe','pipe','pipe'] — الحوار كله عبر الأنابيب، بلا shell
    this.child = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
    });

    this.child.on('error', (e) => this._failAll(`فشل تشغيل الخادم: ${e.message}`));

    // stdout يبقى Buffer لا نصاً: Content-Length يحسب *بايتات*، وتحويل النص
    // يجعل الطول بالأحرف فينكسر مع أي حرف عربي (حرفان ببايتين) — عطل مؤكد
    // كان يشلّ كل رسالة بعد الأولى تحوي عربية.
    this.child.stdout.on('data', (chunk) => this._onStdout(chunk));

    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => this._onStderr(chunk));

    this.child.on('exit', (code, signal) => {
      this.closed = true;
      this.exitInfo = { code, signal };
      const tail = this.stderrLines.slice(-3).join(' | ');
      this._failAll(`انتهت عملية الخادم (code=${code}${signal ? `, signal=${signal}` : ''})${tail ? ` — stderr: ${tail}` : ''}`);
      this.emit('exit', this.exitInfo);
    });

    return this;
  }

  /** يعيد تشغيل الخادم بإطار نقل آخر — يُستخدم للكشف التلقائي فقط. */
  async _respawnWith(otherFraming) {
    try { if (this.child) this.child.kill('SIGKILL'); } catch { /* الخادم ميت أصلاً */ }
    // انتظر خروج العملية قبل إعادة التشغيل حتى لا يتنافس العمليتان على الأنابيب
    await new Promise((resolve) => {
      if (!this.child) return resolve();
      const t = setTimeout(resolve, 1500);
      this.child.once('exit', () => { clearTimeout(t); resolve(); });
    });
    for (const [, p] of this.pending) { try { clearTimeout(p.timer); } catch { /* مُنظَّف */ } }
    this.pending.clear();
    this.child = null;
    this.closed = false;
    this.startAttempted = false;   // نسمح بإعادة التشغيل لأن هذا كشف مقصود
    this.stdoutBuffer = Buffer.alloc(0);
    this.bytesIn = 0;
    this.stderrLines = [];
    this.framing = otherFraming;
    this.framingTried.add(otherFraming);
    this.start();
  }

  // ── قراءة الرسائل من stdout: بروتوكول Content-Length الرسمي + NDJSON ──
  // مواصفة MCP تعتمد Content-Length، لكن بعض الخوادم ترسل NDJSON (سطر JSON).
  // نفهم الاثنين بالكشف من الشكل، فلا ننكسر مع أي خادم (دستور §31: اكتشاف فعلي).

  _onStdout(chunk) {
    // كل الحساب بالبايتات: Content-Length بايتات لا أحرف.
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    this.bytesIn += buf.length;
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, buf]);

    const HEADER = Buffer.from('Content-Length:', 'utf8');
    const SEP = Buffer.from('\r\n\r\n', 'utf8');
    let guard = 0;

    for (;;) {
      if (++guard > 1000) break; // حماية من حلقة لا نهائية

      const at = this.stdoutBuffer.indexOf(HEADER);
      if (at === -1) break;                       // لا ترويسة → للقارئ ②
      if (at > 0) this.stdoutBuffer = this.stdoutBuffer.subarray(at);

      const sep = this.stdoutBuffer.indexOf(SEP);
      if (sep === -1) break;                      // الترويسة لم تكتمل → ننتظر
      const m = this.stdoutBuffer.subarray(0, sep).toString('utf8').match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.stdoutBuffer = this.stdoutBuffer.subarray(1); continue; } // ترويسة تالفة → تقدّم بايتاً

      const len = Number(m[1]);
      const start = sep + SEP.length;
      if (this.stdoutBuffer.length < start + len) break; // الحمولة ناقصة بالبايت → ننتظر

      const body = this.stdoutBuffer.subarray(start, start + len).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.subarray(start + len);
      if (body.trim()) this._handleLine(body);
    }

    // ② أسطر NDJSON — للخوادم التي لا تستخدم Content-Length.
    // شرط حاسم: ممنوع أن نلمس ما يشبه ترويسة Content-Length، وإلا ابتلعنا الرأس.
    if (this.stdoutBuffer.indexOf(HEADER) !== -1) return;
    for (;;) {
      const nl = this.stdoutBuffer.indexOf(0x0a); // \n
      if (nl === -1) break;
      let line = this.stdoutBuffer.subarray(0, nl).toString('utf8');
      this.stdoutBuffer = this.stdoutBuffer.subarray(nl + 1);
      line = line.replace(/\r$/, '');
      if (line.trim()) this._handleLine(line);
    }
  }


  _onStderr(chunk) {
    this.stderrLines.push(String(chunk).trim());
    if (this.stderrLines.length > 20) this.stderrLines.shift();
    this.stderrTail = clip(this.stderrLines.slice(-5).join('\n'), 2000);
  }

  // سطر واحد = رسالة JSON-RPC. سطر تالف يُتجاوز بتحذير دون كسر القارئ.
  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (e) {
      process.stderr.write(`[mcp:${this.name}] تحذير: سطر stdout غير صالح كـ JSON — تم تجاوزه (${e.message})\n`);
      return;
    }
    if (!message || typeof message !== 'object') {
      process.stderr.write(`[mcp:${this.name}] تحذير: رسالة غير كائنية — تم تجاوزها\n`);
      return;
    }
    // إشعار (بلا id) → مستمع اختياري أو تجاهل
    if (message.id === undefined || message.id === null) {
      if (this.onNotification) {
        try { this.onNotification({ server: this.name, method: message.method, params: message.params }); } catch { /* الإشعار لا يكسر القارئ */ }
      }
      this.emit('notification', { method: message.method, params: message.params });
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return; // استجابة متأخرة بعد المهلة — تُتجاهل
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.resolve({ error: message.error.message || 'خطأ غير معروف من الخادم', code: message.error.code, tool: entry.tool });
      return;
    }
    entry.resolve(message.result !== undefined ? message.result : {});
  }

  // ── نقل JSON-RPC ──
  // المعيار MCP يرسل برأس Content-Length. بعض الخوادم تقبل NDJSON فقط.
  // الافتراضي: Content-Length، ويمكن طلب NDJSON عبر framing:'ndjson'.

  _write(message) {
    if (!this.child || this.closed || !this.child.stdin || this.child.stdin.destroyed) return false;
    const body = JSON.stringify(message);

    if (this.framing === 'ndjson') {
      this.child.stdin.write(`${body}\n`);
      return true;
    }

    const bytes = Buffer.byteLength(body, 'utf8');
    this.child.stdin.write(`Content-Length: ${bytes}\r\n\r\n${body}`);
    return true;
  }

  _request(method, params, tool = '') {
    if (this.closed || !this.child) {
      return Promise.resolve({ error: 'الخادم غير متصل', disconnected: true });
    }
    if (this.pending.size >= MAX_PENDING) {
      return Promise.resolve({ error: 'تجاوز حد الرسائل المعلّقة', overloaded: true, limit: MAX_PENDING });
    }
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ error: 'انتهت المهلة', timeout: true, method });
      }, this.timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, timer, tool, method });
      if (!this._write({ jsonrpc: '2.0', id, method, params })) {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ error: 'تعذر الكتابة إلى الخادم', disconnected: true });
      }
    });
  }

  _notify(method, params) {
    return this._write({ jsonrpc: '2.0', method, params });
  }

  // رفض كل الطلبات المعلّقة فوراً عند خروج العملية أو فشلها
  _failAll(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ error: reason, exited: true, method: entry.method, tool: entry.tool });
      this.pending.delete(id);
    }
  }

  // ── عمليات MCP ──

  async initialize() {
    const params = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { ...CLIENT_INFO },
    };
    let result = await this._request('initialize', params);

    // خادم صامت تماماً (لم يصل بايت) ⇒ إطارنا لا يفهمه. جرّب الآخر مرة واحدة.
    if (result && result.error && this.autoFraming && this.bytesIn === 0) {
      const other = this.framing === 'ndjson' ? 'content-length' : 'ndjson';
      if (!this.framingTried.has(other)) {
        await this._respawnWith(other);
        result = await this._request('initialize', params);
      }
    }

    if (result && result.error) return result;
    this.capabilities = result.capabilities || {};
    this.serverInfo = result.serverInfo || null;
    this._notify('notifications/initialized', {});
    return { ok: true, protocolVersion: result.protocolVersion || PROTOCOL_VERSION, capabilities: this.capabilities, serverInfo: this.serverInfo };
  }

  /**
   * أدوات الخادم — يُقفل عليها allowedTools إن كانت محددة:
   * اكتشاف القدرات الفعلية مع ضبط ما نشاركه (دستور §31).
   */
  async listTools() {
    const result = await this._request('tools/list', {});
    if (result && result.error) return result;
    const tools = (result && Array.isArray(result.tools) ? result.tools : []).map((t) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
    }));
    if (this.capabilities && this.capabilities.tools === undefined && tools.length === 0) return [];
    if (!this.allowedTools.length) return tools;
    return tools.filter((t) => this.allowedTools.includes(t.name));
  }

  async listResources() {
    const result = await this._request('resources/list', {});
    if (result && result.error) return result;
    return (result && Array.isArray(result.resources) ? result.resources : []).map((r) => ({
      uri: r.uri,
      name: r.name || r.uri,
      mimeType: r.mimeType || '',
      description: r.description || '',
    }));
  }

  /**
   * استدعاء أداة خارجية.
   * قبل الإرسال: فحص الصلاحية — أداة خارج allowedTools تُرفض بلا أي طلب على الشبكة.
   */
  async callTool(name, args = {}) {
    const tool = String(name || '');
    if (this.allowedTools.length && !this.allowedTools.includes(tool)) {
      const denied = { error: 'الأداة غير مصرح بمشاركتها', tool, allowed: false };
      if (this.onCall) {
        try { this.onCall({ server: this.name, tool, args, ok: false, result: denied, changedFiles: [], needsApproval: false }); } catch { /* التدقيق لا يكسر التنفيذ */ }
      }
      return denied;
    }

    const raw = await this._request('tools/call', { name: tool, arguments: args && typeof args === 'object' ? args : {} }, tool);
    const ok = !(raw && raw.error);
    const sanitized = sanitizeResult(flattenContent(raw));
    const changedFiles = Array.isArray(raw && raw.changedFiles) ? raw.changedFiles.map(String) : [];
    const needsApproval = !!(raw && (raw.needsApproval || raw.requiresApproval));

    if (this.onCall) {
      try {
        this.onCall({
          server: this.name,
          tool,
          args,
          ok,
          result: sanitized,
          changedFiles,
          needsApproval,
        });
      } catch { /* التدقيق لا يكسر التنفيذ */ }
    }
    return { ok, clean: sanitized.clean, stripped: sanitized.stripped, changedFiles, needsApproval, raw };
  }

  async ping() {
    const result = await this._request('ping', {});
    if (result && result.error) return { ok: false, error: result.error };
    return { ok: true, alive: true };
  }

  /** إغلاق مهذّب: أغلق stdin، ثم SIGTERM، ثم SIGKILL بعد المهلة. */
  async stop({ graceMs = 2000 } = {}) {
    const child = this.child;
    if (!child) return { ok: true, alreadyStopped: true };

    try { if (child.stdin && !child.stdin.destroyed) child.stdin.end(); } catch { /* تجاهل */ }

    if (child.exitCode !== null || child.signalCode !== null) {
      this._failAll('أُوقف العميل بناءً على طلب');
      this.child = null;
      this.closed = true;
      return { ok: true, alreadyExited: true, exit: this.exitInfo };
    }

    let killTimer = null;
    await new Promise((resolve) => {
      let done = false;
      const finish = (killed) => {
        if (done) return;
        done = true;
        if (killTimer) clearTimeout(killTimer);
        child.removeListener('exit', onExit);
        resolve(killed);
      };
      const onExit = () => finish(false);
      child.once('exit', onExit);

      try { child.kill('SIGTERM'); } catch { finish(true); }

      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* تجاهل */ }
        finish(true);
      }, Math.max(100, Number(graceMs) || 2000));
    });

    this._failAll('أُوقف العميل بناءً على طلب');
    this.closed = true;
    this.child = null;
    return { ok: true, exit: this.exitInfo, pending: this.pending.size };
  }
}

/**
 * اكتشاف خوادم MCP من إعداد معياري: { mcpServers: { name: { command, args, env } } }.
 * الخادم الذي يفشل لا يُسقط الباقي — كل خادم يُعزل ويُعاد خطؤه في نتيجته.
 */
async function discoverServers(config, options = {}) {
  const serversConfig = (config && config.mcpServers) || {};
  const report = { servers: [] };
  const onCall = typeof options.onCall === 'function' ? options.onCall : null;
  const onNotification = typeof options.onNotification === 'function' ? options.onNotification : null;

  for (const [name, spec] of Object.entries(serversConfig)) {
    const entry = { name, ok: false, tools: [] };
    let client = null;
    try {
      if (!spec || !spec.command) throw new Error('إعداد الخادم يفتقد command');
      client = new McpClient({
        name,
        command: spec.command,
        args: spec.args || [],
        env: spec.env || {},
        cwd: spec.cwd || options.cwd,
        timeoutMs: spec.timeoutMs || options.timeoutMs || 30000,
        allowedTools: spec.allowedTools || options.allowedTools || [],
        onCall,
        onNotification,
      });
      client.start();
      const init = await client.initialize();
      if (init.error) throw new Error(init.error);
      entry.serverInfo = init.serverInfo;
      entry.capabilities = init.capabilities;
      const tools = await client.listTools();
      if (tools && tools.error) throw new Error(tools.error);
      entry.tools = tools;
      entry.ok = true;
    } catch (e) {
      entry.error = e.message;
    } finally {
      // كل start له stop مضمون — لا عملية فرعية معلّقة
      if (client) {
        try { await client.stop(); } catch (e) { entry.stopError = e.message; }
      }
    }
    report.servers.push(entry);
  }
  return report;
}

/**
 * تحويل الأدوات المكتشفة إلى صيغة TOOL_POLICY في cortex-policy.js:
 * مفتاح mcp__<server>__<tool> بمستوى read مسودة دائماً (دستور §31 — لا خصوصية ضمنية).
 */
function toToolPolicy(servers) {
  const policy = {};
  const list = Array.isArray(servers) ? servers : (servers && servers.servers) || [];
  for (const server of list) {
    if (!server || !server.name) continue;
    for (const tool of server.tools || []) {
      if (!tool || !tool.name) continue;
      policy[policyKey(server.name, tool.name)] = {
        level: 'read',
        scope: 'mcp',
        alwaysDraft: true,
        description: tool.description || '',
      };
    }
  }
  return policy;
}

/**
 * سجل تدقيق مكالمات MCP في جدول mcp_calls.
 * لا يفشل التسجيل أبداً بسبب خطأ في قاعدة البيانات (مغلق بـ try/catch).
 */
function createCallLogger(db) {
  let statement = null;
  let broken = false;
  return function logMcpCall(entry = {}) {
    if (broken) return { logged: false, error: 'التسجيل متوقف بعد فشل سابق' };
    try {
      if (!statement) {
        statement = db.prepare(
          'INSERT INTO mcp_calls(at, server, tool, args, result, ok, changed_files, needs_approval) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
      }
      const args = clip(entry.args, MAX_ARGS_CHARS);
      const result = clip(entry.result && entry.result.clean !== undefined ? entry.result.clean : entry.result, MAX_RESULT_CHARS);
      statement.run(
        entry.at || new Date().toISOString(),
        String(entry.server || ''),
        String(entry.tool || ''),
        args,
        result,
        entry.ok ? 1 : 0,
        clip(entry.changedFiles, MAX_ARGS_CHARS),
        entry.needsApproval ? 1 : 0
      );
      return { logged: true };
    } catch (e) {
      broken = true;                 // لا معنى لمحاولة إضافية على نفس الجملة الفاشلة
      process.stderr.write(`[mcp] تحذير: تعذر تسجيل المكالمة — ${e.message}\n`);
      return { logged: false, error: e.message };
    }
  };
}

module.exports = {
  McpClient,
  discoverServers,
  toToolPolicy,
  createCallLogger,
  flattenContent,
  sanitizeResult,
  policyKey,
  PROTOCOL_VERSION,
  CLIENT_INFO,
  MAX_PENDING,
};
