import { Limits, Provider } from './providers.js';

const MIN = 60_000;

export interface ProviderUsage {
  window: number[]; // request timestamps within the last minute
  day: string; // UTC day the daily counters belong to
  reqDay: number;
  tokDay: number;
  month: string;
  tokMonth: number;
  spendDay: number; // USD, paid providers only
  cooldownUntil: number; // epoch ms; 0 = none
  last429: number;
  lastError: string | null;
  strikes: number; // 429s in a row without a success in between (cooldown ladder)
  live: LiveQuota | null; // what the provider's rate-limit headers said last time
}

/** Quota as the provider reports it in x-ratelimit-* headers. Any field can be missing. */
export interface LiveQuota {
  at: number;
  req_remaining?: number;
  req_limit?: number;
  req_reset_ms?: number;
  tok_remaining?: number;
  tok_limit?: number;
  tok_reset_ms?: number;
}

export type MeterSnapshot = Record<string, ProviderUsage>;

function fresh(now: number): ProviderUsage {
  const d = new Date(now).toISOString();
  return { window: [], day: d.slice(0, 10), reqDay: 0, tokDay: 0, month: d.slice(0, 7), tokMonth: 0, spendDay: 0, cooldownUntil: 0, last429: 0, lastError: null, strikes: 0, live: null };
}

/** Next UTC midnight after `now` (daily counters reset there). */
export function nextReset(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export class Meter {
  usage = new Map<string, ProviderUsage>();

  constructor(snapshot: MeterSnapshot = {}) {
    for (const [k, v] of Object.entries(snapshot)) this.usage.set(k, { ...fresh(0), ...v, window: [...(v.window ?? [])] });
  }

  get(id: string, now: number): ProviderUsage {
    let u = this.usage.get(id);
    if (!u) {
      u = fresh(now);
      this.usage.set(id, u);
    }
    const iso = new Date(now).toISOString();
    if (u.day !== iso.slice(0, 10)) {
      u.day = iso.slice(0, 10);
      u.reqDay = 0;
      u.tokDay = 0;
      u.spendDay = 0;
    }
    if (u.month !== iso.slice(0, 7)) {
      u.month = iso.slice(0, 7);
      u.tokMonth = 0;
    }
    u.window = u.window.filter((t) => now - t < MIN);
    return u;
  }

  /** Why a provider cannot take a request right now, or null if it has headroom. */
  blocked(p: Provider, now: number, cap?: number): string | null {
    const u = this.get(p.id, now);
    if (u.cooldownUntil > now) return `cooling down after 429 (${Math.ceil((u.cooldownUntil - now) / 1000)}s left)`;
    const l: Limits = p.limits ?? {};
    if (l.rpm !== undefined && u.window.length >= l.rpm) return `rpm limit ${l.rpm} reached`;
    if (l.rpd !== undefined && u.reqDay >= l.rpd) return `daily request limit ${l.rpd} reached`;
    if (l.tpd !== undefined && u.tokDay >= l.tpd) return `daily token limit ${l.tpd} reached`;
    if (l.tpmonth !== undefined && u.tokMonth >= l.tpmonth) return 'monthly token limit reached';
    if (p.paid) {
      if (cap === 0) return 'daily_cap_usd is 0 (never use)';
      if (cap !== undefined && u.spendDay >= cap) return `daily cap $${cap} reached ($${u.spendDay.toFixed(2)} spent)`;
    }
    return null;
  }

  request(id: string, now: number) {
    const u = this.get(id, now);
    u.window.push(now);
    u.reqDay++;
  }

  tokens(id: string, n: number, usd: number, now: number) {
    const u = this.get(id, now);
    u.tokDay += n;
    u.tokMonth += n;
    u.spendDay += usd;
    u.strikes = 0;
  }

  /** Record the provider's own quota headers. Remaining 0 means it would 429 now: wait for its reset. */
  observe(id: string, q: Omit<LiveQuota, 'at'>, now: number) {
    if (!Object.keys(q).length) return;
    const u = this.get(id, now);
    u.live = { ...q, at: now };
    const waits: number[] = [];
    if (q.req_remaining === 0 && q.req_reset_ms) waits.push(q.req_reset_ms);
    if (q.tok_remaining === 0 && q.tok_reset_ms) waits.push(q.tok_reset_ms);
    if (waits.length) u.cooldownUntil = Math.max(u.cooldownUntil, now + Math.min(Math.max(...waits), 24 * 3600_000));
  }

  /** A live 429 beats the seed limits: cool down for retry-after or the policy default. */
  rateLimited(id: string, now: number, cooldownMs: number, told = false) {
    const u = this.get(id, now);
    u.strikes++;
    // when the provider did not say how long, back off harder on each 429 in a row (cap 1h)
    const ms = told ? cooldownMs : Math.min(cooldownMs * 2 ** Math.min(u.strikes - 1, 10), 3600_000);
    u.cooldownUntil = now + ms;
    u.last429 = now;
  }

  error(id: string, msg: string, now: number) {
    this.get(id, now).lastError = msg;
  }

  snapshot(): MeterSnapshot {
    return Object.fromEntries(this.usage);
  }
}

export function costUsd(p: Provider, tier: string, inTok: number, outTok: number): number {
  const prices = p.price_per_mtok as Record<string, { input: number; output: number }> | undefined;
  const price = prices?.[tier] ?? prices?.mid;
  if (!p.paid || !price) return 0;
  return (inTok * price.input + outTok * price.output) / 1_000_000;
}

/** retry-after: seconds or an HTTP date. */
export function retryAfterMs(h: string | null, now: number): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

/** "1m30s", "7.66s", "2h", "250ms", "30" (seconds), or an epoch in s/ms. Pure. */
export function durationMs(v: string | null | undefined, now: number): number | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n > 1e12) return Math.max(0, n - now); // epoch ms (OpenRouter)
    if (n > 1e9) return Math.max(0, n * 1000 - now); // epoch s
    return n * 1000;
  }
  let ms = 0;
  let matched = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    ms += m[2] === 'h' ? n * 3600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  if (matched) return ms;
  const d = Date.parse(t);
  return Number.isNaN(d) ? null : Math.max(0, d - now);
}

