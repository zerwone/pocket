// The setup page's API (/setup/api/*). Every action runs the same code as the CLI command it stands
// for (keys add, attach, detach), so the page and the terminal can never disagree.

import * as fs from 'node:fs';
import type * as http from 'node:http';
import { spawn } from 'node:child_process';
import { Ctx } from './ctx.js';
import { localToken, paths, PocketError } from './config.js';
import { underNpx } from './install.js';
import { Keystore, readIndex } from './keystore.js';
import { loadPolicy, setInOrder } from './policy.js';
import { loadProviders } from './providers.js';
import { cmdKeys } from './commands/keys.js';
import { claudeDesktopSteps, cmdAttach, cmdDetach, codexConfigPath, readAttachments } from './commands/attach.js';
import { onPath } from './commands/setup.js';

export interface SetupDeps {
  env: NodeJS.ProcessEnv;
  keystore: Keystore;
  port: () => number;
  reloadKeys: () => void;
}

const TARGETS = new Set(['claude', 'codex', 'codex-app', 'claude-desktop', 'cursor']);

/** A Ctx that collects what a command prints instead of writing to a terminal. */
function capture(env: NodeJS.ProcessEnv, secret = ''): { ctx: Ctx; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const ctx: Ctx = {
    env,
    cwd: process.cwd(),
    out: (s) => lines.push(...s.replace(/\n$/, '').split('\n')),
    err: (s) => errors.push(...s.replace(/\n$/, '').split('\n')),
    readSecret: async () => secret,
    confirm: async () => false,
  };
  return { ctx, lines, errors };
}

function version(): string {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'latest';
  }
}

