import type { ServerResponse } from 'node:http';
import { costUsd, retryAfterMs } from './meter.js';
import { effective, Policy } from './policy.js';
import { modelFor, Provider, Tier } from './providers.js';
import { SseParser, sse } from './sse.js';
import { State } from './state.js';
import {
  AEvent,
  AnthropicToOpenAIStream,
  anthropicToOpenAIRequest,
  anthropicToOpenAIResponse,
  bannerEvents,
  hasImages,
  isContentEvent,
  OpenAIToAnthropicStream,
  openAIToAnthropicRequest,
  openAIToAnthropicResponse,
  shiftIndex,
  TranslateError,
  usageFromEvents,
} from './translate.js';

export type ClientFormat = 'anthropic' | 'openai';

export interface RouterDeps {
  providers: () => Record<string, Provider>;
  policy: () => Policy;
  key: (provider: string) => string | null;
  state: State;
  now: () => number;
  log: (line: string) => void;
}

export interface Inbound {
  format: ClientFormat;
  body: any;
  agent: string | null;
  headers: Record<string, string | string[] | undefined>;
}

type Failure = { kind: '429' | '5xx' | '4xx' | 'timeout' | 'connection'; status?: number; detail: string; retryAfter?: number | null; at: number };

class AttemptFailed extends Error {
  constructor(public f: Failure) {
    super(f.detail);
  }
}

function errorBody(format: ClientFormat, status: number, message: string, type = 'api_error') {
  if (format === 'anthropic') return { type: 'error', error: { type: status === 429 ? 'rate_limit_error' : status === 529 || status === 503 ? 'overloaded_error' : status >= 500 ? 'api_error' : 'invalid_request_error', message } };
  return { error: { message, type, code: status } };
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers });
  res.end(s);
}

function reasonPhrase(f: Failure | string): string {
  if (typeof f === 'string') return f;
  if (f.kind === '429') return 'quota exhausted (429)';
  if (f.kind === 'timeout') return 'timed out';
  if (f.kind === 'connection') return 'unreachable';
  return `unavailable (${f.status})`;
}

const FORWARD_ANTHROPIC_HEADERS = ['anthropic-version', 'anthropic-beta'];

