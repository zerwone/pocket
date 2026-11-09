import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { json, pocket, rig } from './helpers.js';

/**
 * Done-when check with the real Claude Code CLI: started through the claude-pocket launcher,
 * the paid provider answers 429, pocket moves to the free one, and the session finishes with
 * the degraded banner. The providers are local fakes (no real keys or network in CI).
 */
const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

describe.runIf(hasClaude)('real Claude Code session through claude-pocket', () => {
  it('survives a forced 429 and continues on the fallback with the banner; dash shows the event', async () => {
    const text = 'POCKET_FALLBACK_OK hello from the fallback';
    const r = await rig({
      paid: (req, res) => json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'quota exhausted' } }, { 'retry-after': '300' }),
      groq: (req, res) => {
        if (!req.body.stream) return json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const s = (o: object) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        for (const w of text.split(' ')) s({ choices: [{ index: 0, delta: { content: w + ' ' } }] });
        s({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.end('data: [DONE]\n\n');
      },
    });
    try {
      const bin = path.join(r.home, 'bin');
      const a = await pocket(['attach', 'claude', '--port', String(r.app.port), '--bin-dir', bin], { POCKET_HOME: r.home });
      expect(a.code, a.err).toBe(0);
      const launcher = path.join(bin, process.platform === 'win32' ? 'claude-pocket.cmd' : 'claude-pocket');
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-')),
        DISABLE_TELEMETRY: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
      };
      for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDECODE)/.test(k) || (k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) delete env[k];
      const child = spawn(launcher, ['-p', 'Say hello in five words.', '--output-format', 'json', '--model', 'claude-sonnet-4-5'], { env: env as NodeJS.ProcessEnv, cwd: r.home, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      const code = await new Promise((res) => child.on('exit', res));
      expect(code, err).toBe(0);
      const result = JSON.parse(out);
      expect(result.is_error).toBe(false);
      expect(result.result).toMatch(/^\[pocket\] running on groq\/qwen\/qwen3\.8-27b, anthropic quota exhausted \(429\)\n\nPOCKET_FALLBACK_OK hello from the fallback/);
      // Claude Code really went through pocket: one 429 from the paid provider, then the free one served
      expect(r.paid.requests.filter((x) => x.path === '/v1/messages')).toHaveLength(1);
      const g = r.groq.requests.find((x) => x.body?.stream);
      expect(g?.body.tools.length).toBeGreaterThan(0); // Claude Code's tools were translated to OpenAI format
      const dash: any = await (await fetch(`${r.base}/dash/state`, { headers: { authorization: `Bearer ${r.token}` } })).json();
      expect(dash.failovers).toHaveLength(1);
      expect(dash.failovers[0]).toMatchObject({ agent: 'claude-code', from: 'anthropic', to: 'groq', reason: 'anthropic quota exhausted (429)' });
      expect(dash.agents['claude-code']).toMatchObject({ provider: 'groq', degraded: true });
      console.log(`real claude-code failover: 429 → first token on fallback in ${dash.failovers[0].latency_ms} ms`);
    } finally {
      await r.close();
    }
  }, 120_000);
});
