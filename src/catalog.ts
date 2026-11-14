// Live model catalog. pocket asks each provider which models the user's key can use (GET /models),
// keeps that list fresh, and picks models from it. providers.json tiers are only preferences:
// a preferred id is used when the live list still has it, otherwise pocket ranks what is there.
// Models that stop working (retired, no longer free) are dropped on the spot, and limits the
// provider reports in an error (max_tokens) are remembered per model.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Paths, writePrivate } from './config.js';
import { Provider, Tier } from './providers.js';

export interface ModelInfo {
  id: string;
  context?: number;
  maxOutput?: number;
  tools?: boolean; // only when the provider says so
  free?: boolean; // only when the provider says so (OpenRouter pricing)
}

interface ProviderEntry {
  fetched_at: number;
  models: ModelInfo[];
}

interface Saved {
  providers: Record<string, ProviderEntry>;
  caps: Record<string, number>; // "provider|model" -> max_tokens the provider accepts
  bad: Record<string, number>; // "provider|model" -> until (ms epoch)
}

const FRESH_MS = 12 * 3600_000;
const BAD_MS = 24 * 3600_000;
const FETCH_TIMEOUT_MS = 8000;

// Not chat models. Patterns over names, so new releases in these families are excluded too.
const NOT_CHAT = /embed|rerank|guard|safety|reward|moderation|whisper|tts|speech|audio|transcri|parse|ocr|clip|detector|calibration|retriever|translate|vision-only|image-gen|diffusion|video|playai|orpheus|deplot|kosmos|fuyu|neva|vila|cosmos|compound|-base$|instruct-v0\.1$/i;
// Old generations that newer open models clearly beat for coding agents.
const OLD = /llama-?2|llama-?3(\.[0-2])?[-_]|llama3-|codellama|mixtral|mistral-7b|yi-|dbrx|jamba|starcoder|codegemma|gemma-?[123]\b|gemma-[123][-.]|phi-?3|granite-3\.0|zamba|sea-lion|chatqa|minitron|nemotron-4|palmyra/i;
// Families that do well as coding agents with tools: a ranking nudge, not a whitelist.
const STRONG_FAMILY = /kimi|deepseek|qwen.*coder|qwen3|glm|gpt-oss|minimax|devstral|codestral|mistral-large|nemotron.*(ultra|super)|step-|ling-|ernie/i;
const FAST_HINT = /flash|lightning|mini|nano|small|fast|instant|20b|8b|bolt/i;

/** Parameter count in billions from a model id ("gpt-oss-120b", "nemotron-3-ultra-550b-a55b" -> 550). */
export function paramsB(id: string): number {
  let best = 0;
  for (const m of id.toLowerCase().matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)([bt])(?![a-z])/g)) {
    const n = parseFloat(m[1]) * (m[2] === 't' ? 1000 : 1);
    if (n > best) best = n;
  }
  return best;
}

export function usable(p: Provider, m: ModelInfo): boolean {
  if (NOT_CHAT.test(m.id)) return false;
  if (m.tools === false) return false; // coding agents need tool calls
  if (p.id === 'openrouter') return m.id === 'openrouter/free' || m.id.endsWith(':free') || m.free === true;
  return true;
}

function score(m: ModelInfo, tier: Tier): number {
  const b = paramsB(m.id);
  let s = 0;
  if (STRONG_FAMILY.test(m.id)) s += 40;
  if (OLD.test(m.id)) s -= 60;
  if ((m.context ?? 0) >= 64000) s += 5;
  if (m.tools === true) s += 5;
  if (m.id === 'openrouter/free') s += 30; // OpenRouter's own router always lands on a live free model
  if (tier === 'fast') {
    if (FAST_HINT.test(m.id)) s += 20;
    if (b) s += b <= 40 ? 15 : b <= 130 ? 0 : -15;
  } else {
    // flagship models rarely put their size in the id; an unknown size is treated as large
    s += b ? Math.min(Math.log2(b + 1) * 6, 60) : 45;
    if (b && b < 50) s -= 20; // small models make weak agents
    if (FAST_HINT.test(m.id)) s -= 10; // "flash", "mini": built for speed, not for the hard turns
    if (tier === 'mid' && b > 300) s -= 10; // mid prefers something lighter than the biggest model
  }
  return s;
}