/** One upstream attempt. Resolves once the response is committed to the client. */
async function attempt(
  deps: RouterDeps,
  p: Provider,
  key: string | null,
  areq: any,
  model: string,
  tier: Tier,
  inb: Inbound,
  res: ServerResponse,
  banner: string | null,
  onFirstToken: (at: number) => void,
): Promise<{ input: number; output: number }> {
  const pol = deps.policy();
  const stream = !!areq.stream;
  let url: string;
  let body: any;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (p.format === 'anthropic') {
    url = p.base_url.replace(/\/$/, '') + '/v1/messages';
    body = { ...areq, model };
    if (key) headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    if (inb.format === 'anthropic') {
      for (const h of FORWARD_ANTHROPIC_HEADERS) {
        const v = inb.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
    }
  } else {
    url = p.base_url.replace(/\/$/, '') + '/chat/completions';
    body = anthropicToOpenAIRequest(areq, model);
    if (key) headers.authorization = `Bearer ${key}`;
  }

  const ac = new AbortController();
  const timeoutMs = pol.failover.timeout_seconds * 1000;
  let timer: NodeJS.Timeout | null = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  deps.state.meter.request(p.id, deps.now());

  let up: Response;
  try {
    up = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
  } catch (e: any) {
    clearTimer();
    const timedOut = ac.signal.aborted;
    throw new AttemptFailed({ kind: timedOut ? 'timeout' : 'connection', detail: timedOut ? `no response in ${pol.failover.timeout_seconds}s` : String(e?.cause?.code ?? e?.message ?? e), at: deps.now() });
  }

  if (!up.ok) {
    clearTimer();
    const text = await up.text().catch(() => '');
    const at = deps.now();
    const kind = up.status === 429 ? '429' : up.status >= 500 ? '5xx' : '4xx';
    throw new AttemptFailed({ kind, status: up.status, detail: `${up.status} ${text.slice(0, 200)}`, retryAfter: retryAfterMs(up.headers.get('retry-after'), at), at });
  }

  const outHeaders = { 'x-pocket-provider': p.id, 'x-pocket-model': model };

  if (!stream) {
    let json: any;
    try {
      json = await up.json();
    } catch (e: any) {
      clearTimer();
      throw new AttemptFailed({ kind: 'connection', detail: `bad JSON from upstream: ${e.message}`, at: deps.now() });
    }
    clearTimer();
    onFirstToken(deps.now());
    let amsg = p.format === 'anthropic' ? json : openAIToAnthropicResponse(json, model);
    if (banner) {
      const c = amsg.content ?? [];
      amsg = { ...amsg, content: c[0]?.type === 'text' ? [{ ...c[0], text: banner + c[0].text }, ...c.slice(1)] : [{ type: 'text', text: banner }, ...c] };
    }
    const out = inb.format === 'anthropic' ? amsg : anthropicToOpenAIResponse(amsg, model);
    sendJson(res, 200, out, outHeaders);
    return { input: amsg.usage?.input_tokens ?? 0, output: amsg.usage?.output_tokens ?? 0 };
  }

  // ---- streaming: buffer until the first token; failures before it may fail over
  const reader = up.body!.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const conv = p.format === 'openai' ? new OpenAIToAnthropicStream(model) : null;
  const toClient = inb.format === 'openai' ? new AnthropicToOpenAIStream(model) : null;
  const pending: AEvent[] = [];
  const all: AEvent[] = [];
  let committed = false;
  let shift = 0;
  let complete = false; // saw message_stop (anthropic) or [DONE] (openai): the stream was not cut off

  const write = (e: AEvent) => {
    if (inb.format === 'anthropic') res.write(sse(e.type, e));
    else for (const c of toClient!.push(e)) res.write(c === '[DONE]' ? 'data: [DONE]\n\n' : sse(undefined, c));
  };
  const emit = (e: AEvent) => {
    all.push(e);
    if (!committed) {
      pending.push(e);
      if (!isContentEvent(e)) return;
      // first token: commit to this provider
      committed = true;
      clearTimer();
      onFirstToken(deps.now());
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...outHeaders });
      if (banner) {
        const firstText = pending.findIndex((x) => x.type === 'content_block_delta' && x.delta?.type === 'text_delta');
        if (firstText >= 0 && pending.indexOf(e) === firstText) {
          // the reply opens with text: prefix the banner to it, so every client shows it
          const x = pending[firstText];
          pending[firstText] = { ...x, delta: { ...x.delta, text: banner + x.delta.text } };
        } else if (inb.format === 'anthropic') {
          // the reply opens with a tool call: give the banner its own text block in front
          const at = pending[0]?.type === 'message_start' ? 1 : 0;
          pending.splice(at, 0, ...bannerEvents(banner));
          shift = 1;
          for (let i = at + 3; i < pending.length; i++) pending[i] = shiftIndex(pending[i], 1);
        } else {
          const at = pending[0]?.type === 'message_start' ? 1 : 0;
          pending.splice(at, 0, { type: 'content_block_delta', index: -1, delta: { type: 'text_delta', text: banner } });
        }
      }
      for (const x of pending) write(x);
      pending.length = 0;
      return;
    }
    write(shiftIndex(e, shift));
  };
  const handle = (ev: { event?: string; data: string }) => {
    if (conv) {
      if (ev.data.trim() === '[DONE]') {
        complete = true;
        return conv.push('[DONE]').forEach(emit);
      }
      let chunk: any;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (chunk.error) throw new Error(`upstream stream error: ${JSON.stringify(chunk.error).slice(0, 200)}`);
      conv.push(chunk).forEach(emit);
    } else {
      let e: any;
      try {
        e = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (e.type === 'error') throw new Error(`upstream stream error: ${JSON.stringify(e.error).slice(0, 200)}`);
      if (e.type === 'ping') return;
      if (e.type === 'message_stop') complete = true;
      emit(e);
    }
  };

  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e: any) {
        if (!committed) throw new AttemptFailed({ kind: ac.signal.aborted ? 'timeout' : 'connection', detail: `stream broke before first token: ${e?.message ?? e}`, at: deps.now() });
        throw e;
      }
      if (r.done) break;
      for (const ev of parser.push(decoder.decode(r.value, { stream: true }))) handle(ev);
    }
    for (const ev of parser.end()) handle(ev);
    if (!complete) {
      if (!committed) throw new AttemptFailed({ kind: 'connection', detail: 'stream ended before the first token', at: deps.now() });
      throw new Error('stream was cut off');
    }
    if (conv) conv.end().forEach(emit);
  } catch (e: any) {
    if (e instanceof AttemptFailed) throw e;
    if (!committed) throw new AttemptFailed({ kind: 'connection', detail: e.message, at: deps.now() });
    // after the first token we finish on the same provider: close the stream with an error event
    deps.log(`stream error after first token on ${p.id}: ${e.message}`);
    if (inb.format === 'anthropic') res.write(sse('error', { type: 'error', error: { type: 'api_error', message: `[pocket] ${p.id} stream failed: ${e.message}` } }));
    else res.write('data: [DONE]\n\n');
    res.end();
    return usageFromEvents(all);
  } finally {
    clearTimer();
  }
  if (!committed) {
    // stream ended without any content (e.g. empty reply): commit what we have
    committed = true;
    onFirstToken(deps.now());
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...outHeaders });
    for (const x of pending) write(x);
  }
  res.end();
  return usageFromEvents(all);
}

