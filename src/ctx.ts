export interface Ctx {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  /** read a secret from the terminal without echo (or from piped stdin) */
  readSecret: (prompt: string) => Promise<string>;
  /** ask yes/no; non-interactive answers no */
  confirm: (prompt: string) => Promise<boolean>;
}

export interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN = new Set(['json', 'help', 'write', 'vscode', 'offline', 'no-verify', 'stdin', 'yes', 'i-know-this-is-exposed', 'no-open', 'force', 'version', 'stream', 'no-daemon']);

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') {
      out.flags.help = true;
      continue;
    }
    if (a === '-n' && argv[i + 1]) {
      out.flags.n = argv[++i];
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) out.flags[key] = a.slice(eq + 1);
      else if (BOOLEAN.has(key)) out.flags[key] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined) throw new Error(`--${key} needs a value`);
        out.flags[key] = v;
        i++;
      }
      continue;
    }
    out._.push(a);
  }
  return out;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Terminal prompt with echo off. Piped stdin is read whole (for scripts). */
export function readSecretTTY(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return readAllStdin().then((s) => s.trim());
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    let buf = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          done();
          return resolve(buf.trim());
        }
        if (c === '\u0003') {
          done();
          return reject(new Error('cancelled'));
        }
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    const done = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}

export function defaultCtx(): Ctx {
  return {
    env: process.env,
    cwd: process.cwd(),
    out: (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n'),
    err: (s) => process.stderr.write(s.endsWith('\n') ? s : s + '\n'),
    readSecret: readSecretTTY,
    confirm: async (prompt) => {
      if (!process.stdin.isTTY) return false;
      process.stderr.write(prompt + ' [y/N] ');
      const line: string = await new Promise((r) => process.stdin.once('data', (d) => r(String(d))));
      process.stdin.pause();
      return /^y/i.test(line.trim());
    },
  };
}
