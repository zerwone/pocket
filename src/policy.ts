import { Paths, PocketError, readJson, readText, writePrivate } from './config.js';
import { parse } from './yaml.js';

export type FailoverOn = '429' | '5xx' | 'timeout' | 'connection';

export interface AgentPolicy {
  order?: string[];
  daily_cap_usd?: number;
}

export interface Policy {
  order: string[];
  caps: Record<string, { daily_cap_usd?: number }>;
  failover: { on: FailoverOn[]; retry_same_provider: number; cooldown_seconds: number; timeout_seconds: number };
  degraded_banner: boolean;
  agents: Record<string, AgentPolicy>;
}

export const DEFAULT_POLICY_YAML = `# pocket routing policy. Providers are tried top to bottom until one has headroom.
order:
  - anthropic          # paid, until daily_cap_usd
  - groq
  - nvidia
  - openrouter
  - cerebras           # 5 rpm on the free trial: last-resort reserve
  # - mistral          # free plan requests may train Mistral's models; uncomment to accept
caps:
  anthropic: { daily_cap_usd: 10 }
  openai:    { daily_cap_usd: 0 }     # 0 = never use
failover:
  on: [429, 5xx, timeout, connection]
  retry_same_provider: 1
  cooldown_seconds: 60               # after a 429, skip that provider this long
  timeout_seconds: 60                # no response headers / first token within this = timeout
degraded_banner: true                # one line in the first assistant turn after a failover
`;

export function parsePolicy(text: string): Policy {
  let d: any;
  try {
    d = parse(text) ?? {};
  } catch (e: any) {
    throw new PocketError(`pocket.yml: ${e.message}`);
  }
  const f = d.failover ?? {};
  const on = (Array.isArray(f.on) ? f.on : ['429', '5xx', 'timeout', 'connection']).map((x: unknown) => String(x)) as FailoverOn[];
  for (const x of on) if (!['429', '5xx', 'timeout', 'connection'].includes(x)) throw new PocketError(`pocket.yml: failover.on: unknown "${x}"`);
  const order = Array.isArray(d.order) ? d.order.map(String) : [];
  if (!order.length) throw new PocketError('pocket.yml: `order` must list at least one provider');
  return {
    order,
    caps: d.caps ?? {},
    failover: {
      on,
      retry_same_provider: num(f.retry_same_provider, 1),
      cooldown_seconds: num(f.cooldown_seconds, 60),
      timeout_seconds: num(f.timeout_seconds, 60),
    },
    degraded_banner: d.degraded_banner !== false,
    agents: d.agents ?? {},
  };
}

function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt;
}

/** pocket.yml from the config dir (created with defaults if missing), plus agent overrides from `pocket staked sync`. */
export function loadPolicy(p: Paths): Policy {
  let text = readText(p.policy);
  if (text === null) {
    writePrivate(p.policy, DEFAULT_POLICY_YAML);
    text = DEFAULT_POLICY_YAML;
  }
  const pol = parsePolicy(text);
  const synced = readJson<{ agents?: Record<string, AgentPolicy> }>(p.agentPolicy, {}).agents ?? {};
  // hand-written pocket.yml agents win over synced ones
  pol.agents = { ...synced, ...pol.agents };
  return pol;
}

/** Effective order and caps for one agent (x-pocket-agent header), or the global policy. */
export function effective(pol: Policy, agent: string | null): { order: string[]; capFor: (provider: string) => number | undefined } {
  const a = agent ? pol.agents[agent] : undefined;
  const order = a?.order?.length ? a.order : pol.order;
  return {
    order,
    capFor: (provider) => {
      const global = pol.caps[provider]?.daily_cap_usd;
      // a global 0 ("never use") always wins; otherwise the agent's cap applies to its paid providers
      if (global === 0) return 0;
      if (a?.daily_cap_usd !== undefined) return a.daily_cap_usd;
      return global;
    },
  };
}

/** Pure: pocket.yml text with `id` added to (on) or removed from (off) the top-level order list.
 *  A text edit so the user's comments stay; refuses anything it can't do cleanly. */
export function orderEdit(text: string, id: string, on: boolean): string {
  if (!/^[a-z0-9_-]+$/i.test(id)) throw new PocketError(`bad provider id "${id}"`);
  const before = parsePolicy(text);
  if (on === before.order.includes(id)) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^order:\s*(#.*)?$/.test(l));
  if (start < 0) throw new PocketError('pocket.yml: `order` is not a plain list; edit it by hand');
  let end = start + 1;
  let lastItem = -1;
  while (end < lines.length && (/^\s+(-|#)/.test(lines[end]) || lines[end].trim() === '')) {
    if (/^\s+-\s/.test(lines[end])) lastItem = end;
    end++;
  }
  if (on) {
    // a commented-out "# - id" line: uncomment it in place
    const commented = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^(\\s+)#\\s*-\\s+${id}\\b`).test(l));
    if (commented >= 0) lines[commented] = lines[commented].replace(/^(\s+)#\s*-\s+/, '$1- ');
    else lines.splice(lastItem >= 0 ? lastItem + 1 : start + 1, 0, `  - ${id}`);
  } else {
    const i = lines.findIndex((l, j) => j > start && j < end && new RegExp(`^\\s+-\\s+${id}\\s*(#.*)?$`).test(l));
    if (i < 0) throw new PocketError(`pocket.yml: could not find "${id}" in the order list; edit it by hand`);
    lines.splice(i, 1);
  }
  const out = lines.join(eol);
  const after = parsePolicy(out);
  if (on !== after.order.includes(id)) throw new PocketError('pocket.yml: edit did not take; edit it by hand');
  return out;
}

export function setInOrder(p: Paths, id: string, on: boolean) {
  loadPolicy(p); // creates the default file if missing
  const text = readText(p.policy)!;
  const out = orderEdit(text, id, on);
  if (out !== text) writePrivate(p.policy, out);
}
