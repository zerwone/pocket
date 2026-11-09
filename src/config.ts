import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export class PocketError extends Error {
  constructor(message: string, public code = 1) {
    super(message);
  }
}

export const DEFAULT_PORT = 3460;

/** Per-user config dir. POCKET_HOME overrides (tests, portable installs). */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POCKET_HOME) return path.resolve(env.POCKET_HOME);
  if (process.platform === 'win32') return path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'pocket');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'pocket');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'pocket');
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function writePrivate(file: string, content: string) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, { mode: 0o600 });
}

export interface Paths {
  dir: string;
  pid: string;
  log: string;
  token: string;
  keysIndex: string;
  policy: string;
  agentPolicy: string;
  providers: string;
  state: string;
  bin: string;
  attachments: string;
}

export function paths(env: NodeJS.ProcessEnv = process.env): Paths {
  const dir = configDir(env);
  return {
    dir,
    pid: path.join(dir, 'daemon.pid'),
    log: path.join(dir, 'daemon.log'),
    token: path.join(dir, 'token'),
    keysIndex: path.join(dir, 'keys.json'),
    policy: path.join(dir, 'pocket.yml'),
    agentPolicy: path.join(dir, 'agents.json'),
    providers: path.join(dir, 'providers.json'),
    state: path.join(dir, 'state.json'),
    bin: path.join(dir, 'bin'),
    attachments: path.join(dir, 'attachments.json'),
  };
}

/**
 * The local token: a random secret that agents present to the daemon. It is not a
 * provider key (those live only in the OS keychain); it has to be on disk because
 * the attach launchers pass it to the agent.
 */
export function localToken(p: Paths): string {
  const cur = readText(p.token)?.trim();
  if (cur) return cur;
  const t = 'pk-local-' + randomBytes(24).toString('hex');
  writePrivate(p.token, t + '\n');
  return t;
}

export function readJson<T>(file: string, fallback: T): T {
  const t = readText(file);
  if (t === null) return fallback;
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new PocketError(`${file} is not valid JSON`);
  }
}

export function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}
