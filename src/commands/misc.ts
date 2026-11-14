import { Catalog } from '../catalog.js';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { Args, Ctx } from '../ctx.js';
import { DEFAULT_PORT, localToken, paths, PocketError, readText, today, writePrivate } from '../config.js';
import { Keystore, keystoreFor, readIndex, recordKey } from '../keystore.js';
import { loadPolicy } from '../policy.js';
import { loadProviders } from '../providers.js';
import { parse } from '../yaml.js';
import { readAttachments } from './attach.js';
import { readPid, running } from './daemon.js';
import { verifyKey } from './keys.js';

// ------------------------------------------------------------------ doctor

export interface Check {
  level: 'ok' | 'warn' | 'error';
  check: string;
  message: string;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

export async function doctorChecks(ctx: Ctx, args: Args, ksOverride?: Keystore): Promise<Check[]> {
  const out: Check[] = [];
  const p = paths(ctx.env);
  const ks = ksOverride ?? (await keystoreFor(ctx.env));
  try {
    ks.probe();
    out.push({ level: 'ok', check: 'keychain', message: `${ks.name} is available` });
  } catch (e: any) {
    out.push({ level: 'error', check: 'keychain', message: e.message });
  }

  const run = await running(ctx.env);
  const port = Number(args.flags.port ?? ctx.env.POCKET_PORT ?? readPid(ctx.env)?.port ?? DEFAULT_PORT);
  if (run) out.push({ level: 'ok', check: 'daemon', message: `running on 127.0.0.1:${run.port} (pid ${run.pid})` });
  else if (await portFree(port)) out.push({ level: 'ok', check: 'port', message: `port ${port} is free (daemon not running)` });
  else out.push({ level: 'error', check: 'port', message: `port ${port} is taken by another program; set --port / POCKET_PORT` });

  const providers = loadProviders(p);
  const policy = loadPolicy(p);
  const idx = readIndex(p);
  let anyKey = false;
  for (const id of Object.keys(providers)) {
    let key: string | null = null;
    try {
      key = ks.get(id);
    } catch {
      key = null;
    }
    if (!key) {
      if (policy.order.includes(id) && idx[id]) out.push({ level: 'error', check: 'key', message: `${id}: listed as added but missing from the keychain; run \`pocket keys add ${id}\`` });
      continue;
    }
    anyKey = true;
    if (args.flags.offline) continue;
    const v = await verifyKey(providers[id], key);
    if (v.ok) {
      recordKey(p, id, true, new Date());
      out.push({ level: 'ok', check: 'key', message: `${id}: key valid` });
    } else out.push({ level: v.rejected ? 'error' : 'warn', check: 'key', message: `${id}: ${v.rejected ? 'key rejected' : 'could not verify'} (${v.detail})` });
  }
  if (!anyKey) out.push({ level: 'warn', check: 'key', message: 'no provider keys stored yet: `pocket keys add groq`' });

  const now = Date.now();
  for (const [id, prov] of Object.entries(providers)) {
    if (!policy.order.includes(id) || prov.paid) continue;
    if (!prov.verified_on) out.push({ level: 'warn', check: 'limits', message: `${id}: free-tier limits never verified against the provider's docs (providers.json verified_on is null)` });
    else if (now - Date.parse(prov.verified_on) > 30 * 86_400_000) out.push({ level: 'warn', check: 'limits', message: `${id}: limits verified ${prov.verified_on}, more than 30 days ago` });
  }

  const att = readAttachments(p);
  const attached = Object.keys(att).filter((k) => k !== 'cursor' || att.cursor);
  if (attached.length && !run) out.push({ level: 'error', check: 'attached', message: `${attached.join(', ')} attached but the daemon is down: \`pocket daemon start\`` });
  if (att.claude && !fs.existsSync(att.claude.launcher)) out.push({ level: 'warn', check: 'attached', message: `claude launcher missing: ${att.claude.launcher}` });
  if (att.codex) {
    const cur = readText(att.codex.file) ?? '';
    if (!cur.includes('[model_providers.pocket]')) out.push({ level: 'warn', check: 'attached', message: `codex config no longer has the pocket provider (${att.codex.file})` });
    else if (/wire_api\s*=\s*"chat"/.test(cur) || cur.includes('model_provider = "pocket" # pocket'))
      out.push({ level: 'error', check: 'attached', message: `codex config was attached by pocket 0.1.1, which Codex no longer accepts: run \`pocket detach codex\` then \`pocket attach codex\`` });
  }
  return out;
}

export async function cmdDoctor(ctx: Ctx, args: Args, ks?: Keystore): Promise<number> {
  const checks = await doctorChecks(ctx, args, ks);
  if (args.flags.json) ctx.out(JSON.stringify(checks, null, 2));
  else for (const c of checks) ctx.out(`${c.level === 'ok' ? 'ok   ' : c.level === 'warn' ? 'warn ' : 'ERROR'} ${c.check.padEnd(9)} ${c.message}`);
  const errors = checks.filter((c) => c.level === 'error').length;
  if (!args.flags.json) ctx.out(`\n${errors} error(s), ${checks.filter((c) => c.level === 'warn').length} warning(s)`);
  return errors ? 1 : 0;
}

// ------------------------------------------------------------------ lanes sync

function findLanes(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'agents', 'roles.yml'))) return path.join(dir, 'agents', 'roles.yml');
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export async function cmdLanes(ctx: Ctx, args: Args): Promise<number> {
  if (args._[0] !== 'sync') throw new PocketError('usage: pocket staked sync [--repo <path>]');
  const roles = typeof args.flags.repo === 'string' ? path.join(path.resolve(ctx.cwd, args.flags.repo), 'agents', 'roles.yml') : findLanes(ctx.cwd);
  if (!roles || !fs.existsSync(roles)) throw new PocketError('no staked repo found (agents/roles.yml) here or above; pass --repo');
  const doc: any = parse(fs.readFileSync(roles, 'utf8')) ?? {};
  const pp = doc.provider_policy;
  const p = paths(ctx.env);
  const providers = loadProviders(p);
  const agents: Record<string, { order?: string[]; daily_cap_usd?: number }> = {};
  if (pp && typeof pp === 'object') {
    for (const [agent, v] of Object.entries<any>(pp)) {
      const order = Array.isArray(v?.order) ? v.order.map(String) : undefined;
      const unknown = (order ?? []).filter((id: string) => !providers[id]);
      if (unknown.length) ctx.err(`warning: ${agent}: unknown provider(s) ${unknown.join(', ')} (kept; they are skipped at routing time)`);
      agents[agent] = {
        ...(order ? { order } : {}),
        ...(typeof v?.daily_cap_usd === 'number' ? { daily_cap_usd: v.daily_cap_usd } : {}),
      };
    }
  }
  writePrivate(p.agentPolicy, JSON.stringify({ source: roles, synced_on: today(new Date()), agents }, null, 2) + '\n');
  if (!Object.keys(agents).length) ctx.out(`${roles} has no provider_policy; cleared per-agent overrides`);
  for (const [a, v] of Object.entries(agents)) ctx.out(`${a.padEnd(12)} order: ${(v.order ?? ['(global)']).join(' → ')}${v.daily_cap_usd !== undefined ? `   cap $${v.daily_cap_usd}/day` : ''}`);
  ctx.out(`wrote ${p.agentPolicy}. Agents are identified by the x-pocket-agent header the attach launchers set.`);
  return 0;
}

