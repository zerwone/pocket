import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ctx } from '../ctx.js';
import { DEFAULT_PORT, ensureDir, paths, PocketError, readText, writePrivate } from '../config.js';
import { startApp } from '../app.js';
import { checkBind } from '../server.js';

export interface PidInfo {
  pid: number;
  port: number;
  host: string;
  started: string;
}

export function readPid(env: NodeJS.ProcessEnv): PidInfo | null {
  const t = readText(paths(env).pid);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM';
  }
}

export async function health(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<any | null> {
  try {
    const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Running daemon (pid alive and /healthz answering), or null. */
export async function running(env: NodeJS.ProcessEnv): Promise<PidInfo | null> {
  const info = readPid(env);
  if (!info || !alive(info.pid)) return null;
  return (await health(info.port, info.host)) ? info : null;
}

/** Tell a running daemon to drop its in-memory key cache. Best effort. */
export async function notifyReload(env: NodeJS.ProcessEnv, token: string) {
  const info = await running(env);
  if (!info) return;
  try {
    await fetch(`http://127.0.0.1:${info.port}/admin/reload`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
  } catch {
    /* daemon will pick keys up within 30s anyway */
  }
}

function portOf(ctx: Ctx, flag: string | undefined): number {
  const v = flag ?? ctx.env.POCKET_PORT;
  const n = v ? Number(v) : DEFAULT_PORT;
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new PocketError(`bad port "${v}"`);
  return n;
}

export async function cmdDaemon(ctx: Ctx, args: { _: string[]; flags: Record<string, string | boolean> }): Promise<number> {
  const sub = args._[0] ?? 'status';
  const p = paths(ctx.env);
  const host = typeof args.flags.host === 'string' ? args.flags.host : '127.0.0.1';
  const iKnow = args.flags['i-know-this-is-exposed'] === true;
  const port = portOf(ctx, typeof args.flags.port === 'string' ? args.flags.port : undefined);

  if (sub === 'run') {
    // foreground: what `start` spawns; also usable under a service manager
    checkBind(host, iKnow);
    const app = await startApp({ env: ctx.env, port, host, exposed: iKnow });
    writePrivate(p.pid, JSON.stringify({ pid: process.pid, port: app.port, host, started: new Date().toISOString() }) + '\n');
    app.deps.log(`daemon listening on ${host}:${app.port} (keychain: ${app.deps.keystoreName})`);
    ctx.out(`pocket daemon listening on http://${host}:${app.port}`);
    const stop = async () => {
      app.deps.log('daemon stopping');
      await app.close();
      try {
        const cur = readPid(ctx.env);
        if (cur?.pid === process.pid) fs.rmSync(p.pid, { force: true });
      } catch {
        /* ignore */
      }
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await new Promise(() => {}); // run until signalled
    return 0;
  }

  if (sub === 'start') {
    checkBind(host, iKnow);
    const cur = await running(ctx.env);
    if (cur) {
      ctx.out(`already running (pid ${cur.pid}, port ${cur.port})`);
      return 0;
    }
    ensureDir(p.dir);
    const main = fileURLToPath(new URL('../main.js', import.meta.url));
    const logFd = fs.openSync(p.log, 'a', 0o600);
    const argv = [main, 'daemon', 'run', '--port', String(port), '--host', host];
    if (iKnow) argv.push('--i-know-this-is-exposed');
    const child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', logFd, logFd], env: ctx.env, windowsHide: true });
    child.unref();
    fs.closeSync(logFd);
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const info = readPid(ctx.env);
      if (info && info.pid === child.pid && (await health(info.port, host))) {
        ctx.out(`pocket daemon started (pid ${info.pid}) on http://${host}:${info.port}`);
        return 0;
      }
      if (child.exitCode !== null) break;
    }
    const tail = (readText(p.log) ?? '').split('\n').slice(-8).join('\n');
    throw new PocketError(`daemon did not come up. Last log lines:\n${tail}`);
  }

  if (sub === 'stop') {
    const info = readPid(ctx.env);
    if (!info || !alive(info.pid)) {
      fs.rmSync(p.pid, { force: true });
      ctx.out('not running');
      return 0;
    }
    process.kill(info.pid, 'SIGTERM');
    for (let i = 0; i < 50 && alive(info.pid); i++) await new Promise((r) => setTimeout(r, 100));
    if (alive(info.pid)) process.kill(info.pid, 'SIGKILL');
    fs.rmSync(p.pid, { force: true });
    ctx.out(`stopped (pid ${info.pid})`);
    return 0;
  }

  if (sub === 'status') {
    const info = readPid(ctx.env);
    const h = info && alive(info.pid) ? await health(info.port, info.host) : null;
    if (!h) {
      ctx.out('not running (start it with `pocket daemon start`)');
      return args.flags.json ? (ctx.out(JSON.stringify({ running: false })), 3) : 3;
    }
    if (args.flags.json) {
      ctx.out(JSON.stringify({ running: true, ...info, health: h }, null, 2));
      return 0;
    }
    ctx.out(`running: pid ${info!.pid}, http://${info!.host}:${info!.port}, since ${info!.started}, keychain: ${h.keychain}`);
    for (const [id, s] of Object.entries<any>(h.providers)) ctx.out(`  ${id.padEnd(11)} ${s.has_key ? 'key' : '-  '}${s.verified_on ? `  verified ${s.verified_on}` : ''}`);
    return 0;
  }

  if (sub === 'logs') {
    const n = Number(args.flags.n ?? 50);
    const t = readText(p.log) ?? '';
    ctx.out(t.split('\n').filter(Boolean).slice(-n).join('\n') || '(no log yet)');
    return 0;
  }

  throw new PocketError('usage: pocket daemon start|stop|status|logs|run [--port 3460] [--host 127.0.0.1]');
}
