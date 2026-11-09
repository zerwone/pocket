// Minimal Server-Sent Events parser/serializer (both directions), no dependency.

export interface SseEvent {
  event?: string;
  data: string;
}

/** Incremental parser: feed text chunks, get complete events. */
export class SseParser {
  private buf = '';
  private event: string | undefined;
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, nl);
      const sep = this.buf.slice(nl, nl + 2) === '\r\n' ? 2 : 1;
      this.buf = this.buf.slice(nl + sep);
      if (line === '') {
        if (this.data.length || this.event) out.push({ event: this.event, data: this.data.join('\n') });
        this.event = undefined;
        this.data = [];
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? '' : line.slice(i + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') this.event = value;
      else if (field === 'data') this.data.push(value);
    }
    return out;
  }

  /** Flush a trailing event that had no blank line after it. */
  end(): SseEvent[] {
    const out = this.push('\n\n');
    return out;
  }
}

export function sse(event: string | undefined, data: unknown): string {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return (event ? `event: ${event}\n` : '') + body.split('\n').map((l) => `data: ${l}`).join('\n') + '\n\n';
}