/** Ranked models for a tier from a live list (best first). Pure. */
export function rank(p: Provider, models: ModelInfo[], tier: Tier): string[] {
  return models
    .filter((m) => usable(p, m))
    .map((m) => ({ id: m.id, s: score(m, tier) }))
    .sort((a, b) => b.s - a.s || a.id.localeCompare(b.id))
    .map((x) => x.id);
}

/** Normalize a provider's /models response (OpenAI-style, OpenRouter, Groq, Anthropic) into ModelInfo. Pure. */
export function parseModels(json: any): ModelInfo[] {
  const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
  const out: ModelInfo[] = [];
  for (const m of list) {
    const id = typeof m?.id === 'string' ? m.id : typeof m?.name === 'string' ? m.name : null;
    if (!id) continue;
    if (m.active === false) continue; // Groq marks retired models inactive
    const info: ModelInfo = { id };
    const ctx = m.context_length ?? m.context_window ?? m.max_context_length ?? m.top_provider?.context_length;
    if (typeof ctx === 'number') info.context = ctx;
    const mo = m.max_completion_tokens ?? m.top_provider?.max_completion_tokens ?? m.max_output_tokens;
    if (typeof mo === 'number' && mo > 0) info.maxOutput = mo;
    if (Array.isArray(m.supported_parameters)) info.tools = m.supported_parameters.includes('tools');
    if (m.pricing && typeof m.pricing === 'object') {
      const prompt = Number(m.pricing.prompt);
      const completion = Number(m.pricing.completion);
      if (Number.isFinite(prompt) && Number.isFinite(completion)) info.free = prompt === 0 && completion === 0;
    }
    out.push(info);
  }
  return out;
}

/** "this model is gone for you" (retired, renamed, no longer free) as opposed to a bad request. Pure. */
export function isModelGone(status: number | undefined, detail: string): boolean {
  if (status === 410) return true;
  if (status !== 404 && status !== 400 && status !== 403 && status !== 422) return false;
  return /model/i.test(detail) && /not (be )?found|does not exist|doesn't exist|decommission|deprecat|retired|reached its end|no longer|unavailable|not available|not supported|unknown model|invalid model/i.test(detail);
}

