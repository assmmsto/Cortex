'use strict';
/* فحص ساكن: كل id يستدعيه app.js — موجود في index.html؟
   كل كلاس CSS مستخدم — موجود في styles.css؟
   كل متغير مستخدم — معرّف؟ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');

/* ── 1) ids ── */
const htmlIds = new Set();
for (const m of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)) htmlIds.add(m[1]);

const idsUsed = new Set();
// $( 'foo' )
for (const m of js.matchAll(/\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) idsUsed.add(m[1]);
// getElementById('foo')
for (const m of js.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) idsUsed.add(m[1]);
// querySelector('#foo'
for (const m of js.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)/g)) idsUsed.add(m[1]);
// document.getElementById via $id helper
for (const m of js.matchAll(/\$id\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) idsUsed.add(m[1]);

const missingIds = [...idsUsed].filter((i) => !htmlIds.has(i)).sort();

/* ── 2) CSS classes ── */
const cssClasses = new Set();
for (const m of css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) cssClasses.add(m[1]);

const jsClasses = new Set();
// classList.add/remove/toggle/contains('x', 'y')
for (const m of js.matchAll(/classList\.(?:add|remove|toggle|contains)\(([^)]*)\)/g)) {
  for (const c of m[1].matchAll(/['"]([A-Za-z0-9_-]+)['"]/g)) jsClasses.add(c[1]);
}
// className = 'a b c'
for (const m of js.matchAll(/className\s*=\s*['"]([^'"]+)['"]/g)) {
  for (const c of m[1].split(/\s+/)) if (c) jsClasses.add(c);
}
// class="..." inside template strings created in JS
for (const m of js.matchAll(/class\s*=\s*\\?["']([^"'\\]+)\\?["']/g)) {
  for (const c of m[1].split(/\s+/)) if (c && !c.includes('$')) jsClasses.add(c);
}
// setAttribute('class', '...')
for (const m of js.matchAll(/setAttribute\(\s*['"]class['"]\s*,\s*([^)]*)\)/g)) {
  for (const c of m[1].matchAll(/['"]([A-Za-z0-9_-\s]+)['"]/g)) {
    for (const cc of c[1].split(/\s+/)) if (cc) jsClasses.add(cc);
  }
}

// محاذاة: كلاسات تُبنى ديناميكياً (بتعبير) نستثنيها
const missingClasses = [...jsClasses].filter((c) => !cssClasses.has(c)).sort();

/* ── 3) undeclared variables ── */
// نستخرج معرّفات مرشّحة: كلمات تظهر كنصوص بلا تعریف قريب. نبحث صراحةً عن المطلوب.
const targets = ['paletteSearchTimer'];
const targetReport = {};
for (const t of targets) {
  const declRe = new RegExp('(?:^|[^\\w$.])(?:const|let|var|function|window\\.)\\s*' + t + '\\b', 'g');
  const assignRe = new RegExp('(?:^|[^\\w$])' + t + '\\s*=', 'g');
  const useRe = new RegExp('(?:^|[^\\w$.])' + t + '\\s*(?:\\)|;|,|\\]|\\}|$|\\s*\\?|\\s*\\|\\||\\s*&&|\\s*\\.)', 'gm');
  const decls = [...js.matchAll(declRe)].length;
  const assigns = [...js.matchAll(assignRe)].length;
  const uses = [...js.matchAll(useRe)].map((m) => js.slice(0, m.index).split('\n').length);
  targetReport[t] = { declared: decls, assignments: assigns, useLines: uses };
}

/* ── output ── */
const out = {
  htmlIds: htmlIds.size,
  idsUsed: idsUsed.size,
  missingIds,
  cssClasses: cssClasses.size,
  jsClasses: jsClasses.size,
  missingClasses,
  targets: targetReport
};
console.log(JSON.stringify(out, null, 2));
