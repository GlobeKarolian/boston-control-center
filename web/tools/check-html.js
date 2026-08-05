// tools/check-html.js
//
// Parses every inline <script> in app/index.html. The page is one 2700 line
// file with the whole client in it, and a syntax error inside that block is a
// blank dashboard with one line in a console nobody has open. `node -c` cannot
// see inside HTML, so this pulls the blocks out and hands them to the same
// parser.
//
//   node tools/check-html.js [path ...]

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = process.argv.slice(2);
if (!files.length) files.push(path.join(__dirname, '..', 'app', 'index.html'));

let bad = 0;

for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m, n = 0, checked = 0;

  while ((m = re.exec(html)) !== null) {
    n++;
    const attrs = m[1] || '';
    /* A tag with a src carries no body worth parsing, and a type that is not
       JavaScript (a JSON island, a template) would fail for the wrong reason. */
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/type\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (type && !/javascript|module/i.test(type)) continue;

    const body = m[2];
    if (!body.trim()) continue;
    checked++;

    /* The line number has to be the line in the HTML, not the line in the
       fragment, or the error points at nothing you can open. */
    const line = html.slice(0, m.index).split('\n').length;
    try {
      new vm.Script(body, { filename: f + ' (inline #' + checked + ')', lineOffset: line });
    } catch (e) {
      bad++;
      console.log('FAIL  ' + f + '  inline script #' + checked + ', starting near line ' + line);
      console.log('      ' + String(e.message));
    }
  }

  if (!bad) console.log('ok    ' + path.basename(f) + '  ' + checked + ' inline script'
    + (checked === 1 ? '' : 's') + ' parsed, ' + n + ' script tag' + (n === 1 ? '' : 's') + ' total');
}

process.exit(bad ? 1 : 0);
