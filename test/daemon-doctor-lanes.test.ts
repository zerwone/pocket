import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryKeystore } from '../src/keystore.js';
import { cmdDoctor } from '../src/commands/misc.js';
import { checkBind } from '../src/server.js';
import { Ctx } from '../src/ctx.js';
import { fakeServer, json, pocket, pocketBin, tmpDir } from './helpers.js';

function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => r(p));
    });
  });
}

const started: Record<string, string>[] = [];
afterEach(() => {
  for (const env of started.splice(0)) pocketBin(['daemon', 'stop'], env);
});

describe('daemon', () => {
  it('start → status → healthz lists providers without keys → stop', async () => {
    const home = tmpDir();
    const port = String(await freePort());
    const env = { POCKET_HOME: home, POCKET_PORT: port, POCKET_KEYSTORE: 'memory', POCKET_TEST_KEYS: JSON.stringify({ groq: 'gsk_test_SHOULD_NOT_LEAK' }) };
    started.push(env);
    let r = pocketBin(['daemon', 'start'], env);
    expect(r.code, r.err + r.out).toBe(0);
    expect(r.out).toMatch(new RegExp(`started \\(pid \\d+\\) on http://127.0.0.1:${port}`));
    const pid = JSON.parse(fs.readFileSync(path.join(home, 'daemon.pid'), 'utf8'));
    expect(pid).toMatchObject({ port: Number(port), host: '127.0.0.1' });
    const h = await (await fetch(`http://127.0.0.1:${port}/healthz`)).text();
    expect(JSON.parse(h).providers.groq).toEqual({ has_key: true, verified_on: null });
    expect(JSON.parse(h).providers.anthropic.has_key).toBe(false);
    expect(h).not.toContain('SHOULD_NOT_LEAK');
    r = pocketBin(['daemon', 'status'], env);
    expect(r.out).toMatch(/running: pid/);
    expect(pocketBin(['daemon', 'start'], env).out).toMatch(/already running/);
    r = pocketBin(['daemon', 'logs'], env);
    expect(r.out).toMatch(/daemon listening on 127.0.0.1/);
    expect(r.out).not.toContain('SHOULD_NOT_LEAK');
    r = pocketBin(['daemon', 'stop'], env);
    expect(r.out).toMatch(/stopped/);
    expect(fs.existsSync(path.join(home, 'daemon.pid'))).toBe(false);
    expect(pocketBin(['daemon', 'status'], env).code).toBe(3);
  });

  it('refuses to bind to 0.0.0.0 without --i-know-this-is-exposed', async () => {
    const home = tmpDir();
    const r = pocketBin(['daemon', 'start', '--host', '0.0.0.0'], { POCKET_HOME: home, POCKET_KEYSTORE: 'memory' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/refusing to bind to 0.0.0.0/);
    expect(() => checkBind('0.0.0.0', false)).toThrow(/i-know-this-is-exposed/);
    expect(() => checkBind('192.168.1.5', false)).toThrow();
    expect(() => checkBind('127.0.0.1', false)).not.toThrow();
    expect(() => checkBind('::1', false)).not.toThrow();
    expect(() => checkBind('0.0.0.0', true)).not.toThrow();
  });
});

function ctxFor(env: Record<string, string>): { ctx: Ctx; out: () => string } {
  let out = '';
  return {
    ctx: { env: { ...process.env, ...env }, cwd: process.cwd(), out: (s) => (out += s + '\n'), err: (s) => (out += s + '\n'), readSecret: async () => '', confirm: async () => false },
    out: () => out,
  };
}

describe('doctor', () => {
  it('checks keychain, port, key validity, unverified limits and attached-but-down', async () => {
    const home = tmpDir();
    const fake = await fakeServer((req, res) => (req.headers.authorization === 'Bearer good' ? json(res, 200, { data: [] }) : json(res, 401, {})));
    fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: { groq: { base_url: fake.url, verified_on: null }, cerebras: { base_url: fake.url, verified_on: '2026-01-01' } } }));
    fs.writeFileSync(path.join(home, 'keys.json'), JSON.stringify({ groq: { added: '2026-11-01', verified_on: null }, cerebras: { added: '2026-11-01', verified_on: null } }));
    const port = String(await freePort());
    const env = { POCKET_HOME: home, POCKET_PORT: port };
    const { ctx, out } = ctxFor(env);
    const code = await cmdDoctor(ctx, { _: [], flags: { json: true } }, memoryKeystore({ groq: 'good', cerebras: 'bad' }));
    const checks = JSON.parse(out());
    const msg = (c: string) => checks.filter((x: any) => x.check === c).map((x: any) => `${x.level}: ${x.message}`);
    expect(msg('keychain')[0]).toMatch(/^ok/);
    expect(msg('port')[0]).toMatch(new RegExp(`ok: port ${port} is free`));
    expect(msg('key')).toEqual(expect.arrayContaining(['ok: groq: key valid', 'error: cerebras: key rejected (HTTP 401)']));
    expect(msg('limits').join('\n')).toMatch(/groq: free-tier limits never verified/);
    expect(msg('limits').join('\n')).toMatch(/cerebras: limits verified 2026-01-01, more than 30 days ago/);
    expect(code).toBe(1);
    // verified keys get their date recorded
    expect(JSON.parse(fs.readFileSync(path.join(home, 'keys.json'), 'utf8')).groq.verified_on).toBe(new Date().toISOString().slice(0, 10));
    // attached while the daemon is down is an error
    await pocket(['attach', 'claude', '--bin-dir', path.join(home, 'bin')], env);
    const c2 = ctxFor(env);
    await cmdDoctor(c2.ctx, { _: [], flags: { json: true, offline: true } }, memoryKeystore({ groq: 'good' }));
    expect(JSON.parse(c2.out()).find((x: any) => x.check === 'attached')).toMatchObject({ level: 'error', message: expect.stringMatching(/claude attached but the daemon is down/) });
    await fake.close();
  });
});