/** The max_tokens limit a provider states in its error, if it states one. Pure. */
export function capFromError(detail: string): number | null {
  if (!/max_tokens|max_completion_tokens|max_output|output tokens|completion tokens/i.test(detail)) return null;
  const m = detail.match(/(?:less than or equal to|<=|at most|maximum(?: value)?(?: for [`'"]?\w+[`'"]?)? is|must be ≤|up to)\s*[`'"]?(\d{3,7})/i);
  return m ? parseInt(m[1], 10) : null;
}

export class Catalog {
  private saved: Saved;
  private inflight = new Map<string, Promise<void>>();

  constructor(
    private file: string | null,
    private now: () => number,
    private log: (line: string) => void,
    private fetchFn: typeof fetch = fetch,
  ) {
    this.saved = { providers: {}, caps: {}, bad: {} };
    if (file) {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.saved = { providers: s.providers ?? {}, caps: s.caps ?? {}, bad: s.bad ?? {} };
      } catch {
        /* first run */
      }
    }
  }

  static forPaths(p: Paths, now: () => number, log: (line: string) => void) {
    return new Catalog(path.join(p.dir, 'models.json'), now, log);
  }

  private save() {
    if (!this.file) return;
    try {
      writePrivate(this.file, JSON.stringify(this.saved, null, 2) + '\n');
    } catch {
      /* best effort */
    }
  }

  models(providerId: string): ModelInfo[] | null {
    return this.saved.providers[providerId]?.models ?? null;
  }

  fetchedAt(providerId: string): number | null {
    return this.saved.providers[providerId]?.fetched_at ?? null;
  }

  /** Fetch the provider's model list with the user's key. Never throws; keeps the old list on failure. */
  refresh(p: Provider, key: string | null): Promise<void> {
    const running = this.inflight.get(p.id);
    if (running) return running;
    const job = (async () => {
      const headers: Record<string, string> = {};
      let url = p.base_url.replace(/\/$/, '');
      if (p.format === 'anthropic') {
        url += '/v1/models?limit=1000';
        if (key) headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        url += '/models';
        if (key) headers.authorization = `Bearer ${key}`;
      }
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      try {
        const r = await this.fetchFn(url, { headers, signal: ac.signal });
        if (!r.ok) throw new Error(`${r.status}`);
        const models = parseModels(await r.json());
        if (!models.length) throw new Error('empty list');
        this.saved.providers[p.id] = { fetched_at: this.now(), models };
        this.save();
        this.log(`models: ${p.id} lists ${models.length} (${models.filter((m) => usable(p, m)).length} usable)`);
      } catch (e: any) {
        this.log(`models: ${p.id} list unavailable (${e?.message ?? e}); using ${this.models(p.id) ? 'the cached list' : 'providers.json'}`);
      } finally {
        clearTimeout(t);
        this.inflight.delete(p.id);
      }
    })();
    this.inflight.set(p.id, job);
    return job;
  }

  /** Refresh in the background when the list is missing or stale. */
  touch(p: Provider, key: string | null) {
    const at = this.fetchedAt(p.id);
    if (at === null || this.now() - at > FRESH_MS) void this.refresh(p, key);
  }

  isBad(providerId: string, model: string): boolean {
    const until = this.saved.bad[`${providerId}|${model}`];
    if (!until) return false;
    if (until > this.now()) return true;
    delete this.saved.bad[`${providerId}|${model}`];
    return false;
  }

  markBad(p: Provider, model: string, key: string | null, why: string) {
    this.saved.bad[`${p.id}|${model}`] = this.now() + BAD_MS;
    // drop it from the cached list too, so ranking moves on even before the refresh lands
    const e = this.saved.providers[p.id];
    if (e) e.models = e.models.filter((m) => m.id !== model);
    this.save();
    this.log(`models: ${p.id}/${model} dropped for 24h (${why.slice(0, 120)})`);
    void this.refresh(p, key);
  }

  cap(providerId: string, model: string): number | null {
    const learned = this.saved.caps[`${providerId}|${model}`];
    if (learned) return learned;
    const info = this.models(providerId)?.find((m) => m.id === model);
    return info?.maxOutput ?? null;
  }

  learnCap(providerId: string, model: string, n: number) {
    this.saved.caps[`${providerId}|${model}`] = n;
    this.save();
    this.log(`models: ${providerId}/${model} accepts max_tokens <= ${n}; remembered`);
  }

  /**
   * Models to try for a tier, best first. The providers.json preference comes first when the live
   * list still has it (or when there is no live list yet); then the live ranking.
   */
  candidates(p: Provider, tier: Tier, limit = 3): string[] {
    const live = this.models(p.id);
    const prefs = [p.tiers[tier], p.tiers.mid, p.tiers.strong, p.tiers.fast].filter((x, i, a): x is string => !!x && a.indexOf(x) === i);
    const out: string[] = [];
    const add = (id: string) => {
      if (!out.includes(id) && !this.isBad(p.id, id)) out.push(id);
    };
    if (!live) {
      prefs.forEach(add);
      return out.slice(0, limit);
    }
    const liveIds = new Set(live.map((m) => m.id));
    const pref = p.tiers[tier];
    if (pref && liveIds.has(pref) && usable(p, live.find((m) => m.id === pref)!)) add(pref);
    for (const id of rank(p, live, tier)) add(id);
    if (!out.length) prefs.forEach(add); // live list had nothing usable: fall back rather than fail
    return out.slice(0, limit);
  }
}