// ------------------------------------------------------------------ dash

export async function cmdDash(ctx: Ctx, args: Args): Promise<number> {
  const p = paths(ctx.env);
  const run = await running(ctx.env);
  if (!run) throw new PocketError('daemon is not running: `pocket daemon start`');
  const url = `http://127.0.0.1:${run.port}/dash?token=${encodeURIComponent(localToken(p))}`;
  ctx.out(url);
  if (args.flags['no-open']) return 0;
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: 'ignore' });
    c.on('error', () => ctx.err('could not open a browser; open the URL above'));
    c.unref();
  } catch {
    ctx.err('could not open a browser; open the URL above');
  }
  return 0;
}

// ------------------------------------------------------------------ route (send one test request through the daemon)

export async function cmdRoute(ctx: Ctx, args: Args): Promise<number> {
  const p = paths(ctx.env);
  const run = await running(ctx.env);
  if (!run) throw new PocketError('daemon is not running: `pocket daemon start`');
  const prompt = args._.join(' ') || 'Reply with the single word: pong';
  const model = typeof args.flags.model === 'string' ? args.flags.model : 'claude-sonnet-4-5';
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${localToken(p)}`, 'anthropic-version': '2023-06-01' };
  if (typeof args.flags.agent === 'string') headers['x-pocket-agent'] = args.flags.agent;
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${run.port}/anthropic/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
  });
  const body: any = await r.json();
  if (!r.ok) {
    ctx.err(`HTTP ${r.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
    return 1;
  }
  ctx.out(`provider: ${r.headers.get('x-pocket-provider')}  model: ${r.headers.get('x-pocket-model')}  ${Date.now() - t0} ms`);
  ctx.out((body.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''));
  return 0;
}

// ------------------------------------------------------------------ models

/** `pocket models [--refresh]`: which models pocket will use per provider and tier, and where that came from. */
export async function cmdModels(ctx: Ctx, args: Args, ksOverride?: Keystore): Promise<number> {
  const p = paths(ctx.env);
  const providers = loadProviders(p);
  const cat = Catalog.forPaths(p, () => Date.now(), () => {});
  const ks = args.flags.refresh ? (ksOverride ?? (await keystoreFor(ctx.env))) : null;
  for (const [id, prov] of Object.entries(providers)) {
    const key = ks ? ks.get(id) : null;
    if (ks && key) await cat.refresh(prov, key);
    const at = cat.fetchedAt(id);
    const live = cat.models(id);
    const src = live && at ? `live list from ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} (${live.length} models)` : 'providers.json (no live list yet: run `pocket models --refresh`)';
    ctx.out(`${id}: ${src}`);
    for (const tier of ['strong', 'mid', 'fast'] as const) {
      const c = cat.candidates(prov, tier);
      ctx.out(`  ${tier.padEnd(6)} ${c.length ? c.join('  >  ') : '(nothing usable)'}`);
    }
  }
  if (!args.flags.refresh) ctx.out('\nThe daemon refreshes these lists on its own; --refresh fetches them now with your keys.');
  return 0;
}
