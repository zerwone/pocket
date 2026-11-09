import { readFileSync } from 'node:fs';
import { Args, Ctx, defaultCtx, parseArgs } from './ctx.js';
import { PocketError } from './config.js';
import { cmdDaemon } from './commands/daemon.js';
import { cmdKeys } from './commands/keys.js';
import { cmdAttach, cmdDetach } from './commands/attach.js';
import { cmdDash, cmdDoctor, cmdLanes, cmdRoute } from './commands/misc.js';
import { cmdSetup } from './commands/setup.js';

export const HELP = `pocket: when your coding agent hits its usage limit, pocket moves it to your next key.

  pocket setup                           start here: add free keys, connect your agents
  pocket dash                            see quota, spend and every failover

More:
  pocket daemon start|stop|status|logs   run the router (127.0.0.1:3460)
  pocket keys add <provider>             store a key in the OS keychain (input hidden), verify it
  pocket keys list | keys rm <provider>
  pocket route ["prompt"] [--agent a]    send one test request; shows which provider served it
  pocket attach claude [--vscode]        write the claude-pocket launcher
  pocket attach codex                    add the pocket provider to ~/.codex/config.toml (with backup)
  pocket attach cursor                   print the settings to paste into Cursor
  pocket detach claude|codex|cursor      undo attach; configs return byte-identical
  pocket doctor [--offline]              keychain, port, keys, stale limits, attached-but-down
  pocket staked sync [--repo path]       per-agent routing from a staked roles.yml provider_policy

Providers: groq cerebras nvidia openrouter mistral anthropic openai (+ custom in providers.json)
Fallback models are weaker than the paid one. pocket says so in the session; it never hides it.
`;

type Cmd = (ctx: Ctx, args: Args) => Promise<number>;

const TABLE: Record<string, Cmd> = {
  setup: (c, a) => cmdSetup(c, a),
  daemon: cmdDaemon,
  keys: (c, a) => cmdKeys(c, a),
  route: cmdRoute,
  attach: cmdAttach,
  detach: cmdDetach,
  dash: cmdDash,
  doctor: (c, a) => cmdDoctor(c, a),
  staked: cmdLanes,
  lanes: cmdLanes, // pre-rename name
};

export async function run(argv: string[], ctx: Ctx = defaultCtx()): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e: any) {
    ctx.err(`pocket: ${e.message}`);
    return 2;
  }
  const [cmd, ...rest] = args._;
  if (args.flags.version || cmd === 'version') {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    ctx.out(pkg.version);
    return 0;
  }
  if (!cmd || cmd === 'help' || args.flags.help) {
    ctx.out(HELP);
    return 0;
  }
  const fn = TABLE[cmd];
  if (!fn) {
    ctx.err(`pocket: unknown command "${cmd}". Run \`pocket help\`.`);
    return 2;
  }
  try {
    return await fn(ctx, { _: rest, flags: args.flags });
  } catch (e: any) {
    if (e instanceof PocketError) {
      ctx.err(`pocket ${cmd}: ${e.message}`);
      return e.code > 2 && e.code < 100 ? e.code : 1;
    }
    ctx.err(`pocket ${cmd}: ${e?.stack ?? e}`);
    return 70;
  }
}
