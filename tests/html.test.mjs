import { test } from 'node:test';
import assert from 'node:assert/strict';
import { esc, CSP_REPORT, CSP_GALLERY, page, githubHref, chip } from '../plugin/scripts/lib/html.mjs';

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">t</a>',
  '<svg onload=alert(1)>',
];

test('AC27: esc neutralises every XSS payload', () => {
  for (const p of PAYLOADS) {
    const out = esc(p);
    assert.doesNotMatch(out, /[<>"']/);
    assert.doesNotMatch(out, /<script|<img|<svg|<a /i);
  }
  assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(esc(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;');
  assert.equal(esc('a=b'), 'a&#61;b');
  const img = esc('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(img, /onerror=|onload=|src=x/i);
  assert.doesNotMatch(esc('<svg onload=alert(1)>'), /onload=/i);
  assert.equal(esc(null), '');
  assert.equal(esc(5), '5');
});

test('AC28: page starts head with CSP meta, no script or external URL', () => {
  for (const csp of [CSP_REPORT, CSP_GALLERY]) {
    const html = page({ title: PAYLOADS[0], csp, body: '<p>x</p>' });
    assert.match(html, /<head><meta http-equiv="Content-Security-Policy" content="[^"]+">/);
    assert.ok(html.includes(`content="${csp}"`));
    assert.doesNotMatch(html, /<script/i);
    assert.doesNotMatch(html, /(src|href)\s*=\s*["']?https?:/i);
    assert.doesNotMatch(html, /<link/i);
    assert.doesNotMatch(html, /@import/i);
    assert.doesNotMatch(html, /url\(\s*["']?https?:/i);
    assert.doesNotMatch(html, /https?:\/\//);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /--primary:#5B5BF7/);
    assert.match(html, /overflow-x:auto/);
  }
  assert.equal(CSP_REPORT, "default-src 'none'; style-src 'unsafe-inline'");
  assert.equal(CSP_GALLERY, `${CSP_REPORT}; img-src 'self' file:`);
  assert.match(page({ title: 't' }), /content="default-src 'none'/);
});

test('AC28: githubHref accepts only github.com https URLs', () => {
  assert.equal(githubHref('https://github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1');
  assert.equal(githubHref('javascript:alert(1)'), null);
  assert.equal(githubHref('https://evil.example/x'), null);
  assert.equal(githubHref('https://github.com.evil.example/x'), null);
  assert.equal(githubHref('https://github.com/a"b'), null);
  assert.equal(githubHref('https://github.com/a b'), null);
  assert.equal(githubHref(undefined), null);
});

test('R28: chip always carries its text label, escaped', () => {
  const c = chip('failed', '<b>fail</b>');
  assert.match(c, />&lt;b&gt;fail&lt;\/b&gt;</);
  assert.match(c, /chip-bad/);
  assert.match(chip('weird', 'x'), /chip-neutral">x</);
  assert.match(chip('ok', 'ok'), />ok</);
});