function readConfig(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Everything the setup page shows. Never includes a provider key. */
export function setupState(d: SetupDeps) {
  const p = paths(d.env);
  const providers = loadProviders(p);
  let order: string[] = [];
  try {
    order = loadPolicy(p).order;
  } catch {
    /* a broken pocket.yml shows up in doctor */
  }
  const idx = readIndex(p);
  const att = readAttachments(p);
  const hasKey = (id: string) => {
    try {
      return !!d.keystore.get(id);
    } catch {
      return false;
    }
  };
  const ids = [...order.filter((id) => providers[id]), ...Object.keys(providers).filter((id) => !order.includes(id))];
  const port = d.port();
  return {
    version: version(),
    npx: underNpx(),
    keychain: d.keystore.name,
    providers: ids.map((id) => {
      const x = providers[id];
      return { id, label: x.label ?? id, signup: x.signup ?? null, note: x.setup_note ?? '', notice: x.notice ?? null, paid: x.paid, has_key: hasKey(id), verified_on: idx[id]?.verified_on ?? null, in_order: order.includes(id) };
    }),
    apps: {
      claude: { installed: onPath('claude', d.env), attached: !!att.claude, run: att.claude ? (onPath('claude-pocket', d.env) ? 'claude-pocket' : att.claude.launcher) : null, vscode: !!att.claude?.vscode },
      codex: { installed: onPath('codex', d.env), attached: !!att.codex, run: att.codex ? (onPath('codex-pocket', d.env) ? 'codex-pocket' : att.codex.launcher) : null, config: codexConfigPath(d.env) },
      'codex-app': { attached: !!att.codexApp, config: codexConfigPath(d.env) },
      'claude-desktop': {
        attached: !!att.claudeDesktop,
        file: att.claudeDesktop?.file ?? null,
        base_url: `http://127.0.0.1:${port}/desktop`,
        steps: att.claudeDesktop ? claudeDesktopSteps(att.claudeDesktop.file, `http://127.0.0.1:${port}/desktop`) : [],
        config: att.claudeDesktop ? readConfig(att.claudeDesktop.file) : null,
      },
      cursor: { base_url: `http://127.0.0.1:${port}/a/cursor/openai/v1` },
    },
    token: localToken(p), // the page is already authenticated with it; agents' settings need it
  };
}

function bad(msg: string, code = 400): never {
  throw new PocketError(msg, code);
}

/** Handle /setup/api/*. Returns the JSON to send. */
export async function setupApi(d: SetupDeps, method: string, route: string, body: any): Promise<any> {
  const p = paths(d.env);
  if (method === 'GET' && route === 'state') return setupState(d);

  if (method === 'POST' && route === 'keys') {
    const id = String(body?.provider ?? '');
    const key = String(body?.key ?? '').trim();
    if (!loadProviders(p)[id]) bad(`unknown provider "${id}"`);
    if (!key) bad('paste a key first');
    const c = capture(d.env, key);
    try {
      await cmdKeys(c.ctx, { _: ['add', id], flags: {} }, d.keystore);
    } catch (e: any) {
      if (e instanceof PocketError) return { ok: false, message: e.message, warnings: c.errors };
      throw e;
    }
    d.reloadKeys();
    return { ok: true, message: c.lines.join('\n'), warnings: c.errors.filter((l) => !/^note: /.test(l)) };
  }

  const rm = /^keys\/([a-z0-9_-]+)$/i.exec(route);
  if (method === 'DELETE' && rm) {
    const c = capture(d.env);
    await cmdKeys(c.ctx, { _: ['rm', rm[1]], flags: {} }, d.keystore);
    d.reloadKeys();
    return { ok: true, message: c.lines.join('\n') };
  }

  if (method === 'POST' && route === 'order') {
    const id = String(body?.provider ?? '');
    if (!loadProviders(p)[id]) bad(`unknown provider "${id}"`);
    setInOrder(p, id, !!body?.on);
    return { ok: true };
  }

  if (method === 'POST' && (route === 'attach' || route === 'detach')) {
    const target = String(body?.target ?? '');
    if (!TARGETS.has(target)) bad(`unknown app "${target}"`);
    const c = capture(d.env);
    const flags: Record<string, string | boolean> = { port: String(d.port()) };
    if (route === 'attach' && target === 'claude' && body?.vscode) flags.vscode = true;
    try {
      await (route === 'attach' ? cmdAttach : cmdDetach)(c.ctx, { _: [target], flags });
    } catch (e: any) {
      if (e instanceof PocketError) return { ok: false, message: e.message };
      throw e;
    }
    return { ok: true, message: [...c.lines, ...c.errors].join('\n') };
  }

  if (method === 'POST' && route === 'test') {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${d.port()}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${localToken(p)}`, 'anthropic-version': '2023-06-01', 'x-pocket-agent': 'setup-test' },
      body: JSON.stringify({ model: String(body?.model ?? 'claude-sonnet-5-5'), max_tokens: 50, messages: [{ role: 'user', content: 'Reply with the single word: pong' }] }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, message: j?.error?.message ?? `HTTP ${r.status}` };
    const text = (j.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    return { ok: true, provider: r.headers.get('x-pocket-provider'), model: r.headers.get('x-pocket-model'), ms: Date.now() - t0, text };
  }

  if (method === 'POST' && route === 'install') {
    // keep pocket after running it with npx: install the same version for good
    const v = version();
    return await new Promise((resolve) => {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const child = spawn(npm, ['i', '-g', `@zerwone/pocket@${v}`], { env: d.env, shell: process.platform === 'win32', windowsHide: true });
      let out = '';
      child.stdout?.on('data', (b) => (out += b));
      child.stderr?.on('data', (b) => (out += b));
      child.on('error', (e) => resolve({ ok: false, message: `could not run npm: ${e.message}` }));
      child.on('close', (code) => resolve(code === 0 ? { ok: true, message: `installed @zerwone/pocket@${v}` } : { ok: false, message: out.trim().split('\n').slice(-6).join('\n') || `npm exited ${code}` }));
    });
  }

  bad(`no route ${method} /setup/api/${route}`, 404);
}

/** Requests that change things must come from the setup page itself, not from another site. */
export function sameOrigin(req: http.IncomingMessage, port: number): boolean {
  if (req.headers['x-pocket-setup'] !== '1') return false; // a custom header: cross-site pages can't send it without CORS
  const o = req.headers.origin;
  if (!o) return true;
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}` || o === `http://[::1]:${port}`;
}

