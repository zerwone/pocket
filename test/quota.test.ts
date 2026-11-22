import { afterEach, describe, expect, it } from 'vitest';
import { durationMs, Meter, quotaFromHeaders, resetFrom } from '../src/meter.js';
import { isModelGone, parseModels, usable } from '../src/catalog.js';
import { anthropicPost, json, rig, Rig } from './helpers.js';

const T0 = Date.parse('2026-11-22T12:00:00Z');
const groq: any = { id: 'groq', paid: false, limits: {} };
const hdr = (h: Record<string, string>) => (n: string) => h[n] ?? null;

// real error text from Gemini's free tier for a model without free quota (shape from their 429 body)
const GEMINI_ZERO = '429 {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3-pro","status":"RESOURCE_EXHAUSTED"}}';

describe('provider quota from headers', () => {
  it('reads durations the way providers write them', () => {
    expect(durationMs('7.66s', T0)).toBeCloseTo(7660);
    expect(durationMs('1m30s', T0)).toBe(90_000);
    expect(durationMs('2h', T0)).toBe(7_200_000);
    expect(durationMs('250ms', T0)).toBe(250);
    expect(durationMs('30', T0)).toBe(30_000);
    expect(durationMs(String(T0 + 5000), T0)).toBe(5000); // epoch ms (OpenRouter)
    expect(durationMs(null, T0)).toBeNull();
  });

  it('reads OpenAI/Groq, Cerebras and OpenRouter header names', () => {
    expect(quotaFromHeaders(hdr({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-reset-requests': '2m' }), T0)).toEqual({ req_remaining: 0, req_limit: 1000, req_reset_ms: 120_000 });
    expect(quotaFromHeaders(hdr({ 'x-ratelimit-remaining-requests-day': '12', 'x-ratelimit-remaining-tokens-minute': '500' }), T0)).toEqual({ req_remaining: 12, tok_remaining: 500 });
    expect(quotaFromHeaders(hdr({ 'x-ratelimit-remaining': '3', 'x-ratelimit-limit': '50' }), T0)).toEqual({ req_remaining: 3, req_limit: 50 });
    expect(quotaFromHeaders(hdr({}), T0)).toEqual({});
  });

  it('remaining 0 cools the provider down until its reset, before it 429s', () => {
    const m = new Meter();
    m.observe('groq', { req_remaining: 0, req_reset_ms: 45_000 }, T0);
    expect(m.blocked(groq, T0 + 44_000)).toMatch(/cooling down/);
    expect(m.blocked(groq, T0 + 45_000)).toBeNull();
    expect(m.get('groq', T0).live?.req_remaining).toBe(0);
  });

  it('a 429 waits for the window that is used up', () => {
    expect(resetFrom({ tok_remaining: 0, tok_reset_ms: 9000, req_remaining: 10, req_reset_ms: 60_000 })).toBe(9000);
    expect(resetFrom({ req_remaining: 5 })).toBeNull();
  });

  it('429s without a stated wait back off harder each time, and a success resets that', () => {
    const m = new Meter();
    m.rateLimited('groq', T0, 60_000);
    expect(m.get('groq', T0).cooldownUntil - T0).toBe(60_000);
    m.rateLimited('groq', T0, 60_000);
    expect(m.get('groq', T0).cooldownUntil - T0).toBe(120_000);
    m.rateLimited('groq', T0, 60_000);
    expect(m.get('groq', T0).cooldownUntil - T0).toBe(240_000);
    m.rateLimited('groq', T0, 30_000, true); // provider said 30s: believe it
    expect(m.get('groq', T0).cooldownUntil - T0).toBe(30_000);
    m.tokens('groq', 10, 0, T0);
    m.rateLimited('groq', T0, 60_000);
    expect(m.get('groq', T0).cooldownUntil - T0).toBe(60_000);
  });
});

describe('free-only providers', () => {
  it('a 429 with quota 0 for one model means that model, not the provider', () => {
    expect(isModelGone(429, GEMINI_ZERO)).toBe(true);
    expect(isModelGone(429, '429 {"error":{"message":"Rate limit reached for requests per minute"}}')).toBe(false);
  });

  it('Gemini lists "models/…" ids; pocket uses the bare id', () => {
    expect(parseModels({ data: [{ id: 'models/gemini-3.8-flash' }] }).map((m) => m.id)).toEqual(['gemini-3.8-flash']);
  });

  it('free_models limits the live list to the free models', () => {
    const zai: any = { id: 'zai', free_models: '-flash$' };
    expect(usable(zai, { id: 'glm-4.7-flash' })).toBe(true);
    expect(usable(zai, { id: 'glm-4.7-flashx' })).toBe(false);
    expect(usable(zai, { id: 'glm-5' })).toBe(false);
  });

  let r: Rig | undefined;
  afterEach(async () => {
    await r?.close();
    r = undefined;
  });

  it('end to end: a quota-0 model is skipped and the same provider answers with the next model', async () => {
    const asked: string[] = [];
    r = await rig({
      policy: 'order: [groq]\n',
      groq: (req, res) => {
        if (!req.body) return json(res, 404, {});
        asked.push(req.body.model);
        if (req.body.model === 'big-pro-model') return json(res, 429, JSON.parse(GEMINI_ZERO.slice(4)));
        json(res, 200, { id: 'c', object: 'chat.completion', model: req.body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    r.groq.models = { data: [{ id: 'big-pro-model' }, { id: 'small-flash-8b' }] };
    (r.app.deps as any).catalog.touch((r.app.deps.providers() as any).groq, 'k');
    await new Promise((ok) => setTimeout(ok, 100));
    const res = await anthropicPost(r, { model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(asked).toContain('big-pro-model');
    expect(asked[asked.length - 1]).toBe('small-flash-8b');
    expect(r.app.deps.state.meter.get('groq', Date.now()).cooldownUntil).toBe(0); // provider not cooled down
  });
});
