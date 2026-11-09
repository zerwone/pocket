import * as fs from 'node:fs';
import * as http from 'node:http';
import { DEFAULT_PORT, ensureDir, localToken, Paths, paths } from './config.js';
import { Keystore, keystoreFor, readIndex } from './keystore.js';
import { loadPolicy } from './policy.js';
import { loadProviders } from './providers.js';
import { createServer, listen, ServerDeps } from './server.js';
import { State } from './state.js';

export interface App {
  server: http.Server;
  port: number;
  deps: ServerDeps;
  paths: Paths;
  close: () => Promise<void>;
}

/** Keys are read from the keychain on demand and cached in memory only (never on disk). */
function keyCache(ks: Keystore, ttlMs = 30_000) {
  const cache = new Map<string, { v: string | null; at: number }>();
  return {
    get(provider: string): string | null {
      const hit = cache.get(provider);
      if (hit && Date.now() - hit.at < ttlMs) return hit.v;
      let v: string | null = null;
      try {
        v = ks.get(provider);
      } catch {
        v = null;
      }
      cache.set(provider, { v, at: Date.now() });
      return v;
    },
    clear: () => cache.clear(),
  };
}

export async function startApp(opts: { env?: NodeJS.ProcessEnv; port?: number; host?: string; keystore?: Keystore; exposed?: boolean; log?: (l: string) => void; now?: () => number } = {}): Promise<App> {
  const env = opts.env ?? process.env;
  const p = paths(env);
  ensureDir(p.dir);
  const ks = opts.keystore ?? (await keystoreFor(env));
  const keys = keyCache(ks);
  const state = new State(p);
  const token = localToken(p);
  const logFn =
    opts.log ??
    ((line: string) => {
      fs.appendFileSync(p.log, `${new Date().toISOString()} ${line}\n`);
    });
  const deps: ServerDeps = {
    providers: () => loadProviders(p),
    policy: () => loadPolicy(p),
    key: (id) => keys.get(id),
    state,
    now: opts.now ?? (() => Date.now()),
    log: logFn,
    token,
    port: opts.port ?? DEFAULT_PORT,
    keystoreName: ks.name,
    reloadKeys: () => keys.clear(),
    keyStatus: () => {
      const idx = readIndex(p);
      const out: Record<string, { has_key: boolean; verified_on: string | null }> = {};
      for (const id of Object.keys(loadProviders(p))) out[id] = { has_key: !!keys.get(id), verified_on: idx[id]?.verified_on ?? null };
      return out;
    },
  };
  const server = createServer(deps);
  (server as any).exposed = !!opts.exposed;
  const port = await listen(server, opts.port ?? DEFAULT_PORT, opts.host ?? '127.0.0.1');
  deps.port = port;
  return {
    server,
    port,
    deps,
    paths: p,
    close: () =>
      new Promise((resolve) => {
        state.flush();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
