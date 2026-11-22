import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { APP_LINE, codexAppAttachText, codexAppDetachText, codexAttachText } from '../src/commands/attach.js';
import { DEFAULT_POLICY_YAML, orderEdit, parsePolicy } from '../src/policy.js';
import { underNpx } from '../src/install.js';
import { pocket, rig, Rig, tmpDir } from './helpers.js';

const TYPICAL = `# my codex config
model = "gpt-5-codex"
approval_policy = "on-request"

[model_providers.azure]
name = "Azure"
base_url = "https://example.invalid/openai"
env_key = "AZURE_KEY"
`;

describe('Codex desktop app', () => {
  it('points all of Codex at pocket with a top-level provider, and detach restores the file byte for byte', async () => {
    for (const content of [TYPICAL, '', 'model = "o3"\r\n[tui]\r\nnotifications = true\r\n', '[shell_environment_policy]\ninherit = "core"']) {
      const home = tmpDir();
      const codexHome = tmpDir();
      const env = { POCKET_HOME: home, CODEX_HOME: codexHome };
      const file = path.join(codexHome, 'config.toml');
      fs.writeFileSync(file, content);
      let r = await pocket(['attach', 'codex-app'], env);
      expect(r.code, r.err).toBe(0);
      const cfg: any = parseToml(fs.readFileSync(file, 'utf8'));
      expect(cfg.model_provider).toBe('pocket_app');
      expect(cfg.model_providers.pocket_app.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openai\/v1$/);
      expect(cfg.model_providers.pocket_app.wire_api).toBe('responses');
      // the app starts from the desktop and never sees shell variables: the local token is in the file
      expect(cfg.model_providers.pocket_app.experimental_bearer_token).toBe(fs.readFileSync(path.join(home, 'token'), 'utf8').trim());
      r = await pocket(['detach', 'codex-app'], env);
      expect(r.code, r.err).toBe(0);
      expect(fs.readFileSync(file, 'utf8')).toBe(content);
    }
  });

  it('refuses to override a provider the user already chose for the whole app', () => {
    expect(() => codexAppAttachText('model_provider = "azure"\n', 'http://127.0.0.1:3460/openai/v1', 'pk-local-x')).toThrow(/already sets model_provider = "azure"/);
  });

  it('works next to the CLI profile, and each detaches on its own', () => {
    const withCli = codexAttachText(TYPICAL, 'http://127.0.0.1:3460/openai/v1', 'codex').text;
    const both = codexAppAttachText(withCli, 'http://127.0.0.1:3460/openai/v1', 'pk-local-x');
    const cfg: any = parseToml(both);
    expect(Object.keys(cfg.model_providers).sort()).toEqual(['azure', 'pocket', 'pocket_app']);
    expect(codexAppDetachText(both)).toBe(withCli);
    expect(both.split('\n')[0]).toBe(APP_LINE);
  });

  it('edits after attach survive a detach', () => {
    const attached = codexAppAttachText(TYPICAL, 'http://127.0.0.1:3460/openai/v1', 'pk-local-x');
    const edited = attached.replace('approval_policy = "on-request"', 'approval_policy = "never"');
    const out = codexAppDetachText(edited);
    expect(out).toBe(TYPICAL.replace('approval_policy = "on-request"', 'approval_policy = "never"'));
  });
});

describe('Claude Desktop', () => {
  it('attach writes the import file with the gateway keys; detach removes it', async () => {
    const home = tmpDir();
    const env = { POCKET_HOME: home };
    const r = await pocket(['attach', 'claude-desktop'], env);
    expect(r.code, r.err).toBe(0);
    const file = path.join(home, 'claude-desktop-pocket.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cfg.inferenceProvider).toBe('gateway');
    expect(cfg.inferenceGatewayBaseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/desktop$/);
    expect(cfg.inferenceGatewayApiKey).toBe(fs.readFileSync(path.join(home, 'token'), 'utf8').trim());
    expect(cfg.inferenceGatewayAuthScheme).toBe('bearer');
    expect(cfg.inferenceModels.length).toBeGreaterThan(0);
    for (const m of cfg.inferenceModels) expect(m).toMatch(/^claude-/);
    expect(r.out).toMatch(/Configure Third-Party Inference/);
    await pocket(['detach', 'claude-desktop'], env);
    expect(fs.existsSync(file)).toBe(false);
  });

  let r: Rig | undefined;
  afterEach(async () => {
    await r?.close();
    r = undefined;
  });

  it('the /desktop gateway answers /v1/messages, /messages and /v1/models with bearer or x-api-key', async () => {
    r = await rig();
    const body = JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
    for (const [p, auth] of [
      ['/desktop/v1/messages', { authorization: `Bearer ${r.token}` }],
      ['/desktop/messages', { 'x-api-key': r.token }],
    ] as const) {
      const res = await fetch(r.base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...auth }, body });
      expect(res.status, p).toBe(200);
    }
    expect(r.app.deps.state.agents['claude-desktop']).toBeTruthy();
    const m: any = await (await fetch(r.base + '/desktop/v1/models', { headers: { authorization: `Bearer ${r.token}` } })).json();
    const ids = m.data.map((x: any) => x.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(m.data.find((x: any) => x.anthropic_family_tier === 'opus')).toBeTruthy();
    const bad = await fetch(r.base + '/desktop/v1/messages', { method: 'POST', headers: { 'x-api-key': 'wrong' }, body });
    expect(bad.status).toBe(401);
  });
});

