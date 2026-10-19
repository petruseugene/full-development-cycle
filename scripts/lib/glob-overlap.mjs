// Conservative glob overlap check. Exported for `groups` and `brief`.
//
//   globsOverlap(a, b) -> boolean
//
// Rule: compare literal path segments pairwise up to the first wildcard
// segment of either pattern. A mismatch there proves the patterns disjoint.
// Otherwise, if one pattern is a plain path, test it against the other with
// path.matchesGlob. Anything undecidable counts as overlapping, so patterns
// naming files that do not exist yet (unlike `git ls-files`) still collide.

import path from 'node:path';

const WILDCARD_RE = /[*?[\]{}()!]/;

function segments(p) {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter((s) => s !== '' && s !== '.');
}

function matches(file, glob) {
  try {
    return path.posix.matchesGlob(file, glob);
  } catch {
    return true; // undecidable => overlapping
  }
}

/**
 * @param {string} a  glob or path
 * @param {string} b  glob or path
 * @returns {boolean} true when the two may match a common path
 */
export function globsOverlap(a, b) {
  const sa = segments(a);
  const sb = segments(b);
  const wa = sa.findIndex((s) => WILDCARD_RE.test(s));
  const wb = sb.findIndex((s) => WILDCARD_RE.test(s));
  const litA = wa === -1 ? sa : sa.slice(0, wa);
  const litB = wb === -1 ? sb : sb.slice(0, wb);

  const common = Math.min(litA.length, litB.length);
  for (let i = 0; i < common; i++) {
    if (litA[i] !== litB[i]) return false;
  }

  const plainA = wa === -1;
  const plainB = wb === -1;
  if (plainA && plainB) return true; // equal, or one is a directory of the other
  if (plainA) return plainOverlaps(sa, sb, litB);
  if (plainB) return plainOverlaps(sb, sa, litA);
  return true; // both wildcards with compatible prefixes: undecidable
}

/** plain path `p` (segments) against glob `g` (segments, literal prefix `lit`). */
function plainOverlaps(p, g, lit) {
  if (p.length <= lit.length) return true; // p is a directory containing the glob's base
  return matches(p.join('/'), g.join('/')) || matches(p.join('/') + '/', g.join('/'));
}
