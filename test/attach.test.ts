import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { codexAttachText, codexDetachText } from '../src/commands/attach.js';
import { pocket, tmpDir } from './helpers.js';

const CODEX_FILES: Record<string, string> = {
  'typical config with a model_provider line': `# my codex config
model = "gpt-5-codex"
model_provider = "openai"
approval_policy = "on-request"

[model_providers.azure]
name = "Azure"
base_url = "https://example.invalid/openai"
env_key = "AZURE_KEY"

[mcp_servers.files]
command = "npx"
args = ["-y", "some-mcp-server"]
env = { "TOKEN_ENV" = "x" }
`,
  'no model_provider, no trailing newline': 'model = "o3"\n[profiles.fast]\nmodel = "gpt-4.1-mini"',
  'CRLF line endings': 'model = "gpt-5"\r\nmodel_provider = "openai"\r\n\r\n[tui]\r\nnotifications = true\r\n',
  'empty file': '',
  'only tables': '[shell_environment_policy]\ninherit = "core"\n',
};

function setup() {
  const home = tmpDir();
  const codexHome = tmpDir();
  return { home, codexHome, env: { POCKET_HOME: home, CODEX_HOME: codexHome } };
}

describe('attach codex / detach codex', () => {
  for (const [name, content] of Object.entries(CODEX_FILES)) {
    it(`byte-identical after attach then detach: ${name}`, async () => {
      const { env, codexHome, home } = setup();
      const file = path.join(codexHome, 'config.toml');
      fs.writeFileSync(file, content);
      const before = fs.readFileSync(file);
      let r = await pocket(['attach', 'codex', '--bin-dir', path.join(home, 'bin')], env);
      expect(r.code, r.err).toBe(0);
      const attached = fs.readFileSync(file, 'utf8');
      const parsed: any = parseToml(attached);
      expect(parsed.model_providers.pocket).toMatchObject({ name: 'pocket', base_url: 'http://127.0.0.1:3460/openai/v1', env_key: 'POCKET_TOKEN', wire_api: 'responses', http_headers: { 'x-pocket-agent': 'codex' } });
      expect(parsed.profiles.pocket).toEqual({ model_provider: 'pocket' });
      // plain `codex` is untouched: the top-level model_provider and every other key stay as they were
      const orig: any = parseToml(content);
      const now: any = structuredClone(parsed);
      for (const t of ['model_providers', 'profiles']) {
        delete now[t].pocket;
        if (!Object.keys(now[t]).length) delete now[t];
      }
      expect(now).toEqual(orig);
      if (content.includes('\r\n')) expect(attached.replace(/\r\n/g, '')).not.toContain('\n');
      // the launcher passes the local token via POCKET_TOKEN
      const launcher = fs.readFileSync(path.join(home, 'bin', process.platform === 'win32' ? 'codex-pocket.cmd' : 'codex-pocket'), 'utf8');
      expect(launcher).toContain('POCKET_TOKEN');
      expect(launcher).toContain('codex --profile pocket');
      r = await pocket(['detach', 'codex'], env);
      expect(r.code, r.err).toBe(0);
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(fs.existsSync(file + '.pocket-backup')).toBe(false);
    });
  }

  it('no config.toml before: detach removes the one attach created', async () => {
    const { env, codexHome } = setup();
    await pocket(['attach', 'codex'], env);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(true);
    await pocket(['detach', 'codex'], env);
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  it('if the user edited config.toml after attach, detach removes only pocket lines and keeps their edit', async () => {
    const { env, codexHome } = setup();
    const file = path.join(codexHome, 'config.toml');
    fs.writeFileSync(file, CODEX_FILES['typical config with a model_provider line']);
    await pocket(['attach', 'codex'], env);
    fs.appendFileSync(file, '\n[history]\npersistence = "none"\n');
    const r = await pocket(['detach', 'codex'], env);
    expect(r.out).toMatch(/removed only the pocket lines/);
    const after: any = parseToml(fs.readFileSync(file, 'utf8'));
    expect(after.model_provider).toBe('openai');
    expect(after.model_providers.pocket).toBeUndefined();
    expect(after.history.persistence).toBe('none');
    expect(after.model_providers.azure.env_key).toBe('AZURE_KEY');
  });

  it('refuses broken TOML and an existing pocket provider', () => {
    expect(() => codexAttachText('model = [', 'u', 'codex')).toThrow(/does not parse/);
    expect(() => codexAttachText('[model_providers.pocket]\nname="x"\n', 'u', 'codex')).toThrow(/already defines/);
    expect(() => codexAttachText('model_providers = { a = { name = "a" } }\n', 'u', 'codex')).toThrow(/would break config.toml/);
  });

  it('textual undo with no original model_provider line drops ours', () => {
    const { text } = codexAttachText('model = "o3"\n', 'u', 'codex');
    expect(codexDetachText(text, null)).toBe('model = "o3"\n');
  });

  it('refuses an existing [profiles.pocket]', () => {
    expect(() => codexAttachText('[profiles.pocket]\nmodel = "x"\n', 'u', 'codex')).toThrow(/already defines \[profiles.pocket\]/);
  });

  it('detach still cleans up a config attached by pocket 0.1.1 (top-level model_provider + wire_api chat)', () => {
    const old = 'model = "gpt-5-codex"\nmodel_provider = "pocket" # pocket\n\n# >>> pocket: added by `pocket attach codex`; remove with `pocket detach codex`\n[model_providers.pocket]\nname = "pocket"\nwire_api = "chat"\n# <<< pocket\n';
    expect(codexDetachText(old, null)).toBe('model = "gpt-5-codex"\n');
    expect(codexDetachText(old, 'model_provider = "openai"')).toBe('model = "gpt-5-codex"\nmodel_provider = "openai"\n');
  });
});

describe('attach claude / detach claude', () => {
  it('writes a claude-pocket launcher with base URL, local token and agent header', async () => {
    const { env, home } = setup();
    const r = await pocket(['attach', 'claude', '--bin-dir', path.join(home, 'bin')], env);
    expect(r.code, r.err).toBe(0);
    const file = path.join(home, 'bin', process.platform === 'win32' ? 'claude-pocket.cmd' : 'claude-pocket');
    const text = fs.readFileSync(file, 'utf8');
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
    expect(text).toContain('ANTHROPIC_BASE_URL');
    expect(text).toContain('http://127.0.0.1:3460/anthropic');
    expect(text).toContain(token);
    expect(text).toContain('x-pocket-agent: claude-code');
    expect(text).toMatch(/unset ANTHROPIC_API_KEY|set "ANTHROPIC_API_KEY="/);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o700);
    expect(r.out).toMatch(/rerun with --vscode/);
    await pocket(['detach', 'claude'], env);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('--vscode adds claudeCode.environmentVariables; detach leaves settings.json byte-identical', async () => {
    const { env, home } = setup();
    const vs = path.join(home, 'vscode-settings.json');
    const original = '{\n    "editor.fontSize": 14,\n    "claudeCode.environmentVariables": [{ "name": "FOO", "value": "bar" }]\n}\n';
    fs.writeFileSync(vs, original);
    await pocket(['attach', 'claude', '--vscode', '--vscode-settings', vs, '--bin-dir', path.join(home, 'bin')], env);
    const s = JSON.parse(fs.readFileSync(vs, 'utf8'));
    expect(s['editor.fontSize']).toBe(14);
    expect(s['claudeCode.environmentVariables'].map((e: any) => e.name)).toEqual(['FOO', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']);
    await pocket(['detach', 'claude'], env);
    expect(fs.readFileSync(vs, 'utf8')).toBe(original);
  });

  it('a settings.json with comments is not edited; the snippet is printed instead', async () => {
    const { env, home } = setup();
    const vs = path.join(home, 's.json');
    const original = '{\n  // my comment\n  "a": 1\n}\n';
    fs.writeFileSync(vs, original);
    const r = await pocket(['attach', 'claude', '--vscode', '--vscode-settings', vs, '--bin-dir', path.join(home, 'bin')], env);
    expect(r.err).toMatch(/not plain JSON; not editing it/);
    expect(fs.readFileSync(vs, 'utf8')).toBe(original);
  });
});

describe('attach cursor', () => {
  it('prints settings with a path-based agent id; --write refuses with the reason', async () => {
    const { env, home } = setup();
    const token = (await pocket(['attach', 'cursor'], env)).out;
    expect(token).toContain('http://127.0.0.1:3460/a/cursor/openai/v1');
    expect(token).toContain(fs.readFileSync(path.join(home, 'token'), 'utf8').trim());
    expect(token).toMatch(/Agent\/Composer/);
    const w = await pocket(['attach', 'cursor', '--write'], env);
    expect(w.code).toBe(2);
    expect(w.err).toMatch(/internal app database/);
  });
});
