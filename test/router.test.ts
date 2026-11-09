import { afterEach, describe, expect, it } from 'vitest';
import { anthropicBehaviour, anthropicPost, json, openaiPost, openAIBehaviour, rateLimited, rig, Rig, sseEvents } from './helpers.js';

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

const msg = (text: string, extra: object = {}) => ({ model: 'claude-sonnet-4-5', max_tokens: 100, messages: [{ role: 'user', content: text }], ...extra });

async function dash(r: Rig) {
  const res = await fetch(`${r.base}/dash/state`, { headers: { authorization: `Bearer ${r.token}` } });
  return res.json() as Promise<any>;
}

describe('routing without failure', () => {
  it('serves from the first provider and says so in headers', async () => {
    r = await rig();
    const res = await anthropicPost(r, msg('hi'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pocket-provider')).toBe('anthropic');
    expect(res.headers.get('x-pocket-model')).toBe('claude-sonnet-4-5');
    const body: any = await res.json();
    expect(body.content).toEqual([{ type: 'text', text: 'hello from anthropic' }]);
    // the provider got the user's own key for that provider, nothing else
    expect(r.paid.requests[0].headers['x-api-key']).toBe('sk-ant-test-PAIDKEY');
    expect(r.paid.requests[0].headers.authorization).toBeUndefined();
    expect(r.groq.requests).toHaveLength(0);
    expect((await dash(r)).failovers).toHaveLength(0);
  });
});

describe('429 failover (spec integration test)', () => {
  it('paid 429 → next provider, right x-pocket-provider, one dashboard event, banner once', async () => {
    r = await rig({ paid: rateLimited });
    const res = await anthropicPost(r, msg('first'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pocket-provider')).toBe('groq');
    expect(res.headers.get('x-pocket-model')).toBe("qwen/qwen3.8-27b");
    const body: any = await res.json();
    expect(body.content).toEqual([{ type: 'text', text: '[pocket] running on groq/qwen/qwen3.8-27b, anthropic quota exhausted (429)\n\nhello from groq' }]);
    // groq saw its own key only, in OpenAI format
    expect(r.groq.requests[0].headers.authorization).toBe('Bearer gsk_test_FREEKEY');
    expect(r.groq.requests[0].headers['x-api-key']).toBeUndefined();
    expect(r.groq.requests[0].body.messages).toEqual([{ role: 'user', content: 'first' }]);
    expect(r.paid.requests).toHaveLength(1); // a 429 is never retried on the same provider

    // second request: anthropic is cooling down (retry-after 120s), so it is skipped without being called
    const res2 = await anthropicPost(r, msg('second'));
    const body2: any = await res2.json();
    expect(res2.headers.get('x-pocket-provider')).toBe('groq');
    expect(body2.content).toEqual([{ type: 'text', text: 'hello from groq' }]); // banner only once
    expect(r.paid.requests).toHaveLength(1);

    const d = await dash(r);
    expect(d.failovers).toHaveLength(1);
    expect(d.failovers[0]).toMatchObject({ agent: 'default', from: 'anthropic', to: 'groq', reason: 'anthropic quota exhausted (429)' });
    expect(typeof d.failovers[0].latency_ms).toBe('number');
    expect(d.providers.anthropic.cooldown_until).not.toBeNull();
    expect(d.agents.default).toMatchObject({ provider: 'groq', degraded: true });
    expect(d.degraded).toBe(true);
  });

  it('streaming: failover before the first token, banner prefixed to the first text', async () => {
    r = await rig({ paid: rateLimited });
    const res = await anthropicPost(r, msg('stream please', { stream: true }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/event-stream/);
    expect(res.headers.get('x-pocket-provider')).toBe('groq');
    const ev = await sseEvents(res);
    const types = ev.map((e) => e.event);
    expect(types[0]).toBe('message_start');
    expect(ev[1].data).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    const text = ev.filter((e) => e.data.delta?.type === 'text_delta').map((e) => e.data.delta.text).join('');
    expect(text).toBe('[pocket] running on groq/qwen/qwen3.8-27b, anthropic quota exhausted (429)\n\nhello from groq');
    expect(new Set(ev.filter((e) => typeof e.data.index === 'number').map((e) => e.data.index))).toEqual(new Set([0]));
    expect(types[types.length - 1]).toBe('message_stop');
    // every event names a real event type and every data.type matches its event line
    for (const e of ev) expect(e.data.type).toBe(e.event);
  });

  it('streaming tool calls round-trip Anthropic → OpenAI provider → Anthropic', async () => {
    r = await rig({ paid: rateLimited, groq: openAIBehaviour('done', { tool: { name: 'read_file', args: { path: 'a.txt' } } }) });
    const tools = [{ name: 'read_file', description: 'read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }];
    const res = await anthropicPost(r, msg('read a.txt', { stream: true, tools }));
    const ev = await sseEvents(res);
    const start = ev.find((e) => e.data.content_block?.type === 'tool_use')!;
    expect(start.data.content_block).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'read_file' });
    // reply opens with a tool call: the banner gets its own text block 0 and the tool moves to index 1
    expect(ev[1].data).toEqual({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    expect(ev[2].data.delta.text).toMatch(/^\[pocket\] running on groq\//);
    expect(start.data.index).toBe(1);
    expect(ev.filter((e) => e.data.delta?.type === 'input_json_delta').every((e) => e.data.index === 1)).toBe(true);
    const args = ev.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
    expect(JSON.parse(args)).toEqual({ path: 'a.txt' });
    expect(ev.find((e) => e.event === 'message_delta')!.data.delta.stop_reason).toBe('tool_use');
    // the upstream got the tool in OpenAI form
    expect(r.groq.requests[0].body.tools[0]).toMatchObject({ type: 'function', function: { name: 'read_file' } });
    // and the tool result goes back as a role:tool message on the next turn
    await anthropicPost(r, {
      ...msg('x'),
      tools,
      messages: [
        { role: 'user', content: 'read a.txt' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'hello' }] },
      ],
    });
    expect(r.groq.requests[1].body.messages.slice(-1)[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'hello' });
  });

  it('after the first token the stream finishes on the same provider (no mid-stream switch)', async () => {
    r = await rig({
      paid: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
        res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } })}\n\n`);
        setTimeout(() => res.destroy(), 30); // connection dies mid-answer
      },
    });
    const res = await anthropicPost(r, msg('x', { stream: true }));
    expect(res.headers.get('x-pocket-provider')).toBe('anthropic');
    const text = await res.text();
    expect(text).toContain('partial');
    expect(text).toContain('event: error');
    expect(r.groq.requests).toHaveLength(0);
  });

  it('stream that breaks before the first token fails over', async () => {
    r = await rig({
      paid: (req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
        setTimeout(() => res.destroy(), 20);
      },
    });
    const res = await anthropicPost(r, msg('x', { stream: true }));
    expect(res.headers.get('x-pocket-provider')).toBe('groq');
    const ev = await sseEvents(res);
    expect(ev.filter((e) => e.data.delta?.text).map((e) => e.data.delta.text).join('')).toMatch(/^\[pocket\] running on groq\/.*anthropic unreachable\n\nhello from groq$/s);
  });

  it('5xx is retried once on the same provider, then fails over', async () => {
    let n = 0;
    r = await rig({
      paid: (req, res) => {
        n++;
        json(res, 503, { error: 'overloaded' });
      },
    });
    const res = await anthropicPost(r, msg('x'));
    expect(res.headers.get('x-pocket-provider')).toBe('groq');
    expect(n).toBe(2);
    const d = await dash(r);
    expect(d.failovers[0].reason).toBe('anthropic unavailable (503)');
  });

  it('a 5xx followed by success on the retry stays on the provider', async () => {
    let n = 0;
    r = await rig({ paid: (req, res) => (n++ === 0 ? json(res, 502, {}) : anthropicBehaviour('second try')(req, res)) });
    const res = await anthropicPost(r, msg('x'));
    expect(res.headers.get('x-pocket-provider')).toBe('anthropic');
    expect(((await res.json()) as any).content[0].text).toBe('second try');
  });

  it('timeouts and refused connections fail over', async () => {
    r = await rig({ paid: () => undefined /* never answers */ });
    const t0 = Date.now();
    const res = await anthropicPost(r, msg('x'));
    expect(res.headers.get('x-pocket-provider')).toBe('groq');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5000 * 2 - 200); // 5s timeout, tried twice
  }, 20000);

  it('the daily cap moves traffic to the free provider before any 429', async () => {
    r = await rig({ policy: 'order: [anthropic, groq]\ncaps:\n  anthropic: { daily_cap_usd: 0 }\n' });
    const res = await anthropicPost(r, msg('x'));
    expect(res.headers.get('x-pocket-provider')).toBe('groq');
    const body: any = await res.json();
    expect(body.content[0].text).toMatch(/anthropic daily_cap_usd is 0/);
    expect(r.paid.requests).toHaveLength(0);
  });

  it('when nothing can serve, the client gets a clear 503 in its own format', async () => {
    r = await rig({ paid: rateLimited, groq: rateLimited });
    const res = await anthropicPost(r, msg('x'));
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.type).toBe('error');
    expect(body.error.message).toMatch(/anthropic: quota exhausted \(429\); groq: quota exhausted \(429\)/);
    expect((await dash(r)).failovers.slice(-1)[0].to).toBeNull();
  });

  it('images go only to providers that support them; otherwise a clean 422', async () => {
    r = await rig({ paid: rateLimited });
    const img = { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] };
    // the only image-capable provider is rate-limited: 503 that says why
    const res = await anthropicPost(r, img);
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.message).toMatch(/groq: no image support/);
    expect(r.groq.requests).toHaveLength(0);
    await r.close();
    // no provider in the order supports images at all: 422
    r = await rig({ policy: 'order: [groq]\n' });
    const res2 = await anthropicPost(r, img);
    expect(res2.status).toBe(422);
    expect(((await res2.json()) as any).error.message).toMatch(/contains images/);
  });
});

describe('OpenAI-compatible endpoint (Codex, Cursor)', () => {
  it('chat completions route to an Anthropic upstream and back, streaming', async () => {
    r = await rig();
    const res = await openaiPost(r, { model: 'gpt-4.1', stream: true, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] });
    expect(res.headers.get('x-pocket-provider')).toBe('anthropic');
    const ev = await sseEvents(res);
    expect(ev[ev.length - 1].data).toBe('[DONE]');
    const text = ev.filter((e) => e.data !== '[DONE]').map((e) => e.data.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('hello from anthropic');
    expect(r.paid.requests[0].body.system).toBe('s');
    expect(r.paid.requests[0].body.model).toBe('claude-opus-5-5'); // gpt-4.1 → strong tier
  });

  it('agent identity from x-pocket-agent or the /a/<agent>/ path selects the agent policy', async () => {
    r = await rig({ policy: 'order: [anthropic, groq]\nagents:\n  reviewer: { order: [groq] }\n' });
    const a = await openaiPost(r, { model: 'gpt-4.1', messages: [{ role: 'user', content: 'x' }] }, { 'x-pocket-agent': 'reviewer' });
    expect(a.headers.get('x-pocket-provider')).toBe('groq');
    const b = await fetch(`${r.base}/a/reviewer/openai/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` }, body: JSON.stringify({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'x' }] }) });
    expect(b.headers.get('x-pocket-provider')).toBe('groq');
    const c = await openaiPost(r, { model: 'gpt-4.1', messages: [{ role: 'user', content: 'x' }] });
    expect(c.headers.get('x-pocket-provider')).toBe('anthropic');
    const body: any = await a.json();
    expect(body.choices[0].message.content).toBe('hello from groq'); // reviewer's primary is groq: not degraded, no banner
  });
});

describe('security', () => {
  it('rejects requests without the local token, or with a provider key instead of it', async () => {
    r = await rig();
    const noTok = await fetch(`${r.base}/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg('x')) });
    expect(noTok.status).toBe(401);
    expect(((await noTok.json()) as any).error.type).toBe('authentication_error');
    const wrong = await anthropicPost(r, msg('x'), { authorization: 'Bearer sk-ant-test-PAIDKEY' });
    expect(wrong.status).toBe(401);
    const oa = await fetch(`${r.base}/openai/v1/chat/completions`, { method: 'POST', body: '{}' });
    expect(oa.status).toBe(401);
    expect((await fetch(`${r.base}/dash/state`)).status).toBe(401);
    expect(r.paid.requests).toHaveLength(0);
  });

  it('refuses other Host headers (DNS rebinding) and never shows keys in /healthz or /dash', async () => {
    r = await rig();
    const res = await new Promise<number>((resolve) => {
      import('node:http').then((http) => {
        const req = http.request({ host: '127.0.0.1', port: r!.app.port, path: '/healthz', headers: { host: 'evil.example:3460' } }, (x) => resolve(x.statusCode!));
        req.end();
      });
    });
    expect(res).toBe(421);
    const h = await (await fetch(`${r.base}/healthz`)).text();
    expect(JSON.parse(h).providers.groq.has_key).toBe(true);
    const d = JSON.stringify(await dash(r));
    for (const s of [h, d]) {
      expect(s).not.toContain('PAIDKEY');
      expect(s).not.toContain('FREEKEY');
      expect(s).not.toContain(r.token);
    }
  });

  it('count_tokens is answered locally and spends no quota', async () => {
    r = await rig();
    const res = await fetch(`${r.base}/anthropic/v1/messages/count_tokens`, { method: 'POST', headers: { authorization: `Bearer ${r.token}`, 'content-type': 'application/json' }, body: JSON.stringify(msg('hello world')) });
    expect(((await res.json()) as any).input_tokens).toBeGreaterThan(0);
    expect(r.paid.requests).toHaveLength(0);
  });
});
