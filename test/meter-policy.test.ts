import { describe, expect, it } from 'vitest';
import { costUsd, Meter, nextReset, retryAfterMs } from '../src/meter.js';
import { DEFAULT_POLICY_YAML, effective, parsePolicy } from '../src/policy.js';

const T0 = Date.parse('2026-11-08T12:00:00Z');
const groq: any = { id: 'groq', paid: false, limits: { rpm: 3, rpd: 5, tpd: 100 } };
const anthropic: any = { id: 'anthropic', paid: true, limits: {}, price_per_mtok: { mid: { input: 3, output: 15 } } };

describe('quota meter', () => {
  it('counts requests per minute in a sliding window', () => {
    const m = new Meter();
    for (let i = 0; i < 3; i++) m.request('groq', T0 + i * 1000);
    expect(m.blocked(groq, T0 + 3000)).toBe('rpm limit 3 reached');
    expect(m.blocked(groq, T0 + 60_500)).toBeNull(); // first request left the window
  });

  it('counts requests and tokens per day and resets at UTC midnight', () => {
    const m = new Meter();
    for (let i = 0; i < 5; i++) m.request('groq', T0 + i * 61_000);
    expect(m.blocked(groq, T0 + 400_000)).toBe('daily request limit 5 reached');
    const tomorrow = nextReset(T0) + 1;
    expect(new Date(nextReset(T0)).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    expect(m.blocked(groq, tomorrow)).toBeNull();
    expect(m.get('groq', tomorrow).reqDay).toBe(0);
    m.tokens('groq', 100, 0, tomorrow);
    expect(m.blocked(groq, tomorrow)).toBe('daily token limit 100 reached');
  });

  it('a live 429 cools the provider down, honouring retry-after', () => {
    const m = new Meter();
    m.rateLimited('groq', T0, retryAfterMs('30', T0) ?? 60_000);
    expect(m.blocked(groq, T0 + 29_000)).toMatch(/cooling down after 429 \(1s left\)/);
    expect(m.blocked(groq, T0 + 30_000)).toBeNull();
    expect(retryAfterMs(new Date(T0 + 5000).toUTCString(), T0)).toBe(5000);
    expect(retryAfterMs(null, T0)).toBeNull();
  });

  it('enforces the paid daily cap with token pricing', () => {
    const m = new Meter();
    const usd = costUsd(anthropic, 'mid', 1_000_000, 100_000); // $3 + $1.5
    expect(usd).toBeCloseTo(4.5);
    m.tokens('anthropic', 1_100_000, usd, T0);
    expect(m.blocked(anthropic, T0, 10)).toBeNull();
    m.tokens('anthropic', 0, 6, T0);
    expect(m.blocked(anthropic, T0, 10)).toMatch(/daily cap \$10 reached \(\$10.50 spent\)/);
    expect(m.blocked(anthropic, T0, 0)).toMatch(/never use/);
    expect(costUsd(groq, 'mid', 1e6, 1e6)).toBe(0);
  });

  it('survives a snapshot round trip', () => {
    const m = new Meter();
    m.request('groq', T0);
    m.rateLimited('groq', T0, 60_000);
    const m2 = new Meter(JSON.parse(JSON.stringify(m.snapshot())));
    expect(m2.get('groq', T0 + 1000).reqDay).toBe(1);
    expect(m2.blocked(groq, T0 + 1000)).toMatch(/cooling down/);
  });
});

describe('policy', () => {
  it('parses the default policy file from the spec', () => {
    const p = parsePolicy(DEFAULT_POLICY_YAML);
    expect(p.order).toEqual(['anthropic', 'groq', 'nvidia', 'openrouter', 'cerebras']);
    expect(p.caps.anthropic.daily_cap_usd).toBe(10);
    expect(p.caps.openai.daily_cap_usd).toBe(0);
    expect(p.failover).toEqual({ on: ['429', '5xx', 'timeout', 'connection'], retry_same_provider: 1, cooldown_seconds: 60, timeout_seconds: 60 });
    expect(p.degraded_banner).toBe(true);
  });

  it('per-agent order and cap override the global policy; a global cap of 0 always wins', () => {
    const p = parsePolicy(DEFAULT_POLICY_YAML);
    p.agents = { 'claude-code': { order: ['anthropic', 'groq'], daily_cap_usd: 3 }, codex: { order: ['openai', 'nvidia'], daily_cap_usd: 5 }, reviewer: { order: ['groq'] } };
    expect(effective(p, 'claude-code').order).toEqual(['anthropic', 'groq']);
    expect(effective(p, 'claude-code').capFor('anthropic')).toBe(3);
    expect(effective(p, 'codex').capFor('openai')).toBe(0);
    expect(effective(p, 'reviewer').capFor('anthropic')).toBe(10);
    expect(effective(p, null).order[0]).toBe('anthropic');
    expect(effective(p, 'unknown-agent').order).toEqual(p.order);
  });

  it('rejects bad policy files', () => {
    expect(() => parsePolicy('order: []\n')).toThrow(/at least one provider/);
    expect(() => parsePolicy('order: [groq]\nfailover:\n  on: [418]\n')).toThrow(/unknown "418"/);
  });
});
