import chokidar, { type FSWatcher } from 'chokidar';
import { featuresRootPath } from './features';

// Listener signature is intentionally `(kind, payload)` so the hub can carry
// both chokidar filesystem events (kind = 'add' | 'change' | 'unlink' | …,
// payload = file path string) AND server-published custom events (e.g.
// kind = 'pinned-changed', payload = arbitrary JSON-serialisable object).
// Consumers (the SSE route) discriminate on `kind` to decide how to encode.
type Listener = (kind: string, payload: unknown) => void;

class WatcherHub {
  private watcher: FSWatcher | null = null;
  private listeners = new Set<Listener>();

  ensureStarted() {
    if (this.watcher) return;
    const root = featuresRootPath();
    this.watcher = chokidar.watch(root, {
      ignored: [/(^|[\/\\])\../, '**/node_modules/**'],
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
    });
    const fire = (event: string) => (file: string) => {
      for (const l of this.listeners) {
        try {
          l(event, file);
        } catch {
          // ignore listener errors
        }
      }
    };
    this.watcher.on('add', fire('add'));
    this.watcher.on('change', fire('change'));
    this.watcher.on('unlink', fire('unlink'));
    this.watcher.on('addDir', fire('addDir'));
    this.watcher.on('unlinkDir', fire('unlinkDir'));
  }

  subscribe(listener: Listener): () => void {
    this.ensureStarted();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Fan out a custom event to every current subscriber. Used by server
   * endpoints (e.g. `POST /api/pins`) to broadcast over the existing SSE
   * channel without going through chokidar. Does not affect the watcher
   * or the heartbeat.
   */
  publish(kind: string, payload: unknown): void {
    for (const l of this.listeners) {
      try {
        l(kind, payload);
      } catch {
        // ignore listener errors
      }
    }
  }
}

const globalAny = globalThis as unknown as { __dashboardWatcher?: WatcherHub };
export const watcherHub: WatcherHub =
  globalAny.__dashboardWatcher ?? (globalAny.__dashboardWatcher = new WatcherHub());
