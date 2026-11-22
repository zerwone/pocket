import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PocketError } from './config.js';
import { nextReset } from './meter.js';
import { Policy } from './policy.js';
import { Provider } from './providers.js';
import { route, RouterDeps, sendJson } from './router.js';
import { State } from './state.js';
import { sameOrigin, setupApi, SetupDeps } from './setupapi.js';

export interface ServerDeps extends RouterDeps {
  token: string;
  port: number;
  keyStatus: () => Record<string, { has_key: boolean; verified_on: string | null }>;
  reloadKeys: () => void;
  keystoreName: string;
  setup?: SetupDeps;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopback(host: string) {
  return LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Refuse non-loopback binds unless the user explicitly accepts the exposure. */
export function checkBind(host: string, iKnow: boolean) {
  if (!isLoopback(host) && !iKnow) {
    throw new PocketError(`refusing to bind to ${host}: pocket would expose your provider keys' quota to the network. Use 127.0.0.1, or pass --i-know-this-is-exposed.`);
  }
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function presentedToken(req: http.IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const xk = req.headers['x-api-key'];
  if (typeof xk === 'string') return xk.trim();
  const cookie = /(?:^|;\s*)pocket_token=([^;]+)/.exec(req.headers.cookie ?? '');
  if (cookie) return decodeURIComponent(cookie[1]);
  const q = url.searchParams.get('token');
  return q;
}

async function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new PocketError('request body too large', 413);
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new PocketError('request body is not JSON', 400);
  }
}

function dashDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'dash');
}

/** Everything the dashboard shows. Never includes a key. */
export function snapshot(deps: ServerDeps) {
  const now = deps.now();
  const pol: Policy = deps.policy();
  const providers: Record<string, Provider> = deps.providers();
  const keys = deps.keyStatus();
  const out: any = { now: new Date(now).toISOString(), order: pol.order, providers: {}, agents: deps.state.agents, failovers: deps.state.log.slice(-50).reverse() };
  for (const id of new Set([...pol.order, ...Object.keys(keys)])) {
    const p = providers[id];
    if (!p) continue;
    const u = deps.state.meter.get(id, now);
    const cap = pol.caps[id]?.daily_cap_usd;
    out.providers[id] = {
      has_key: !!keys[id]?.has_key,
      paid: p.paid,
      limits: p.limits,
      limits_verified_on: p.verified_on,
      notice: p.notice ?? null,
      used: { rpm: u.window.length, rpd: u.reqDay, tpd: u.tokDay, tpmonth: u.tokMonth },
      live: u.live ?? null,
      spend_usd: p.paid ? Number(u.spendDay.toFixed(4)) : undefined,
      cap_usd: p.paid ? cap : undefined,
      resets_at: new Date(nextReset(now)).toISOString(),
      cooldown_until: u.cooldownUntil > now ? new Date(u.cooldownUntil).toISOString() : null,
      blocked: deps.state.meter.blocked(p, now, cap),
      last_error: u.lastError,
    };
  }
  out.degraded = Object.values(deps.state.agents).some((a: any) => a.degraded);
  return out;
}

const FAMILY: Record<string, string> = { strong: 'opus', mid: 'sonnet', fast: 'haiku' };

/** Model ids agents may pick from: the paid providers' tier models (pocket maps any of them to a tier). */
export function modelList(providers: Record<string, Provider>): { id: string; family?: string }[] {
  const out: { id: string; family?: string }[] = [];
  const seen = new Set<string>();
  for (const p of Object.values(providers)) {
    if (!p.passthrough) continue;
    for (const tier of ['strong', 'mid', 'fast'] as const) {
      const id = p.tiers[tier];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, family: id.startsWith('claude-') ? FAMILY[tier] : undefined });
    }
  }
  return out;
}

