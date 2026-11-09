import { Paths, readJson, writePrivate } from './config.js';
import { Meter, MeterSnapshot } from './meter.js';

export interface FailoverEvent {
  ts: string;
  agent: string;
  from: string;
  to: string | null; // null = nothing could serve the request
  reason: string;
  /** ms from the failure being detected to the first token on the fallback */
  latency_ms: number | null;
}

export interface AgentState {
  provider: string;
  model: string;
  at: string;
  degraded: boolean;
  reason: string | null;
}

/** Live daemon state: the meter, the failover log, per-agent routing. Persisted without secrets. */
export class State {
  meter: Meter;
  log: FailoverEvent[] = [];
  agents: Record<string, AgentState> = {};
  bannerShown = new Set<string>(); // agent|provider pairs that already saw the banner this episode
  private subs = new Set<(kind: string, data: unknown) => void>();
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private p: Paths | null) {
    const saved = p ? readJson<{ meter?: MeterSnapshot; log?: FailoverEvent[] }>(p.state, {}) : {};
    this.meter = new Meter(saved.meter ?? {});
    this.log = saved.log ?? [];
  }

  subscribe(fn: (kind: string, data: unknown) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(kind: string, data: unknown) {
    for (const fn of this.subs) {
      try {
        fn(kind, data);
      } catch {
        /* a dead dashboard must not break routing */
      }
    }
    this.save();
  }

  failover(e: FailoverEvent) {
    this.log.push(e);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    this.emit('failover', e);
  }

  served(agent: string, s: AgentState) {
    this.agents[agent] = s;
    if (!s.degraded) for (const k of [...this.bannerShown]) if (k.startsWith(agent + '|')) this.bannerShown.delete(k);
    this.emit('served', { agent, ...s });
  }

  save() {
    if (!this.p || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
    this.saveTimer.unref?.();
  }

  flush() {
    if (!this.p) return;
    writePrivate(this.p.state, JSON.stringify({ meter: this.meter.snapshot(), log: this.log.slice(-200) }) + '\n');
  }
}