/** The provider's x-ratelimit-* headers (OpenAI/Groq, Cerebras -day/-minute, OpenRouter bare). Pure. */
export function quotaFromHeaders(get: (name: string) => string | null, now: number): Omit<LiveQuota, 'at'> {
  const q: Omit<LiveQuota, 'at'> = {};
  const num = (n: string) => {
    const v = get(n);
    if (v == null || v === '') return undefined;
    const x = Number(v);
    return Number.isFinite(x) ? x : undefined;
  };
  // the tightest window wins: per-day before per-minute before unlabelled
  for (const sfx of ['-day', '-minute', '']) {
    q.req_remaining ??= num(`x-ratelimit-remaining-requests${sfx}`);
    q.req_limit ??= num(`x-ratelimit-limit-requests${sfx}`);
    q.req_reset_ms ??= durationMs(get(`x-ratelimit-reset-requests${sfx}`), now) ?? undefined;
    q.tok_remaining ??= num(`x-ratelimit-remaining-tokens${sfx}`);
    q.tok_limit ??= num(`x-ratelimit-limit-tokens${sfx}`);
    q.tok_reset_ms ??= durationMs(get(`x-ratelimit-reset-tokens${sfx}`), now) ?? undefined;
  }
  q.req_remaining ??= num('x-ratelimit-remaining');
  q.req_limit ??= num('x-ratelimit-limit');
  q.req_reset_ms ??= durationMs(get('x-ratelimit-reset'), now) ?? undefined;
  for (const k of Object.keys(q) as (keyof typeof q)[]) if (q[k] === undefined) delete q[k];
  return q;
}

/** How long a 429 means to wait, from the window the headers say is used up. Null if they don't say. */
export function resetFrom(q: Omit<LiveQuota, 'at'>): number | null {
  const waits: number[] = [];
  if (q.req_remaining === 0 && q.req_reset_ms != null) waits.push(q.req_reset_ms);
  if (q.tok_remaining === 0 && q.tok_reset_ms != null) waits.push(q.tok_reset_ms);
  return waits.length ? Math.min(Math.max(...waits), 24 * 3600_000) : null;
}
