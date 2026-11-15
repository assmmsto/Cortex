/**
 * عقد إمكانية الوصول (2026-11-06) — كان عدّاد سمات ARIA في الواجهة صفراً.
 *
 * القياس قبل الإصلاح: 0 سمة aria-* / role في index.html، فلا معالم (landmarks)
 * ولا حوارات مُعلنة ولا منطقة حيّة؛ قارئ الشاشة يرى كومة أزرار بلا سياق،
 * والتنبيهات (toast) لا تُعلَن لأنها عناصر بصرية بحتة.
 *
 * هذا الاختبار يحمي العقد على مستوى الملفات و على مستوى ما يقدّمه الخادم فعلاً،
 * لأن أي «تحويل» في طبقة التقديم قد يُسقط السمات دون أن يلاحظها أحد.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLiveServer } from './_live-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('public/index.html');
const app = read('public/app.js');
const css = read('public/styles.css');

const DIALOGS = ['modal-new', 'modal-settings', 'modal-mcp', 'modal-sessions', 'modal-link'];

test('معالم الصفحة: تخطٍّ + main + nav مُسمّاة', () => {
  assert.match(html, /class="skip-link" href="#work"/, 'رابط التخطي مفقود');
  assert.match(html, /<main class="work" id="work" tabindex="-1">/, 'main غير قابل للتركيز فلا يعمل رابط التخطي');
  assert.match(html, /<nav class="rail" id="rail" aria-label="[^"]+"/, 'شريط التنقل بلا اسم');
  // هدف رابط التخطي موجود فعلاً
  assert.ok(html.includes('id="work"'), 'هدف التخطي #work غير موجود');
});

test('الحوارات: role=dialog وaria-modal وربط بالعنوان', () => {
  assert.match(html, /id="palette"[^>]*role="dialog"[^>]*aria-modal="true"/, 'لوحة الأوامر ليست حواراً');
  for (const id of DIALOGS) {
    const re = new RegExp(`id="${id}"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="${id}-title"`);
    assert.match(html, re, `${id}: سمات الحوار ناقصة`);
    assert.ok(html.includes(`id="${id}-title"`), `${id}: عنوان الحوار غير مربوط`);
  }
});

test('المناطق الحيّة: سجل الوكيل + الحالة + منطقة التنبيهات', () => {
  assert.match(html, /id="chat-messages"[^>]*role="log"[^>]*aria-live="polite"/, 'سجل الوكيل ليس منطقة حيّة');
  assert.match(html, /id="status-health"[^>]*role="status"[^>]*aria-live="polite"/, 'الحالة ليست منطقة حيّة');
  assert.match(html, /id="a11y-live"[^>]*role="status"[^>]*aria-live="polite"/, 'منطقة التنبيهات مفقودة');
  // التنبيه البصري يجب أن يُنسخ إلى المنطقة الحيّة وإلا لم يسمعه قارئ الشاشة
  assert.match(app, /const live = document\.getElementById\('a11y-live'\)/, 'toast لا يبثّ لقارئ الشاشة');
});

test('التبويب النشط مُعلَن بـ aria-current، وأسماء الضوابط الأيقونية موجودة', () => {
  assert.match(app, /setAttribute\('aria-current', 'page'\)/, 'التبويب النشط لا يُعلَن');
  assert.match(app, /removeAttribute\('aria-current'\)/, 'aria-current لا يُنظَّف عند التبديل');
  for (const [id, label] of [['mcp-btn', 'MCP'], ['settings-btn', '.+'], ['sessions-btn', '.+']]) {
    const re = new RegExp(`id="${id}"[^>]*aria-label="${label}"`);
    assert.match(html, re, `${id}: بلا اسم مفهوم`);
  }
  const railIcons = html.split('<span class="rail-ico" aria-hidden="true">').length - 1;
  assert.ok(railIcons >= 8, `أيقونات الشريط المُخفاة عن قارئ الشاشة: ${railIcons} (المتوقع 8+)`);
});

test('الأنماط: نص لقارئ الشاشة + حلقة تركيز مرئية', () => {
  assert.match(css, /\.sr-only\s*\{/, '.sr-only مفقود');
  assert.match(css, /\.skip-link\s*\{/, '.skip-link مفقود');
  assert.match(css, /:focus-visible\s*\{/, 'حلقة التركيز مفقودة');
});

test('لا سمات مكرّرة أو فارغة تُبطل البنية', () => {
  for (const bad of ['aria-label=""', "aria-label=''", 'role=""', 'aria-labelledby=""']) {
    assert.ok(!html.includes(bad), `سمة فارغة: ${bad}`);
  }
  for (const [id] of [['x']]) void id;
  // لا عنصر يحمل role="dialog" بلا اسم
  const dialogs = html.match(/<div id="[^"]+"[^>]*role="dialog"[^>]*>/g) || [];
  assert.equal(dialogs.length, DIALOGS.length + 1, 'عدد الحوارات تغيّر بلا تحديث الاختبار');
  for (const d of dialogs) {
    assert.ok(/aria-label="[^"]+"|aria-labelledby="[^"]+"/.test(d), 'حوار بلا اسم مفهوم: ' + d.slice(0, 60));
  }
});

test('كل سمة مفهومة بالعربية لها مفتاح ترجمة (aria-label / placeholder / title)', () => {
  // تدقيق 2026-11-06: محرّك الترجمة كان يعالج النص وplaceholder وtitle فقط،
  // فأفلتت aria-label ورابط التخطي — قارئ الشاشة يعلن العربية في واجهة إنجليزية.
  assert.match(app, /\[data-i18n-aria\]/, 'محرّك الترجمة لا يعالج aria-label');
  assert.match(html, /class="skip-link"[^>]*data-i18n="a11y_skip"/, 'رابط التخطي بلا مفتاح ترجمة');

  const tags = html.match(/<(?:button|div|nav|input|textarea|main|aside|section|a|span)\b[^>]*>/g) || [];
  const missing = [];
  for (const tag of tags) {
    for (const [attr, keyAttr] of [['aria-label', 'data-i18n-aria'], ['placeholder', 'data-i18n-ph'], ['title', 'data-i18n-title']]) {
      const m = new RegExp('\\s' + attr + '="([^"]*)"').exec(tag);
      if (!m || !/[\u0600-\u06FF]/.test(m[1])) continue;
      if (!new RegExp(keyAttr + '="[^"]+"').test(tag)) missing.push(attr + '=' + m[1].slice(0, 24));
    }
  }
  assert.equal(missing.length, 0, 'سمات عربية بلا مفتاح ترجمة: ' + missing.join(' | '));
});

test('كل مفتاح ترجمة مستخدم موجود في القاموسين معاً', () => {
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-ph|-title|-aria)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of app.matchAll(/\bt\('([a-zA-Z0-9_]+)'\)/g)) keys.add(m[1]);
  const missing = [];
  for (const k of keys) {
    if (k.endsWith('_')) continue;  // مفاتيح مركّبة وقت التشغيل مثل t('mode_' + m)
    const re = new RegExp('(?:^|[\\s,{])["\']?' + k + '["\']?\\s*:', 'g');
    const n = (app.match(re) || []).length;
    if (n < 2) missing.push(k + '(' + n + ')');
  }
  assert.equal(missing.length, 0, 'مفاتيح ناقصة من أحد القاموسين: ' + missing.join(', '));
});

test('الخادم يقدّم الترميز نفسه (السمات لا تُسقط في طبقة التقديم)', async (t) => {
  const srv = await startLiveServer();
  t.after(async () => { await srv.stop(); });
  const res = await fetch(srv.base + '/');
  assert.equal(res.status, 200);
  const served = await res.text();
  assert.match(served, /class="skip-link" href="#work"/);
  assert.match(served, /id="chat-messages"[^>]*role="log"/);
  assert.match(served, /id="a11y-live"/);
  for (const id of DIALOGS) assert.ok(served.includes(`${id}-title`), `${id}: العنوان غير مُقدَّم`);
  const count = (served.match(/aria-[a-z]+=|role=/g) || []).length;
  assert.ok(count >= 40, `سمات ARIA المُقدَّمة ${count} (الحد 40)`);
});
