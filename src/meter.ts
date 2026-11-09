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
}

export type MeterSnapshot = Record<string, ProviderUsage>;

function fresh(now: number): ProviderUsage {
  const d = new Date(now).toISOString();
  return { window: [], day: d.slice(0, 10), reqDay: 0, tokDay: 0, month: d.slice(0, 7), tokMonth: 0, spendDay: 0, cooldownUntil: 0, last429: 0, lastError: null };
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
  }

  /** A live 429 beats the seed limits: cool down for retry-after or the policy default. */
  rateLimited(id: string, now: number, cooldownMs: number) {
    const u = this.get(id, now);
    u.cooldownUntil = now + cooldownMs;
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
