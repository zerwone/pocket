import * as fs from 'node:fs';
import * as path from 'node:path';
import { Args, Ctx } from '../ctx.js';
import { PocketError } from '../config.js';
import { Keystore } from '../keystore.js';
import { cmdKeys } from './keys.js';
import { cmdDaemon } from './daemon.js';
import { cmdAttach, readAttachments } from './attach.js';
import { paths } from '../config.js';

/** Free providers offered during setup, in the default fallback order, with where to get a key. */
export const SETUP_PROVIDERS: { id: string; label: string; url: string; note: string }[] = [
  { id: 'groq', label: 'Groq', url: 'https://console.groq.com/keys', note: 'fastest; 1,000 requests/day' },
  { id: 'nvidia', label: 'NVIDIA', url: 'https://build.nvidia.com', note: '~40 requests/min; phone verification' },
  { id: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/settings/keys', note: '50 requests/day free' },
  { id: 'cerebras', label: 'Cerebras', url: 'https://cloud.cerebras.ai', note: '1M tokens/day, 5 requests/min' },
];

/** The PATH directory holding executable `name`, or null. */
export function whichDir(name: string, env: NodeJS.ProcessEnv): string | null {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, name + ext)).isFile()) return dir;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Is `name` an executable on PATH? */
export function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return whichDir(name, env) !== null;
}

/** A ctx whose secret prompt returns a key we already read, so cmdKeys runs unchanged. */
function withSecret(ctx: Ctx, secret: string): Ctx {
  return { ...ctx, readSecret: async () => secret };
}

export async function cmdSetup(ctx: Ctx, args: Args, ksOverride?: Keystore): Promise<number> {
  const pass = (extra: Args['flags'] = {}): Args['flags'] => {
    const f: Args['flags'] = { ...extra };
    for (const k of ['port', 'bin-dir', 'no-verify']) if (args.flags[k] !== undefined) f[k] = args.flags[k];
    return f;
  };
  ctx.out('pocket setup: your agent keeps working when your paid model runs out.\n');

  // 1. agents
  const agents = (['claude', 'codex'] as const).filter((a) => onPath(a, ctx.env));
  if (agents.length) ctx.out(`Found: ${agents.map((a) => (a === 'claude' ? 'Claude Code' : 'Codex')).join(', ')}`);
  else ctx.out('No Claude Code or Codex found on PATH. Install one first, then run `pocket setup` again (keys you add now are kept).');

  // 2. free keys
  ctx.out('\nStep 1 of 3: free keys. Add at least one. Press Enter to skip any.\n');
  let added = 0;
  for (const p of SETUP_PROVIDERS) {
    ctx.out(`${p.label} (${p.note})\n  get a key: ${p.url}`);
    const key = (await ctx.readSecret(`  paste ${p.label} key: `)).trim();
    if (!key) {
      ctx.out('  skipped\n');
      continue;
    }
    try {
      await cmdKeys(withSecret(ctx, key), { _: ['add', p.id], flags: pass() }, ksOverride);
      added++;
    } catch (e: any) {
      if (e instanceof PocketError) ctx.err(`  ${e.message}`);
      else throw e;
    }
    ctx.out('');
  }

  // 3. optional paid key
  ctx.out('Step 2 of 3: your paid key (optional). pocket uses it first, up to $10/day, then falls back to the free keys.');
  const paid = (await ctx.readSecret('  paste Anthropic key, or Enter to skip: ')).trim();
  if (paid) {
    try {
      await cmdKeys(withSecret(ctx, paid), { _: ['add', 'anthropic'], flags: pass() }, ksOverride);
      added++;
    } catch (e: any) {
      if (e instanceof PocketError) ctx.err(`  ${e.message}`);
      else throw e;
    }
  }
  if (!added) {
    ctx.err('\nNo keys added, so there is nothing to fall back to. Run `pocket setup` again when you have one.');
    return 1;
  }

  // 4. start + attach
  ctx.out('\nStep 3 of 3: connecting your agents.');
  if (!args.flags['no-daemon']) await cmdDaemon(ctx, { _: ['start'], flags: pass() });
  for (const a of agents) await cmdAttach(ctx, { _: [a], flags: pass() });

  const att = readAttachments(paths(ctx.env));
  const cmdFor = (launcher: string | undefined, name: string) =>
    !launcher || onPath(name, ctx.env) ? name : `"${launcher}"   (or add ${path.dirname(launcher)} to your PATH to type ${name})`;
  ctx.out('\nDone.');
  if (agents.includes('claude')) ctx.out(`  run Claude Code through pocket:  ${cmdFor(att.claude?.launcher, 'claude-pocket')}`);
  if (agents.includes('codex')) ctx.out(`  run Codex through pocket:        ${cmdFor(att.codex?.launcher, 'codex-pocket')}`);
  ctx.out('  watch it live:                   pocket dash');
  ctx.out('  undo everything:                 pocket detach claude / pocket detach codex');
  return 0;
}
