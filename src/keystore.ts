import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Paths, readJson, today, writePrivate } from './config.js';
import { PocketError } from './config.js';

export const SERVICE = 'pocket';

export interface Keystore {
  name: string;
  /** throws PocketError with a reason when no keychain is usable */
  probe(): void;
  get(provider: string): string | null;
  set(provider: string, key: string): void;
  delete(provider: string): boolean;
}

/**
 * Linux: the keychain library silently falls back to the kernel keyring (keyutils) when no
 * Secret Service is on the session bus. Kernel keys are not on disk, but they vanish on reboot
 * or idle expiry, so a user would lose keys without noticing. pocket requires the Secret Service.
 */
export function secretServiceProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  if (process.platform !== 'linux') return null;
  const runtimeBus = env.XDG_RUNTIME_DIR ? `${env.XDG_RUNTIME_DIR}/bus` : null;
  if (!env.DBUS_SESSION_BUS_ADDRESS && !(runtimeBus && existsSync(runtimeBus))) return 'no D-Bus session bus (DBUS_SESSION_BUS_ADDRESS is unset)';
  const probes: [string, string[]][] = [
    ['dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', 'string:org.freedesktop.secrets']],
    ['gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.freedesktop.secrets']],
  ];
  for (const [cmd, args] of probes) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', env, timeout: 3000 });
    if (r.error && (r.error as any).code === 'ENOENT') continue; // tool not installed: try the next
    if (r.status !== 0) return `the session bus did not answer (${(r.stderr || '').trim().split('\n')[0] || cmd + ' failed'})`;
    if (/\btrue\b/.test(r.stdout)) {
      // activatable services (gnome-keyring, KeePassXC) may not own the name until first use; the library will start them
      return null;
    }
    const act = spawnSync(cmd, cmd === 'dbus-send'
      ? ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.ListActivatableNames']
      : ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListActivatableNames'], { encoding: 'utf8', env, timeout: 3000 });
    return act.stdout?.includes('org.freedesktop.secrets') ? null : 'no Secret Service (org.freedesktop.secrets) on the session bus';
  }
  return null; // no bus tools installed: rely on the library's own answer
}

/**
 * Linux: libsecret through its own CLI (`secret-tool`, package libsecret-tools). The key goes in on
 * stdin, never argv, and lives only in the Secret Service. (The npm keychain library also caches
 * keys in the kernel keyring and does not remove that copy on delete, so it is not used on Linux.)
 */
function secretToolKeystore(service: string, env: NodeJS.ProcessEnv): Keystore {
  const attrs = (provider: string) => ['service', service, 'account', provider];
  const run = (args: string[], input?: string) => spawnSync('secret-tool', args, { encoding: 'utf8', env, input, timeout: 10_000 });
  const problem = (): string | null => {
    const ss = secretServiceProblem(env);
    if (ss) return ss;
    const v = run(['--version']);
    if (v.error && (v.error as any).code === 'ENOENT') return 'secret-tool (libsecret-tools) is not installed';
    return null;
  };
  const fail = (what: string, detail: string) =>
    new PocketError(`${what}: no usable Secret Service keychain (${detail}). Install libsecret-tools and run gnome-keyring or KeePassXC's Secret Service, unlocked, in your D-Bus session. pocket never writes keys to disk in plaintext and does not fall back to the kernel keyring (keys there vanish on reboot).`);
  return {
    name: 'Secret Service (libsecret)',
    probe() {
      const p = problem();
      if (p) throw fail('keychain', p);
      const w = run(['store', '--label=pocket probe', ...attrs('__probe__')], 'probe');
      if (w.status !== 0) throw fail('keychain', (w.stderr || 'store failed').trim());
      const r = run(['lookup', ...attrs('__probe__')]);
      run(['clear', ...attrs('__probe__')]);
      if (r.stdout !== 'probe') throw fail('keychain', 'read back a different value');
    },
    get(provider) {
      if (problem()) return null;
      const r = run(['lookup', ...attrs(provider)]);
      return r.status === 0 && r.stdout ? r.stdout : null;
    },
    set(provider, key) {
      const p = problem();
      if (p) throw fail(`refusing to store the ${provider} key`, p);
      const w = run(['store', `--label=pocket ${provider} API key`, ...attrs(provider)], key);
      if (w.status !== 0) throw fail(`refusing to store the ${provider} key`, (w.stderr || 'store failed').trim());
      if (run(['lookup', ...attrs(provider)]).stdout !== key) throw fail(`storing the ${provider} key`, 'the keychain returned a different value');
    },
    delete(provider) {
      if (problem()) return false;
      const had = run(['lookup', ...attrs(provider)]).status === 0;
      run(['clear', ...attrs(provider)]);
      return had && run(['lookup', ...attrs(provider)]).status !== 0;
    },
  };
}

