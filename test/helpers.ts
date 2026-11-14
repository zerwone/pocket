import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startApp, App } from '../src/app.js';
import { memoryKeystore } from '../src/keystore.js';
import type { Ctx } from '../src/ctx.js';
import { run } from '../src/cli.js';

export const CLI = path.resolve(__dirname, '..', 'dist', 'main.js');

export function tmpDir(prefix = 'pocket-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface FakeReq {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export type Behaviour = (req: FakeReq, res: http.ServerResponse) => void | Promise<void>;

export interface Fake {
  url: string;
  port: number;
  requests: FakeReq[];
  /** GET .../models calls (pocket's live model list), kept out of `requests` */
  modelRequests: FakeReq[];
  /** what GET .../models returns; unset = the behaviour answers (404 if it can't) */
  models?: unknown;
  behaviour: Behaviour;
  close: () => Promise<void>;
}

export async function fakeServer(behaviour: Behaviour): Promise<Fake> {
  const requests: FakeReq[] = [];
  const modelRequests: FakeReq[] = [];
  const fake: any = { requests, modelRequests, behaviour };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const r: FakeReq = { path: req.url ?? '', headers: req.headers, body: text ? JSON.parse(text) : null };
    if (req.method === 'GET' && /\/models(\?|$)/.test(r.path)) {
      modelRequests.push(r);
      if (fake.models !== undefined) return json(res, 200, fake.models);
      // no list configured: let the behaviour answer (doctor's key checks use GET /models); a chat-only
      // behaviour that can't handle it gets a 404, so pocket falls back to providers.json tiers
      try {
        return await fake.behaviour(r, res);
      } catch {
        if (!res.headersSent) return json(res, 404, { error: { message: 'not found' } });
        return;
      }
    }
    requests.push(r);
    await fake.behaviour(r, res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  fake.port = port;
  fake.url = `http://127.0.0.1:${port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake as Fake;
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** An OpenAI-compatible provider that answers `text` (streaming or not), or a tool call when tools are offered and `tool` is set. */
export function openAIBehaviour(text: string, opts: { tool?: { name: string; args: object }; delayMs?: number } = {}): Behaviour {
  return async (req, res) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const model = req.body.model;
    const useTool = opts.tool && req.body.tools?.length && !req.body.messages.some((m: any) => m.role === 'tool');
    if (!req.body.stream) {
      const message: any = useTool
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: opts.tool!.name, arguments: JSON.stringify(opts.tool!.args) } }] }
        : { role: 'assistant', content: text };
      return json(res, 200, { id: 'chatcmpl-1', object: 'chat.completion', model, choices: [{ index: 0, message, finish_reason: useTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', model };
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (useTool) {
      const a = JSON.stringify(opts.tool!.args);
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: opts.tool!.name, arguments: '' } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(0, 5) } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(5) } }] }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      for (const w of text.match(/.{1,4}/gs) ?? []) send({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    send({ ...base, choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
    res.write('data: [DONE]\n\n');
    res.end();
  };
}

/** An Anthropic-compatible provider answering `text`. */
export function anthropicBehaviour(text: string): Behaviour {
  return (req, res) => {
    if (req.path.endsWith('/models')) return json(res, 200, { data: [] });
    const model = req.body.model;
    if (!req.body.stream) {
      return json(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 5 } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type: string, o: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } });
    ev('ping', {});
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', {});
    res.end();
  };
}

export const rateLimited: Behaviour = (req, res) => {
  if (req.path.endsWith('/models')) return json(res, 200, { data: [] });
  json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'quota exhausted' } }, { 'retry-after': '120' });
};

export interface Rig {
  home: string;
  app: App;
  base: string;
  token: string;
  paid: Fake; // anthropic-format, primary
  groq: Fake; // openai-format, fallback
  close: () => Promise<void>;
}

/** Daemon in-process with a memory keystore and two fake providers: anthropic (paid) → groq. */
export async function rig(opts: { paid?: Behaviour; groq?: Behaviour; policy?: string; keys?: Record<string, string> } = {}): Promise<Rig> {
  const home = tmpDir();
  const paid = await fakeServer(opts.paid ?? anthropicBehaviour('hello from anthropic'));
  const groq = await fakeServer(opts.groq ?? openAIBehaviour('hello from groq'));
  fs.writeFileSync(
    path.join(home, 'providers.json'),
    JSON.stringify({ providers: { anthropic: { base_url: paid.url }, groq: { base_url: groq.url + '/openai/v1' } } }),
  );
  fs.writeFileSync(
    path.join(home, 'pocket.yml'),
    opts.policy ??
      `order: [anthropic, groq]
caps:
  anthropic: { daily_cap_usd: 10 }
failover:
  on: [429, 5xx, timeout, connection]
  retry_same_provider: 1
  cooldown_seconds: 60
  timeout_seconds: 5
degraded_banner: true
`,
  );
  const ks = memoryKeystore(opts.keys ?? { anthropic: 'sk-ant-test-PAIDKEY', groq: 'gsk_test_FREEKEY' });
  const lines: string[] = [];
  const app = await startApp({ env: { ...process.env, POCKET_HOME: home }, port: 0, keystore: ks, log: (l) => lines.push(l) });
  (app as any).lines = lines;
  const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  return {
    home,
    app,
    base: `http://127.0.0.1:${app.port}`,
    token,
    paid,
    groq,
    close: async () => {
      await app.close();
      await paid.close();
      await groq.close();
    },
  };
}

export function anthropicPost(r: Rig, body: object, headers: Record<string, string> = {}) {
  return fetch(`${r.base}/anthropic/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}`, 'anthropic-version': '2023-06-01', ...headers },
    body: JSON.stringify(body),
  });
}

export function openaiPost(r: Rig, body: object, headers: Record<string, string> = {}) {
  return fetch(`${r.base}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}`, ...headers },
    body: JSON.stringify(body),
  });
}

/** Parse an SSE body into {event, data} objects. */
export async function sseEvents(res: Response): Promise<{ event?: string; data: any }[]> {
  const text = await res.text();
  return text
    .split(/\n\n/)
    .filter((b) => b.trim())
    .map((b) => {
      const ev = /^event: (.*)$/m.exec(b)?.[1];
      const data = b
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      return { event: ev, data: data === '[DONE]' ? '[DONE]' : JSON.parse(data) };
    });
}

export interface Result {
  code: number;
  out: string;
  err: string;
}

export async function pocket(argv: string[], env: Record<string, string | undefined>, opts: { secret?: string; cwd?: string } = {}): Promise<Result> {
  let out = '';
  let err = '';
  const ctx: Ctx = {
    env: { ...process.env, ...env },
    cwd: opts.cwd ?? process.cwd(),
    out: (s) => (out += s.endsWith('\n') ? s : s + '\n'),
    err: (s) => (err += s.endsWith('\n') ? s : s + '\n'),
    readSecret: async () => opts.secret ?? '',
    confirm: async () => false,
  };
  const code = await run(argv, ctx);
  return { code, out, err };
}

export function pocketBin(argv: string[], env: Record<string, string>, input?: string): Result {
  const r = spawnSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', env: { ...process.env, ...env }, input, timeout: 20000 });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** Recursively read every file under dir (for "no plaintext key on disk" checks). */
export function allText(dir: string): string {
  let s = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    s += e.isDirectory() ? allText(f) : fs.readFileSync(f).toString('latin1');
  }
  return s;
}
