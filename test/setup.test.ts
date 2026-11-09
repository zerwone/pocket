import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmdSetup, onPath } from '../src/commands/setup.js';
import { memoryKeystore } from '../src/keystore.js';
import { Ctx } from '../src/ctx.js';
import { tmpDir } from './helpers.js';

function fakeAgentDir(names: string[]) {
  const dir = tmpDir('pocket-path-');
  for (const n of names) {
    const f = path.join(dir, process.platform === 'win32' ? `${n}.cmd` : n);
    fs.writeFileSync(f, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  }
  return dir;
}

function scripted(env: NodeJS.ProcessEnv, answers: string[]) {
  let out = '';
  let err = '';
  const prompts: string[] = [];
  const ctx: Ctx = {
    env,
    cwd: process.cwd(),
    out: (s) => (out += s + '\n'),
    err: (s) => (err += s + '\n'),
    readSecret: async (p) => {
      prompts.push(p);
      return answers.shift() ?? '';
    },
    confirm: async () => false,
  };
  return { ctx, out: () => out, err: () => err, prompts };
}

describe('setup', () => {
  it('finds the agent on PATH, stores the keys given, skips the rest, attaches, prints how to run', async () => {
    const home = tmpDir();
    const bin = tmpDir('pocket-bin-');
    const env = { POCKET_HOME: home, PATH: fakeAgentDir(['claude']), PATHEXT: '.CMD' };
    const ks = memoryKeystore();
    // groq, nvidia (skip), openrouter (skip), cerebras, anthropic (skip)
    const s = scripted(env, ['gsk_test_key', '', '', 'csk_test_key', '']);
    const code = await cmdSetup(s.ctx, { _: [], flags: { 'no-verify': true, 'no-daemon': true, 'bin-dir': bin } }, ks);
    expect(code).toBe(0);
    expect(await ks.get('groq')).toBe('gsk_test_key');
    expect(await ks.get('cerebras')).toBe('csk_test_key');
    expect(await ks.get('nvidia')).toBeNull();
    expect(s.out()).toContain('Found: Claude Code');
    expect(s.out()).toContain('https://console.groq.com/keys');
    expect(s.out()).toMatch(/claude-pocket/);
    expect(s.out()).not.toMatch(/codex-pocket/);
    const launcher = fs.readdirSync(bin).find((f) => f.startsWith('claude-pocket'));
    expect(launcher).toBeTruthy();
    // the launcher starts the daemon itself, so the user never has to
    expect(fs.readFileSync(path.join(bin, launcher!), 'utf8')).toMatch(/daemon start --port \d+/);
    // keys never land in the config dir in plaintext
    const all = fs.readdirSync(home).map((f) => fs.readFileSync(path.join(home, f), 'utf8')).join('\n');
    expect(all).not.toContain('gsk_test_key');
  });

  it('refuses to finish with no keys at all', async () => {
    const env = { POCKET_HOME: tmpDir(), PATH: fakeAgentDir([]) };
    const s = scripted(env, ['', '', '', '', '']);
    const code = await cmdSetup(s.ctx, { _: [], flags: { 'no-verify': true, 'no-daemon': true } }, memoryKeystore());
    expect(code).toBe(1);
    expect(s.err()).toContain('No keys added');
    expect(s.out()).toContain('No Claude Code or Codex found');
  });

  it('onPath honours PATHEXT on Windows and plain names elsewhere', () => {
    const dir = fakeAgentDir(['codex']);
    expect(onPath('codex', { PATH: dir, PATHEXT: '.CMD' })).toBe(true);
    expect(onPath('claude', { PATH: dir, PATHEXT: '.CMD' })).toBe(false);
  });
});