/** OS keychain: Windows Credential Manager and macOS Keychain via @napi-rs/keyring; Secret Service via secret-tool on Linux. */
export async function osKeystore(service = SERVICE, env: NodeJS.ProcessEnv = process.env): Promise<Keystore> {
  if (process.platform === 'linux') return secretToolKeystore(service, env);
  let Entry: any;
  try {
    ({ Entry } = await import('@napi-rs/keyring'));
  } catch (e: any) {
    return unavailable(`the keychain module failed to load (${e.message})`);
  }
  const why = (e: any) =>
    process.platform === 'linux'
      ? `no Secret Service keychain is reachable (${e?.message ?? e}). Install and unlock gnome-keyring or KeePassXC's Secret Service, inside a D-Bus session.`
      : `the OS keychain refused the request (${e?.message ?? e})`;
  return {
    name: process.platform === 'win32' ? 'Windows Credential Manager' : process.platform === 'darwin' ? 'macOS Keychain' : 'Secret Service (libsecret)',
    probe() {
      const ss = secretServiceProblem(env);
      if (ss) throw new PocketError(why(new Error(ss)) + ' pocket does not fall back to the kernel keyring: keys there vanish on reboot.');
      try {
        const e = new Entry(service, '__probe__');
        e.setPassword('probe');
        if (e.getPassword() !== 'probe') throw new Error('read back a different value');
        e.deletePassword();
      } catch (e: any) {
        throw new PocketError(why(e));
      }
    },
    get(provider) {
      try {
        return new Entry(service, provider).getPassword() ?? null;
      } catch (e: any) {
        if (/no.*(entry|password|item)|not found/i.test(String(e?.message))) return null;
        throw new PocketError(why(e));
      }
    },
    set(provider, key) {
      const ss = secretServiceProblem(env);
      if (ss) throw new PocketError(`refusing to store the ${provider} key: ${why(new Error(ss))} pocket never writes keys to disk in plaintext and does not use the kernel keyring (keys there vanish on reboot).`);
      try {
        new Entry(service, provider).setPassword(key);
      } catch (e: any) {
        throw new PocketError(`refusing to store the ${provider} key: ${why(e)} pocket never writes keys to disk in plaintext.`);
      }
    },
    delete(provider) {
      try {
        return !!new Entry(service, provider).deletePassword();
      } catch {
        return false;
      }
    },
  };
}

function unavailable(reason: string): Keystore {
  const fail = () => {
    throw new PocketError(`no keychain: ${reason}`);
  };
  return { name: 'none', probe: fail, get: fail, set: fail, delete: fail };
}

/** In-memory store. Only for tests and the fake-provider demo; never persists anything. */
export function memoryKeystore(seed: Record<string, string> = {}): Keystore {
  const m = new Map(Object.entries(seed));
  return {
    name: 'memory (test only)',
    probe() {},
    get: (p) => m.get(p) ?? null,
    set: (p, k) => void m.set(p, k),
    delete: (p) => m.delete(p),
  };
}

export async function keystoreFor(env: NodeJS.ProcessEnv): Promise<Keystore> {
  if (env.POCKET_KEYSTORE === 'memory') {
    // keys may be seeded for tests as POCKET_TEST_KEYS='{"groq":"..."}'
    return memoryKeystore(env.POCKET_TEST_KEYS ? JSON.parse(env.POCKET_TEST_KEYS) : {});
  }
  // tests use their own keychain service name so they can never touch a real user's keys
  return osKeystore(env.POCKET_KEYCHAIN_SERVICE || SERVICE, env);
}

/** Index of which providers have a key and when it was verified. Holds no secrets. */
export interface KeyIndex {
  [provider: string]: { added: string; verified_on: string | null; last4?: undefined };
}

export function readIndex(p: Paths): KeyIndex {
  return readJson<KeyIndex>(p.keysIndex, {});
}

export function writeIndex(p: Paths, idx: KeyIndex) {
  writePrivate(p.keysIndex, JSON.stringify(idx, null, 2) + '\n');
}

export function recordKey(p: Paths, provider: string, verified: boolean, now: Date) {
  const idx = readIndex(p);
  idx[provider] = { added: idx[provider]?.added ?? today(now), verified_on: verified ? today(now) : null };
  writeIndex(p, idx);
}
