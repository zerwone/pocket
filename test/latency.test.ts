import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { anthropicPost, json, openAIBehaviour, rig } from './helpers.js';

/**
 * Failover latency: ms from the 429 arriving at pocket to the first token from the fallback,
 * as pocket itself records it (the dashboard's "429 → first token" column). Both providers are
 * local fakes, so this measures pocket's own overhead plus the fallback's time to first token.
 */
describe('failover latency', () => {
  it('measures 429 → first token on the fallback (stream and non-stream)', async () => {
    const r = await rig({
      // 429 without retry-after and cooldown 0, so every request hits the paid provider first
      paid: (req, res) => json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }),
      groq: openAIBehaviour('ok'),
      policy: 'order: [anthropic, groq]\nfailover:\n  on: [429, 5xx, timeout, connection]\n  retry_same_provider: 1\n  cooldown_seconds: 0\ndegraded_banner: true\n',
    });
    // this test sends 60 requests a minute: lift the seeded groq rpm limit (30) for it
    const pj = path.join(r.home, 'providers.json');
    const prov = JSON.parse(fs.readFileSync(pj, 'utf8'));
    prov.providers.groq.limits = {};
    fs.writeFileSync(pj, JSON.stringify(prov));
    try {
      const N = 30;
      const samples: Record<string, number[]> = { stream: [], json: [] };
      for (const mode of ['stream', 'json'] as const) {
        for (let i = 0; i < N; i++) {
          const res = await anthropicPost(r, { model: 'claude-sonnet-4-5', max_tokens: 10, stream: mode === 'stream', messages: [{ role: 'user', content: 'x' }] });
          expect(res.headers.get('x-pocket-provider')).toBe('groq');
          await res.text();
          const d: any = await (await fetch(`${r.base}/dash/state`, { headers: { authorization: `Bearer ${r.token}` } })).json();
          samples[mode].push(d.failovers[0].latency_ms);
        }
      }
      const stat = (xs: number[]) => {
        const s = [...xs].sort((a, b) => a - b);
        return { median: s[Math.floor(s.length / 2)], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1] };
      };
      const st = stat(samples.stream);
      const js = stat(samples.json);
      console.log(`failover latency (429 → first token), ${N} runs each, local fakes: stream median ${st.median} ms, p95 ${st.p95} ms, max ${st.max} ms; non-stream median ${js.median} ms, p95 ${js.p95} ms, max ${js.max} ms`);
      expect(st.median).toBeLessThan(100);
      expect(js.median).toBeLessThan(100);
    } finally {
      await r.close();
    }
  }, 60_000);
});