export async function route(deps: RouterDeps, inb: Inbound, res: ServerResponse): Promise<void> {
  const fmt = inb.format;
  let areq: any;
  try {
    areq = fmt === 'anthropic' ? inb.body : openAIToAnthropicRequest(inb.body);
  } catch (e: any) {
    const status = e instanceof TranslateError ? e.status : 400;
    return sendJson(res, status, errorBody(fmt, status, e.message, 'invalid_request_error'));
  }
  const requested = String(inb.body?.model ?? '');
  const providers = deps.providers();
  const pol = deps.policy();
  const eff = effective(pol, inb.agent);
  const agentName = inb.agent ?? 'default';
  const images = hasImages(areq);
  const skipped: { id: string; reason: string }[] = [];
  const failures: { id: string; f: Failure }[] = [];
  const primary = eff.order[0];

  for (const id of eff.order) {
    const p = providers[id];
    if (!p) {
      skipped.push({ id, reason: 'not in providers.json' });
      continue;
    }
    const key = deps.key(id);
    if (!key && (p as any).auth !== 'none') {
      skipped.push({ id, reason: 'no key' });
      continue;
    }
    const why = deps.state.meter.blocked(p, deps.now(), eff.capFor(id));
    if (why) {
      skipped.push({ id, reason: why });
      continue;
    }
    if (images && !(p as any).images) {
      skipped.push({ id, reason: 'no image support' });
      continue;
    }
    const { model, tier } = modelFor(p, requested);
    const degraded = id !== primary;
    const firstReason = failures[0] ? `${failures[0].id} ${reasonPhrase(failures[0].f)}` : skipped[0] ? `${skipped[0].id} ${skipped[0].reason}` : null;
    const bannerKey = `${agentName}|${id}`;
    const banner = degraded && pol.degraded_banner && !deps.state.bannerShown.has(bannerKey) ? `[pocket] running on ${id}/${model}${firstReason ? `, ${firstReason}` : ''}\n\n` : null;
    const tries = 1 + pol.failover.retry_same_provider;
    for (let t = 0; t < tries; t++) {
      try {
        let firstTokenAt = 0;
        const usage = await attempt(deps, p, key, areq, model, tier, inb, res, banner, (at) => (firstTokenAt = at));
        const now = deps.now();
        deps.state.meter.tokens(id, usage.input + usage.output, costUsd(p, tier, usage.input, usage.output), now);
        if (banner) deps.state.bannerShown.add(bannerKey);
        if (failures.length) {
          // a live failure happened in this request: log it with the 429-to-first-token latency
          const f0 = failures[0];
          deps.state.failover({ ts: new Date(now).toISOString(), agent: agentName, from: f0.id, to: id, reason: `${f0.id} ${reasonPhrase(f0.f)}`, latency_ms: firstTokenAt ? firstTokenAt - f0.f.at : null });
        }
        deps.state.served(agentName, { provider: id, model, at: new Date(now).toISOString(), degraded, reason: degraded ? firstReason : null });
        deps.log(`${agentName} ${requested} -> ${id}/${model}${degraded ? ` (degraded: ${firstReason})` : ''} in=${usage.input} out=${usage.output}`);
        return;
      } catch (e: any) {
        if (!(e instanceof AttemptFailed)) throw e;
        const f = e.f;
        deps.state.meter.error(id, f.detail, deps.now());
        deps.log(`${id} failed: ${f.kind} ${f.detail.slice(0, 120)}`);
        if (f.kind === '4xx') {
          // the request itself is bad for this provider (e.g. unsupported parameter). Try the next one,
          // but do not retry the same provider.
          failures.push({ id, f });
          break;
        }
        const enabled = pol.failover.on.includes(f.kind as any);
        if (!enabled) {
          return sendJson(res, f.status ?? 502, errorBody(fmt, f.status ?? 502, `[pocket] ${id}: ${f.detail}`));
        }
        if (f.kind === '429') {
          deps.state.meter.rateLimited(id, deps.now(), f.retryAfter ?? pol.failover.cooldown_seconds * 1000);
          failures.push({ id, f });
          break; // never hammer a provider that said 429
        }
        if (t === tries - 1) failures.push({ id, f });
      }
    }
  }

  const reasons = [...failures.map((x) => `${x.id}: ${reasonPhrase(x.f)}`), ...skipped.map((s) => `${s.id}: ${s.reason}`)];
  deps.state.failover({ ts: new Date(deps.now()).toISOString(), agent: agentName, from: primary ?? '?', to: null, reason: reasons.join('; ') || 'no providers configured', latency_ms: null });
  const status = images && skipped.some((s) => s.reason === 'no image support') && !failures.length ? 422 : 503;
  const msg =
    status === 422
      ? `[pocket] this request contains images and no provider with headroom supports them (${reasons.join('; ')})`
      : `[pocket] no provider could serve this request: ${reasons.join('; ') || 'none configured; run `pocket keys add <provider>`'}`;
  return sendJson(res, status, errorBody(fmt, status, msg));
}
