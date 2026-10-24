import type { Feature, FeatureJson } from './types';

/** Rows shown under Bugfixes: bugfix flow, and polish-track feature batches. */
export function isBugfixRow(meta: Pick<FeatureJson, 'flow' | 'track'> | null | undefined): boolean {
  if (!meta) return false;
  return meta.flow === 'bugfix' || (meta.flow === 'feature' && meta.track === 'polish');
}

/** Number of polish.md items for a polish feature, else null. */
export function polishItemCount(feature: Pick<Feature, 'meta' | 'tasks'>): number | null {
  const m = feature.meta;
  if (!m || m.flow !== 'feature' || m.track !== 'polish') return null;
  return feature.tasks.length;
}
