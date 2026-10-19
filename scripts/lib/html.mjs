// Shared HTML primitives for the static report and gallery (R27, R28).
// Pure and dependency-free: no script, no external URL, one escape helper.

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '=': '&#61;' };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"'=]/g, (c) => ENTITIES[c]);
}

export const CSP_REPORT = "default-src 'none'; style-src 'unsafe-inline'";
export const CSP_GALLERY = `${CSP_REPORT}; img-src 'self' file:`;

const GITHUB_RE = /^https:\/\/github\.com\/[^"'<>\s]+$/;

export function githubHref(url) {
  return typeof url === 'string' && GITHUB_RE.test(url) ? url : null;
}

const CSS = `
:root{--primary:#5B5BF7;--bg:#F7F8FA;--text:#0F172A;--hairline:#E5E7EB;--radius:8px;--muted:#64748B;--ok:#047857;--warn:#B45309;--bad:#B91C1C;--surface:#FFFFFF;
--font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:16px;background:var(--bg);color:var(--text);font-family:var(--font);font-size:14px;line-height:1.5;max-width:100%;overflow-x:hidden}
h1,h2,h3{margin:0 0 8px;line-height:1.25}
h1{font-size:22px}h2{font-size:17px}h3{font-size:15px}
a{color:var(--primary)}
img,svg,video{max-width:100%;height:auto}
.card{background:var(--surface);border:1px solid var(--hairline);border-radius:var(--radius);padding:12px;margin:0 0 12px;max-width:100%}
.scroll{overflow-x:auto;max-width:100%}
.timeline{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid var(--hairline);padding:6px 8px;text-align:left;vertical-align:top}
.num,code,pre{font-family:var(--mono)}
.muted{color:var(--muted)}
.chip{display:inline-block;padding:1px 8px;border-radius:999px;border:1px solid currentColor;font-size:12px;font-weight:600;white-space:nowrap}
.chip-ok{color:var(--ok)}.chip-warn{color:var(--warn)}.chip-bad{color:var(--bad)}.chip-neutral{color:var(--muted)}
@media (min-width:768px){body{padding:24px;max-width:1100px;margin:0 auto}}
`;

export function page({ title, csp = CSP_REPORT, body = '' }) {
  return `<!doctype html>
<html lang="en">
<head><meta http-equiv="Content-Security-Policy" content="${String(csp).replace(/"/g, '&quot;')}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

const CHIP_CLASS = {
  ok: 'ok', pass: 'ok', passed: 'ok', done: 'ok', merged: 'ok', approved: 'ok',
  warn: 'warn', warning: 'warn', open: 'warn', unknown: 'warn', estimated: 'warn', done_with_concerns: 'warn',
  bad: 'bad', fail: 'bad', failed: 'bad', blocked: 'bad', error: 'bad', closed: 'bad', 'closed-unmerged': 'bad', changes_required: 'bad',
};

export function chip(status, label) {
  const key = String(status ?? '').toLowerCase();
  const cls = CHIP_CLASS[key] || 'neutral';
  return `<span class="chip chip-${cls}">${esc(label ?? status)}</span>`;
}
