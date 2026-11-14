import { afterEach, describe, expect, it } from 'vitest';
import { anthropicPost, json, rig, Rig } from './helpers.js';
import { capFromError, isModelGone, paramsB, parseModels, rank } from '../src/catalog.js';
import type { Provider } from '../src/providers.js';

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

// the exact errors from a real install on 2026-11-14
const GROQ_MAX = '400 {"error":{"message":"`max_tokens` must be less than or equal to `65536`, the maximum value for `max_tokens` is less than the `context_window` for this model","type":"invalid_request_error"}}';
const NVIDIA_GONE = '410 {"type":"about:blank","title":"Gone","status":410,"detail":"The model \'meta/llama-3.3-70b-instruct\' has reached its end of life"}';
const OPENROUTER_PAID = '404 {"error":{"message":"This model is unavailable for free. The paid version is available now - use this slug instead: openai/gpt-oss-120b"}}';

const prov = (id: string, tiers: any = { strong: 'old-model', mid: 'old-model', fast: 'old-model' }): Provider => ({ id, base_url: 'x', format: 'openai', paid: false, limits: {}, verified_on: null, tiers });

describe('catalog: pure parts', () => {
  it('reads limits and retirements from real provider errors', () => {
    expect(capFromError(GROQ_MAX)).toBe(65536);
    expect(capFromError('400 unsupported parameter: tools')).toBe(null);
    expect(isModelGone(410, NVIDIA_GONE)).toBe(true);
    expect(isModelGone(404, OPENROUTER_PAID)).toBe(true);
    expect(isModelGone(400, GROQ_MAX)).toBe(false); // a limit, not a missing model
    expect(isModelGone(400, '400 messages: invalid role')).toBe(false);
  });

  it('parses model lists from OpenAI-style, Groq and OpenRouter shapes', () => {
    const ms = parseModels({
      data: [
        { id: 'openai/gpt-oss-120b', context_window: 131072, max_completion_tokens: 65536, active: true },
        { id: 'retired-model', active: false },
        { id: 'x/coder:free', context_length: 262144, supported_parameters: ['tools', 'temperature'], pricing: { prompt: '0', completion: '0' } },
        { id: 'x/chat-no-tools:free', supported_parameters: ['temperature'], pricing: { prompt: '0', completion: '0' } },
      ],
    });
    expect(ms.map((m) => m.id)).toEqual(['openai/gpt-oss-120b', 'x/coder:free', 'x/chat-no-tools:free']);
    expect(ms[0]).toMatchObject({ context: 131072, maxOutput: 65536 });
    expect(ms[1]).toMatchObject({ tools: true, free: true });
    expect(ms[2].tools).toBe(false);
  });

  it('ranks a live list: big current coding models for strong, small fast ones for fast, junk out', () => {
    expect(paramsB('nvidia/nemotron-3-ultra-550b-a55b')).toBe(550);
    expect(paramsB('openai/gpt-oss-20b')).toBe(20);
    // part of NVIDIA's real list on 2026-11-14
    const live = parseModels({
      data: ['meta/llama2-70b', 'nvidia/nv-embedqa-mistral-7b-v2', 'meta/llama-guard-4-12b', 'moonshotai/kimi-k2.6', 'deepseek-ai/deepseek-v4.1-flash', 'nvidia/nemotron-3-super-120b-a12b', 'openai/gpt-oss-20b', 'google/gemma-2b', 'mistralai/mixtral-8x22b-v0.1'].map((id) => ({ id })),
    });
    const p = prov('nvidia');
    const strong = rank(p, live, 'strong');
    expect(strong.slice(0, 3)).toEqual(expect.arrayContaining(['moonshotai/kimi-k2.6', 'nvidia/nemotron-3-super-120b-a12b']));
    expect(strong).not.toContain('nvidia/nv-embedqa-mistral-7b-v2');
    expect(strong).not.toContain('meta/llama-guard-4-12b');
    expect(strong.indexOf('meta/llama2-70b')).toBeGreaterThan(strong.indexOf('openai/gpt-oss-20b'));
    expect(rank(p, live, 'fast')[0]).toMatch(/gpt-oss-20b|flash/);
    // OpenRouter: only free models, and only ones that can call tools
    const or = parseModels({
      data: [
        { id: 'openai/gpt-5', supported_parameters: ['tools'], pricing: { prompt: '0.000001', completion: '0.000002' } },
        { id: 'a/no-tools:free', supported_parameters: [], pricing: { prompt: '0', completion: '0' } },
        { id: 'openrouter/free', supported_parameters: ['tools'] },
        { id: 'b/coder-480b:free', supported_parameters: ['tools'], pricing: { prompt: '0', completion: '0' } },
      ],
    });
    expect(rank(prov('openrouter'), or, 'strong').sort()).toEqual(['b/coder-480b:free', 'openrouter/free']);
  });
});

describe('catalog: live behaviour through the daemon', () => {
  it('groq says max_tokens <= 65536: pocket remembers it and resends, once; later requests are capped up front', async () => {
    const seen: number[] = [];
    r = await rig({
      policy: 'order: [groq]\n',
      groq: (req, res) => {
        if (!req.body) return json(res, 404, {});
        seen.push(req.body.max_tokens);
        if (req.body.max_tokens > 65536) return json(res, 400, JSON.parse(GROQ_MAX.slice(4)));
        json(res, 200, { id: 'c', object: 'chat.completion', model: req.body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    const body = { model: 'claude-opus-5-5', max_tokens: 128000, messages: [{ role: 'user', content: 'hi' }] };
    expect((await anthropicPost(r, body)).status).toBe(200);
    expect((await anthropicPost(r, body)).status).toBe(200);
    expect(seen).toEqual([128000, 65536, 65536]);
  });

  it('a retired model is dropped and the next model from the live list answers, in the same request', async () => {
    const asked: string[] = [];
    r = await rig({
      policy: 'order: [groq]\n',
      groq: (req, res) => {
        if (!req.body) return json(res, 404, {});
        asked.push(req.body.model);
        if (req.body.model !== 'moonshotai/kimi-k2.6') return json(res, 410, JSON.parse(NVIDIA_GONE.slice(4)));
        json(res, 200, { id: 'c', object: 'chat.completion', model: req.body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'from kimi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    // the provider's live list no longer has the providers.json preference; give pocket a moment to read it
    r.groq.models = { data: [{ id: 'nvidia/nemotron-3-super-120b-a12b' }, { id: 'moonshotai/kimi-k2.6' }, { id: 'openai/gpt-oss-20b' }] };
    (r.app.deps as any).catalog.touch((r.app.deps.providers() as any).groq, 'k');
    await new Promise((ok) => setTimeout(ok, 100));
    const res = await anthropicPost(r, { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).content[0].text).toBe('from kimi');
    expect(asked[asked.length - 1]).toBe('moonshotai/kimi-k2.6');
    expect(asked).not.toContain('openai/gpt-oss-120b'); // the stale providers.json preference was never tried
    // the dropped model stays dropped
    const before = asked.length;
    await anthropicPost(r, { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'again' }] });
    expect(asked.slice(before)).toEqual(['moonshotai/kimi-k2.6']);
  });

  it('when every model a provider lists is gone, pocket moves on to the next provider', async () => {
    r = await rig({
      policy: 'order: [groq, anthropic]\n',
      groq: (req, res) => (req.body ? json(res, 404, JSON.parse(OPENROUTER_PAID.slice(4))) : json(res, 404, {})),
    });
    const res = await anthropicPost(r, { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-pocket-provider')).toBe('anthropic');
  });
});
