import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Paths, PocketError, readText } from './config.js';

export type Format = 'openai' | 'anthropic';
export type Tier = 'strong' | 'mid' | 'fast';

export interface Limits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
  tpmonth?: number;
}

export interface Provider {
  id: string;
  base_url: string;
  format: Format;
  paid: boolean;
  limits: Limits;
  verified_on: string | null;
  source?: string;
  notice?: string; // shown on `keys add` and in the dashboard (e.g. data-use terms)
  passthrough?: string; // model-name prefix sent unchanged, e.g. "claude-"
  tiers: Record<Tier, string>;
  price_per_mtok?: Partial<Record<Tier, { input: number; output: number }>>;
}

export function shippedProvidersFile(): string {
  // dist/providers.js -> ../providers.json ; src/providers.ts -> ../providers.json
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', 'providers.json');
}

/** Shipped providers.json, overlaid by the user's copy in the config dir (per provider, shallow). */
export function loadProviders(p: Paths): Record<string, Provider> {
  const base = JSON.parse(fs.readFileSync(shippedProvidersFile(), 'utf8')).providers as Record<string, Omit<Provider, 'id'>>;
  const userText = readText(p.providers);
  let user: Record<string, Partial<Provider>> = {};
  if (userText) {
    try {
      user = JSON.parse(userText).providers ?? {};
    } catch {
      throw new PocketError(`${p.providers} is not valid JSON`);
    }
  }
  const out: Record<string, Provider> = {};
  for (const id of new Set([...Object.keys(base), ...Object.keys(user)])) {
    const merged = { ...(base[id] ?? {}), ...(user[id] ?? {}) } as Omit<Provider, 'id'>;
    if (!merged.base_url || !merged.format || !merged.tiers) throw new PocketError(`provider ${id}: base_url, format and tiers are required`);
    out[id] = { id, ...merged, limits: merged.limits ?? {}, paid: !!merged.paid, verified_on: merged.verified_on ?? null };
  }
  return out;
}

/** claude-opus-* / gpt-5* / o3 → strong; sonnet / gpt-*-mini? → mid; haiku / *-mini / *-nano → fast. Unknown → mid. */
export function tierOf(model: string): Tier {
  const m = model.toLowerCase();
  if (/haiku|-mini\b|-nano\b|mini$|nano$|-fast|flash/.test(m)) return 'fast';
  if (/opus|^o[13]\b|^o[13]-|gpt-5(?!-mini|-nano)|gpt-4\.1(?!-mini|-nano)|codex/.test(m)) return 'strong';
  return 'mid';
}

export function modelFor(provider: Provider, requested: string): { model: string; tier: Tier } {
  const tier = tierOf(requested);
  if (provider.passthrough && requested.startsWith(provider.passthrough)) return { model: requested, tier };
  return { model: provider.tiers[tier] ?? provider.tiers.mid, tier };
}
