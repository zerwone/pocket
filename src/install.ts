import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Is this process running out of npx's throwaway cache? Launchers pointing there break later. */
export function underNpx(mainPath = process.argv[1] ?? ''): boolean {
  return /[\\/]_npx[\\/]/.test(mainPath);
}

/** The installed copy's main.js when this process runs from npx and a global install exists. */
export function globalMain(env: NodeJS.ProcessEnv): string | null {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { env, encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true, timeout: 10_000 });
    const root = r.stdout?.trim();
    if (!root) return null;
    const main = path.join(root, '@zerwone', 'pocket', 'dist', 'main.js');
    return fs.existsSync(main) ? main : null;
  } catch {
    return null;
  }
}

/** main.js the launchers should run: this copy, unless it lives in npx's cache and an installed copy exists. */
export function launcherMain(env: NodeJS.ProcessEnv): string {
  const here = fileURLToPath(new URL('./main.js', import.meta.url));
  if (!underNpx(here)) return here;
  return globalMain(env) ?? here;
}