export function createServer(deps: ServerDeps): http.Server {
  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${deps.port}`);
    // DNS-rebinding guard: a web page cannot reach us under another host name
    if (!isLoopback(host) && !(server as any).exposed) {
      return sendJson(res, 421, { error: { message: `unexpected Host "${host}"` } });
    }
    let pathname = url.pathname.replace(/\/+$/, '') || '/';
    // agent identity by path, for clients that cannot send x-pocket-agent: /a/<agent>/openai/v1/...
    let pathAgent: string | null = null;
    const pa = /^\/a\/([A-Za-z0-9._-]{1,64})(\/.*)$/.exec(pathname);
    if (pa) {
      pathAgent = pa[1];
      pathname = pa[2];
    }
    // Claude Desktop (third-party inference, gateway mode): base URL http://127.0.0.1:<port>/desktop.
    // Whatever it appends (/v1/messages, /messages, /v1/models) lands on the Anthropic routes.
    let desktop = false;
    if (pathname === '/desktop' || pathname.startsWith('/desktop/')) {
      desktop = true;
      pathname = '/anthropic/v1' + (pathname.slice('/desktop'.length).replace(/^(\/v1)+/, '') || '/');
      pathname = pathname.replace(/\/+$/, '') || '/';
    }
    try {
      if (pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, port: deps.port, keychain: deps.keystoreName, providers: deps.keyStatus() });
      }
      const tok = presentedToken(req, url);
      if (!tok || !safeEq(tok, deps.token)) {
        if (pathname.startsWith('/anthropic')) return sendJson(res, 401, { type: 'error', error: { type: 'authentication_error', message: '[pocket] missing or wrong local token' } });
        return sendJson(res, 401, { error: { message: '[pocket] missing or wrong local token', type: 'invalid_api_key', code: 401 } });
      }
      const agentH = req.headers['x-pocket-agent'];
      const agent = typeof agentH === 'string' && agentH.trim() ? agentH.trim() : (pathAgent ?? (desktop ? 'claude-desktop' : null));

      if (req.method === 'POST' && pathname === '/anthropic/v1/messages') {
        return await route(deps, { format: 'anthropic', body: await readBody(req), agent, headers: req.headers }, res);
      }
      if (req.method === 'POST' && pathname === '/anthropic/v1/messages/count_tokens') {
        // estimated locally (~4 chars per token) so token counting never spends quota or triggers failover
        const body = await readBody(req);
        const chars = JSON.stringify({ s: body.system ?? '', m: body.messages ?? [], t: body.tools ?? [] }).length;
        return sendJson(res, 200, { input_tokens: Math.ceil(chars / 4) });
      }
      if (req.method === 'POST' && pathname === '/openai/v1/chat/completions') {
        return await route(deps, { format: 'openai', body: await readBody(req), agent, headers: req.headers }, res);
      }
      if (req.method === 'POST' && pathname === '/openai/v1/responses') {
        return await route(deps, { format: 'responses', body: await readBody(req), agent, headers: req.headers }, res);
      }
      if (req.method === 'GET' && (pathname === '/openai/v1/models' || pathname === '/anthropic/v1/models')) {
        const list = modelList(deps.providers());
        if (pathname.startsWith('/openai')) return sendJson(res, 200, { object: 'list', data: list.map((m) => ({ id: m.id, object: 'model', owned_by: 'pocket' })) });
        return sendJson(res, 200, {
          data: list.filter((m) => m.family).map((m) => ({ id: m.id, type: 'model', display_name: m.id, anthropic_family_tier: m.family, is_family_default: true })),
          has_more: false,
        });
      }
      if (req.method === 'POST' && pathname === '/admin/reload') {
        deps.reloadKeys();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && pathname === '/dash/state') return sendJson(res, 200, snapshot(deps));
      if (req.method === 'GET' && pathname === '/dash/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const push = () => res.write(`event: state\ndata: ${JSON.stringify(snapshot(deps))}\n\n`);
        push();
        const off = deps.state.subscribe(() => push());
        const tick = setInterval(push, 5000);
        req.on('close', () => {
          off();
          clearInterval(tick);
        });
        return;
      }
      if (pathname.startsWith('/setup/api/')) {
        if (!deps.setup) return sendJson(res, 404, { error: { message: 'setup is not available here' } });
        const method = req.method ?? 'GET';
        if (method !== 'GET' && !sameOrigin(req, deps.port)) return sendJson(res, 403, { error: { message: '[pocket] setup changes must come from the setup page' } });
        const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req, 1024 * 1024);
        try {
          return sendJson(res, 200, await setupApi(deps.setup, method, pathname.slice('/setup/api/'.length), body));
        } catch (e: any) {
          if (e instanceof PocketError) return sendJson(res, e.code >= 400 ? e.code : 400, { ok: false, message: e.message });
          throw e;
        }
      }
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(302, { location: '/setup' });
        return res.end();
      }
      if (req.method === 'GET' && (pathname === '/dash' || pathname === '/dash/dash.js' || pathname === '/dash/dash.css' || pathname === '/setup' || pathname === '/setup/setup.js')) {
        const file = pathname === '/dash' ? 'index.html' : pathname === '/setup' ? 'setup.html' : path.basename(pathname);
        const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
        const body = fs.readFileSync(path.join(dashDir(), file));
        // the cookie lets the page's own fetch/EventSource calls authenticate after ?token=
        res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'set-cookie': `pocket_token=${encodeURIComponent(deps.token)}; Path=/; HttpOnly; SameSite=Strict`, 'cache-control': 'no-store' });
        return res.end(body);
      }
      return sendJson(res, 404, { error: { message: `no route ${req.method} ${pathname}` } });
    } catch (e: any) {
      deps.log(`error ${pathname}: ${e?.message ?? e}`);
      if (res.headersSent) return res.end();
      const status = e instanceof PocketError && e.code >= 400 ? e.code : 500;
      return sendJson(res, status, { error: { message: `[pocket] ${e?.message ?? e}` } });
    }
  });
  return server;
}

export function listen(server: http.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const a = server.address();
      resolve(typeof a === 'object' && a ? a.port : port);
    });
  });
}

export { State };
