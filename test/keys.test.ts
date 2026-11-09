import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { osKeystore } from '../src/keystore.js';
import { allText, fakeServer, Fake, json, pocket, pocketBin, tmpDir } from './helpers.js';

const SERVICE = 'pocket-test-' + process.pid;
const SECRET = 'gsk_test_' + 'Z'.repeat(20) + '_do_not_leak';

async function keychainAvailable(): Promise<string | null> {
  try {
    (await osKeystore(SERVICE)).probe();
    return null;
  } catch (e: any) {
    return e.message;
  }
}

let fake: Fake;
let home: string;
let env: Record<string, string>;
let unavailable: string | null;

beforeAll(async () => {
  unavailable = await keychainAvailable();
  fake = await fakeServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth === `Bearer ${SECRET}`) return json(res, 200, { data: [] });
    return json(res, 401, { error: 'bad key' });
  });
  home = tmpDir();
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: { groq: { base_url: fake.url + '/openai/v1' } } }));
  env = { POCKET_HOME: home, POCKET_KEYCHAIN_SERVICE: SERVICE };
});

afterAll(async () => {
  await fake.close();
  if (!unavailable) {
    const ks = await osKeystore(SERVICE);
    ks.delete('groq');
  }
});

describe('keys against the real OS keychain', () => {
  it('reports which keychain is in use (or why there is none)', () => {
    // visible in the test log: proves which path ran on this machine
    console.log(unavailable ? `keychain unavailable: ${unavailable}` : `keychain available on ${process.platform}`);
    expect(true).toBe(true);
  });

  it.runIf(!process.env.POCKET_SKIP_KEYCHAIN)('add → list → rm, verified with one cheap request; plaintext never in the config dir', async (ctx) => {
    if (unavailable) ctx.skip();
    let r = await pocket(['keys', 'add', 'groq'], env, { secret: SECRET });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/groq: key stored in .*verified/);
    expect(fake.requests.at(-1)!.path).toBe('/openai/v1/models');
    // the key is really in the OS keychain
    expect((await osKeystore(SERVICE)).get('groq')).toBe(SECRET);
    r = await pocket(['keys', 'list', '--json'], env);
    const rows = JSON.parse(r.out);
    expect(rows.find((x: any) => x.provider === 'groq')).toMatchObject({ in_keychain: true, verified_on: new Date().toISOString().slice(0, 10) });
    expect(r.out).not.toContain(SECRET);
    // grep the whole config dir: no plaintext key anywhere
    expect(allText(home)).not.toContain(SECRET);
    expect(allText(home)).not.toContain(SECRET.slice(4, 24));
    r = await pocket(['keys', 'rm', 'groq'], env);
    expect(r.out).toMatch(/groq: key removed/);
    expect((await osKeystore(SERVICE)).get('groq')).toBeNull();
    // and no copy is left behind in the Linux kernel keyring either
    if (process.platform === 'linux' && fs.existsSync('/proc/keys')) expect(fs.readFileSync('/proc/keys', 'utf8')).not.toContain(SERVICE);
  });

  it('a key the provider rejects is not stored', async (ctx) => {
    if (unavailable) ctx.skip();
    const r = await pocket(['keys', 'add', 'groq'], env, { secret: 'gsk_wrong' });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/rejected the key \(HTTP 401\); not stored/);
    expect((await osKeystore(SERVICE)).get('groq')).toBeNull();
  });

  it('the piped-stdin path of the real binary works too (no echo, no argv)', async (ctx) => {
    if (unavailable) ctx.skip();
    const r = pocketBin(['keys', 'add', 'groq', '--no-verify'], env, SECRET + '\n');
    expect(r.code, r.err).toBe(0);
    expect(r.out + r.err).not.toContain(SECRET);
    expect((await osKeystore(SERVICE)).get('groq')).toBe(SECRET);
    pocketBin(['keys', 'rm', 'groq'], env);
  });
});

describe('no keychain: refuse and say why', () => {
  it.runIf(process.platform === 'linux')('keys add refuses before asking, and nothing is written', () => {
    const h = tmpDir();
    const r = pocketBin(['keys', 'add', 'groq'], { POCKET_HOME: h, POCKET_KEYCHAIN_SERVICE: SERVICE, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus' }, SECRET + '\n');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no usable Secret Service keychain/);
    expect(r.err).toMatch(/does not fall back to the kernel keyring/);
    expect(fs.existsSync(h) ? allText(h) : '').not.toContain(SECRET);
  });
});
