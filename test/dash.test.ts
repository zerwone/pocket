import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { anthropicPost, rateLimited, rig } from './helpers.js';

const require = createRequire(import.meta.url);
let playwright: any = null;
try {
  playwright = require('playwright');
} catch {
  playwright = null;
}

describe('dashboard', () => {
  it('state endpoint carries quota, spend, per-agent provider and the failover log', async () => {
    const r = await rig({ paid: rateLimited });
    try {
      await (await anthropicPost(r, { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }, { 'x-pocket-agent': 'claude-code' })).text();
      const s: any = await (await fetch(`${r.base}/dash/state`, { headers: { authorization: `Bearer ${r.token}` } })).json();
      expect(s.providers.groq).toMatchObject({ has_key: true, used: { rpd: 1, rpm: 1 }, limits: { rpm: 30, rpd: 1000 } });
      expect(s.providers.anthropic).toMatchObject({ paid: true, cap_usd: 10, spend_usd: 0 });
      expect(s.providers.anthropic.cooldown_until).toBeTruthy();
      expect(s.agents['claude-code']).toMatchObject({ provider: 'groq', degraded: true });
      expect(s.failovers).toHaveLength(1);
      // the HTML page and its one JS file are served, and the token in the URL becomes an HttpOnly cookie
      const page = await fetch(`${r.base}/dash?token=${r.token}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('set-cookie')).toMatch(/pocket_token=.*HttpOnly; SameSite=Strict/);
      expect(await page.text()).toContain('<script src="/dash/dash.js">');
      expect((await fetch(`${r.base}/dash/dash.js`, { headers: { cookie: `pocket_token=${r.token}` } })).status).toBe(200);
    } finally {
      await r.close();
    }
  });

  it.runIf(!!playwright)('renders the failover event live in a real browser, phone width included', async () => {
    const r = await rig({ paid: rateLimited });
    const browser = await playwright.chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
      const errors: string[] = [];
      page.on('pageerror', (e: any) => errors.push(String(e)));
      await page.goto(`${r.base}/dash?token=${r.token}`);
      await page.waitForSelector('#log tbody td.muted'); // "no failovers" before any traffic
      await (await anthropicPost(r, { model: 'claude-sonnet-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }, { 'x-pocket-agent': 'claude-code' })).text();
      // pushed over SSE, no reload
      await page.waitForFunction(() => document.querySelector('#log tbody')?.textContent?.includes('anthropic quota exhausted (429)'), null, { timeout: 5000 });
      expect(await page.textContent('#status')).toMatch(/degraded/);
      expect(await page.textContent('#agents tbody')).toContain('groq/qwen/qwen3.8-27b');
      expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await r.close();
    }
  });
});
