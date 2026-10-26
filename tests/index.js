// Entry point so `node --test tests/` (a directory argument) works on
// Node 22: the test runner runs the directory as a module, which resolves to
// this file. It imports every *.test.mjs here. When this file is picked up
// directly (e.g. by a bare `node --test` glob that also matches the
// *.test.mjs files) it does nothing, so tests never run twice.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const invokedAs = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedAs !== __filename) {
  (async () => {
    const files = fs.readdirSync(__dirname).filter((n) => n.endsWith('.test.mjs')).sort();
    for (const f of files) await import(pathToFileURL(path.join(__dirname, f)).href);
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