describe('setup page API', () => {
  let r: Rig | undefined;
  afterEach(async () => {
    await r?.close();
    r = undefined;
  });

  const call = (r: Rig, method: string, route: string, body?: object, headers: Record<string, string> = { 'x-pocket-setup': '1' }) =>
    fetch(`${r.base}/setup/api/${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}`, ...headers }, body: body ? JSON.stringify(body) : undefined });

  it('state lists providers and apps without any key', async () => {
    r = await rig({ env: { CODEX_HOME: tmpDir() } });
    const s: any = await (await call(r, 'GET', 'state')).json();
    expect(s.providers.find((p: any) => p.id === 'groq').has_key).toBe(true);
    expect(JSON.stringify(s)).not.toContain('gsk_test_FREEKEY');
    expect(JSON.stringify(s)).not.toContain('sk-ant-test-PAIDKEY');
    expect(Object.keys(s.apps)).toEqual(['claude', 'codex', 'codex-app', 'claude-desktop', 'cursor']);
  });

  it('refuses changes without the page header or from another origin', async () => {
    r = await rig({ env: { CODEX_HOME: tmpDir() } });
    expect((await call(r, 'POST', 'attach', { target: 'claude-desktop' }, {})).status).toBe(403);
    expect((await call(r, 'POST', 'attach', { target: 'claude-desktop' }, { 'x-pocket-setup': '1', origin: 'https://evil.example' })).status).toBe(403);
    const ok: any = await (await call(r, 'POST', 'attach', { target: 'claude-desktop' }, { 'x-pocket-setup': '1', origin: r.base })).json();
    expect(ok.ok).toBe(true);
  });

  it('connects and disconnects an app with the same code as the CLI', async () => {
    const codexHome = tmpDir();
    r = await rig({ env: { CODEX_HOME: codexHome } });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), TYPICAL);
    let j: any = await (await call(r, 'POST', 'attach', { target: 'codex-app' })).json();
    expect(j.ok, j.message).toBe(true);
    expect(((await (await call(r, 'GET', 'state')).json()) as any).apps['codex-app'].attached).toBe(true);
    j = await (await call(r, 'POST', 'detach', { target: 'codex-app' })).json();
    expect(j.ok).toBe(true);
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toBe(TYPICAL);
    j = await (await call(r, 'POST', 'attach', { target: 'rm -rf' })).json();
    expect(j.ok).toBe(false);
  });

  it('adds a key (verified against the provider) and removes it', async () => {
    r = await rig({ keys: {}, env: { CODEX_HOME: tmpDir() } });
    // the fake groq answers GET /models with 200, so the key verifies
    r.groq.models = { data: [{ id: 'openai/gpt-oss-120b' }] };
    let j: any = await (await call(r, 'POST', 'keys', { provider: 'groq', key: 'gsk_new' })).json();
    expect(j.ok, j.message).toBe(true);
    let s: any = await (await call(r, 'GET', 'state')).json();
    expect(s.providers.find((p: any) => p.id === 'groq').has_key).toBe(true);
    j = await (await call(r, 'DELETE', 'keys/groq')).json();
    expect(j.ok).toBe(true);
    s = await (await call(r, 'GET', 'state')).json();
    expect(s.providers.find((p: any) => p.id === 'groq').has_key).toBe(false);
  });

  it('test request reports which provider answered', async () => {
    r = await rig({ env: { CODEX_HOME: tmpDir() } });
    const j: any = await (await call(r, 'POST', 'test')).json();
    expect(j.ok, j.message).toBe(true);
    expect(j.provider).toBe('anthropic');
  });

  it('serves the setup page and / redirects to it', async () => {
    r = await rig({ env: { CODEX_HOME: tmpDir() } });
    const page = await fetch(`${r.base}/setup?token=${r.token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Add free keys');
    const root = await fetch(`${r.base}/?token=${r.token}`, { redirect: 'manual' });
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe('/setup');
  });
});

describe('fallback order edits', () => {
  it('uncomments a commented provider, appends a new one, removes one, and keeps comments', () => {
    let t = orderEdit(DEFAULT_POLICY_YAML, 'mistral', true);
    expect(parsePolicy(t).order).toContain('mistral');
    expect(t).toContain('# free plan requests may train');
    t = orderEdit(t, 'gemini', true);
    expect(parsePolicy(t).order.slice(-1)).toEqual(['gemini']);
    t = orderEdit(t, 'gemini', false);
    expect(parsePolicy(t).order).not.toContain('gemini');
    expect(orderEdit(t, 'groq', true)).toBe(t); // already there
    expect(() => orderEdit('order: [groq]\n', 'gemini', true)).toThrow(/edit it by hand/);
  });
});

describe('npx', () => {
  it('knows when it runs from the npx cache', () => {
    expect(underNpx('/home/u/.npm/_npx/1a2b/node_modules/@zerwone/pocket/dist/main.js')).toBe(true);
    expect(underNpx('C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\1a2b\\node_modules\\@zerwone\\pocket\\dist\\main.js')).toBe(true);
    expect(underNpx('/usr/lib/node_modules/@zerwone/pocket/dist/main.js')).toBe(false);
  });
});
