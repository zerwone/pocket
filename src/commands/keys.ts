import { Args, Ctx } from '../ctx.js';
import { localToken, paths, PocketError, readJson, writePrivate } from '../config.js';
import { Keystore, keystoreFor, readIndex, recordKey, writeIndex } from '../keystore.js';
import { loadProviders, Provider } from '../providers.js';
import { notifyReload } from './daemon.js';

export type VerifyResult = { ok: true } | { ok: false; rejected: boolean; detail: string };

/** One cheap authenticated request: list models. */
export async function verifyKey(p: Provider, key: string, timeoutMs = 10_000): Promise<VerifyResult> {
  const base = p.base_url.replace(/\/$/, '');
  const url = p.format === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
  const headers: Record<string, string> = p.format === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await r.arrayBuffer().catch(() => undefined);
    if (r.ok) return { ok: true };
    return { ok: false, rejected: r.status === 401 || r.status === 403, detail: `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, rejected: false, detail: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

export async function cmdKeys(ctx: Ctx, args: Args, ksOverride?: Keystore): Promise<number> {
  const sub = args._[0] ?? 'list';
  const p = paths(ctx.env);
  const providers = loadProviders(p);
  const ks = ksOverride ?? (await keystoreFor(ctx.env));
  const now = new Date();

  if (sub === 'add') {
    const id = args._[1];
    if (!id) throw new PocketError(`usage: pocket keys add <provider>   (providers: ${Object.keys(providers).join(', ')})`);
    const prov = providers[id];
    if (!prov) throw new PocketError(`unknown provider "${id}". Known: ${Object.keys(providers).join(', ')}. Add a custom one to ${p.providers}.`);
    if (prov.notice) ctx.err(`note: ${prov.notice}`);
    ks.probe(); // refuse early, before asking for a secret, if there is no keychain
    const key = (await ctx.readSecret(`${id} API key (input hidden): `)).trim();
    if (!key) throw new PocketError('no key entered');
    if (/\s/.test(key)) throw new PocketError('that does not look like an API key (contains whitespace)');
    let verified = false;
    if (!args.flags['no-verify']) {
      const v = await verifyKey(prov, key);
      if (v.ok) verified = true;
      else if (v.rejected) throw new PocketError(`${id} rejected the key (${v.detail}); not stored`);
      else ctx.err(`warning: could not verify the ${id} key (${v.detail}); storing it unverified. \`pocket doctor\` will retry.`);
    }
    ks.set(id, key);
    recordKey(p, id, verified, now);
    await notifyReload(ctx.env, localToken(p));
    ctx.out(`${id}: key stored in ${ks.name}${verified ? ', verified' : ''}`);
    return 0;
  }

  if (sub === 'list') {
    const idx = readIndex(p);
    const rows = Object.keys(providers).map((id) => {
      let present = false;
      try {
        present = !!ks.get(id);
      } catch {
        present = false;
      }
      return { provider: id, in_keychain: present, verified_on: idx[id]?.verified_on ?? null };
    });
    if (args.flags.json) ctx.out(JSON.stringify(rows, null, 2));
    else for (const r of rows) ctx.out(`${r.provider.padEnd(11)} ${r.in_keychain ? 'stored' : '-     '} ${r.verified_on ? `verified ${r.verified_on}` : ''}`.trimEnd());
    return 0;
  }

  if (sub === 'rm' || sub === 'remove') {
    const id = args._[1];
    if (!id) throw new PocketError('usage: pocket keys rm <provider>');
    const removed = ks.delete(id);
    const idx = readIndex(p);
    delete idx[id];
    writeIndex(p, idx);
    await notifyReload(ctx.env, localToken(p));
    ctx.out(removed ? `${id}: key removed from ${ks.name}` : `${id}: no key stored`);
    return 0;
  }

  throw new PocketError('usage: pocket keys add|list|rm <provider>');
}

export { readJson, writePrivate };