describe('staked sync', () => {
  it('reads provider_policy from a staked roles.yml and writes per-agent routing', async () => {
    const repo = tmpDir();
    fs.mkdirSync(path.join(repo, 'agents'));
    fs.writeFileSync(
      path.join(repo, 'agents', 'roles.yml'),
      `owner: alex
boss: claude-code
agents:
  claude-code:
    status: active
    lane: ["api/**"]
rules:
  - claim before start, one task at a time

# optional, read by \`pocket lanes sync\`
provider_policy:
  claude-code: { order: [anthropic, groq, cerebras, nvidia], daily_cap_usd: 10 }
  codex:       { order: [openai, nvidia, openrouter], daily_cap_usd: 5 }
  reviewer:    { order: [groq, cerebras, nvidia, nosuch] }     # free only
`,
    );
    const home = tmpDir();
    const r = await pocket(['staked', 'sync'], { POCKET_HOME: home }, { cwd: path.join(repo, 'agents') });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/claude-code\s+order: anthropic → groq → cerebras → nvidia\s+cap \$10\/day/);
    expect(r.err).toMatch(/reviewer: unknown provider\(s\) nosuch/);
    const synced = JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8'));
    expect(synced.agents.codex).toEqual({ order: ['openai', 'nvidia', 'openrouter'], daily_cap_usd: 5 });
    expect(synced.agents.reviewer).toEqual({ order: ['groq', 'cerebras', 'nvidia', 'nosuch'] });
    expect((await pocket(['lanes', 'sync'], { POCKET_HOME: home }, { cwd: tmpDir() })).err).toMatch(/no staked repo found/);
  });

  it('the real lanes repo next to this one parses (if present)', async () => {
    const lanesRoles = ['staked', 'lanes'].map((d) => path.resolve(__dirname, '..', '..', d, 'agents', 'roles.yml')).find((p) => fs.existsSync(p)) ?? '';
    if (!fs.existsSync(lanesRoles)) return;
    const home = tmpDir();
    const r = await pocket(['lanes', 'sync', '--repo', path.dirname(path.dirname(lanesRoles))], { POCKET_HOME: home });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'agents.json'), 'utf8')).agents['claude-code'].order[0]).toBe('anthropic');
  });
});
