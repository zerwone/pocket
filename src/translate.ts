// Anthropic Messages ⇄ OpenAI Chat Completions.
// Internally everything pivots through the Anthropic shape: inbound requests are
// normalised to an Anthropic request, responses to an Anthropic message or
// Anthropic stream events, then converted to whatever the client speaks.

export class TranslateError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type J = any;

// ---------------------------------------------------------------- requests

function systemText(system: J): string | undefined {
  if (system === undefined || system === null) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.filter((b) => b?.type === 'text').map((b) => b.text).join('\n\n');
  throw new TranslateError('system must be a string or a list of text blocks');
}

function blocks(content: J): J[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  if (content === null || content === undefined) return [];
  throw new TranslateError('message content must be a string or a list of blocks');
}

function toolResultText(content: J): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b?.type === 'text') return b.text;
        // OpenAI-format tool messages are text only; a screenshot from a tool is described, not sent
        if (b?.type === 'image') return '[image returned by the tool; this model cannot see images]';
        return JSON.stringify(b);
      })
      .join('\n');
  }
  return JSON.stringify(content);
}

function imagePart(b: J): J {
  const s = b.source ?? {};
  if (s.type === 'base64') return { type: 'image_url', image_url: { url: `data:${s.media_type};base64,${s.data}` } };
  if (s.type === 'url') return { type: 'image_url', image_url: { url: s.url } };
  throw new TranslateError(`unsupported image source type "${s.type}"`);
}

export function hasImages(anthropicReq: J): boolean {
  for (const m of anthropicReq.messages ?? []) {
    for (const b of blocks(m.content)) {
      if (b?.type === 'image') return true;
      // images inside tool results (screenshots) are turned into a text note for OpenAI-format providers, so they don't count
    }
  }
  return false;
}

/** Anthropic request → OpenAI chat request (for an OpenAI-format upstream). */
export function anthropicToOpenAIRequest(req: J, model: string): J {
  if (!Array.isArray(req.messages)) throw new TranslateError('messages is required');
  const messages: J[] = [];
  const sysParts: string[] = [];
  const top = systemText(req.system);
  if (top) sysParts.push(top);
  // Claude Code also sends role:"system" turns mid-conversation. Many open models only accept one
  // system message at the start, so leading ones join it and later ones ride along with the next
  // user turn (after its tool results, so tool call/result pairs stay adjacent).
  let pendingSys: string[] = [];
  let seenTurn = false;
  for (const m of req.messages) {
    const bs = blocks(m.content);
    if (m.role === 'system' || m.role === 'developer') {
      const t = bs.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (!t) continue;
      if (!seenTurn) sysParts.push(t);
      else pendingSys.push(t);
      continue;
    }
    seenTurn = true;
    if (m.role === 'assistant') {
      if (pendingSys.length) {
        messages.push({ role: 'user', content: pendingSys.map((t) => `<system-reminder>\n${t}\n</system-reminder>`).join('\n') });
        pendingSys = [];
      }
      const text = bs.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = bs
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: J = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      messages.push(msg);
      continue;
    }
    // anything else is treated as the user side of the conversation rather than failing the turn
    // tool results become role:tool messages, which must directly follow the assistant turn
    for (const b of bs.filter((x) => x.type === 'tool_result')) {
      const text = toolResultText(b.content);
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.is_error ? `ERROR: ${text}` : text });
    }
    const rest = bs.filter((b) => b.type !== 'tool_result');
    const parts: J[] = pendingSys.map((t) => ({ type: 'text', text: `<system-reminder>\n${t}\n</system-reminder>` }));
    pendingSys = [];
    if (!rest.length && !parts.length) continue;
    for (const b of rest) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text });
      else if (b.type === 'image') parts.push(imagePart(b));
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') continue;
      else if (typeof b.text === 'string' && b.text) parts.push({ type: 'text', text: b.text });
      // other block types (documents, server tool results, ...) have no OpenAI equivalent: skipped so the turn still goes through
    }
    if (!parts.length) continue;
    messages.push({ role: 'user', content: parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('\n') : parts });
  }
  if (pendingSys.length) messages.push({ role: 'user', content: pendingSys.map((t) => `<system-reminder>\n${t}\n</system-reminder>`).join('\n') });
  if (sysParts.length) messages.unshift({ role: 'system', content: sysParts.join('\n\n') });
  const out: J = { model, messages, stream: !!req.stream };
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  if (req.stream) out.stream_options = { include_usage: true };
  if (Array.isArray(req.tools) && req.tools.length) {
    const fns = req.tools.filter((t: J) => !t.type || t.type === 'custom' || t.input_schema);
    if (fns.length) {
      out.tools = fns.map((t: J) => ({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } },
      }));
    }
  }
  const tc = req.tool_choice;
  if (tc && out.tools) {
    if (tc.type === 'auto') out.tool_choice = 'auto';
    else if (tc.type === 'any') out.tool_choice = 'required';
    else if (tc.type === 'none') out.tool_choice = 'none';
    else if (tc.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
  }
  return out;
}

function parseArgs(s: J): J {
  if (s === undefined || s === null || s === '') return {};
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

/** OpenAI chat request → Anthropic request (pivot for the OpenAI-compatible endpoint). */
export function openAIToAnthropicRequest(req: J): J {
  if (!Array.isArray(req.messages)) throw new TranslateError('messages is required');
  const system: string[] = [];
  const messages: J[] = [];
  const push = (role: string, bs: J[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...bs);
    else messages.push({ role, content: bs });
  };
  for (const m of req.messages) {
    const c = m.content;
    if (m.role === 'system' || m.role === 'developer') {
      system.push(typeof c === 'string' ? c : (c ?? []).map((p: J) => p.text ?? '').join('\n'));
    } else if (m.role === 'user') {
      const bs: J[] = [];
      if (typeof c === 'string') bs.push({ type: 'text', text: c });
      else
        for (const p of c ?? []) {
          if (p.type === 'text') bs.push({ type: 'text', text: p.text });
          else if (p.type === 'image_url') {
            const url: string = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
            const mm = /^data:([^;]+);base64,(.*)$/s.exec(url ?? '');
            bs.push(mm ? { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } } : { type: 'image', source: { type: 'url', url } });
          } else throw new TranslateError(`unsupported content part "${p.type}"`);
        }
      push('user', bs);
    } else if (m.role === 'assistant') {
      const bs: J[] = [];
      const text = typeof c === 'string' ? c : (c ?? []).map((p: J) => p.text ?? '').join('');
      if (text) bs.push({ type: 'text', text });
      for (const tc of m.tool_calls ?? []) bs.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: parseArgs(tc.function?.arguments) });
      push('assistant', bs.length ? bs : [{ type: 'text', text: '' }]);
    } else if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof c === 'string' ? c : JSON.stringify(c) }]);
    } else throw new TranslateError(`unsupported role "${m.role}"`);
  }
  const out: J = { model: req.model, messages, max_tokens: req.max_tokens ?? req.max_completion_tokens ?? 4096, stream: !!req.stream };
  if (system.length) out.system = system.join('\n\n');
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop) out.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools
      .filter((t: J) => t.type === 'function')
      .map((t: J) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters ?? { type: 'object', properties: {} } }));
  }
  const tc = req.tool_choice;
  if (tc && out.tools) {
    if (tc === 'auto') out.tool_choice = { type: 'auto' };
    else if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc === 'none') out.tool_choice = { type: 'none' };
    else if (tc.type === 'function') out.tool_choice = { type: 'tool', name: tc.function.name };
  }
  return out;
}

// ---------------------------------------------------------------- non-streaming responses

const FINISH_TO_STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };
const STOP_TO_FINISH: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', pause_turn: 'stop', refusal: 'content_filter' };

export function openAIToAnthropicResponse(res: J, model: string): J {
  const choice = res.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content: J[] = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const tc of msg.tool_calls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: parseArgs(tc.function?.arguments) });
  return {
    id: 'msg_' + String(res.id ?? Date.now()).replace(/^chatcmpl-/, ''),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: FINISH_TO_STOP[choice.finish_reason] ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 },
  };
}

export function anthropicToOpenAIResponse(msg: J, model: string): J {
  const text = (msg.content ?? []).filter((b: J) => b.type === 'text').map((b: J) => b.text).join('');
  const calls = (msg.content ?? [])
    .filter((b: J) => b.type === 'tool_use')
    .map((b: J) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const message: J = { role: 'assistant', content: text || (calls.length ? null : '') };
  if (calls.length) message.tool_calls = calls;
  const inTok = msg.usage?.input_tokens ?? 0;
  const outTok = msg.usage?.output_tokens ?? 0;
  return {
    id: 'chatcmpl-' + String(msg.id ?? Date.now()).replace(/^msg_/, ''),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: STOP_TO_FINISH[msg.stop_reason] ?? 'stop' }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
  };
}

// ---------------------------------------------------------------- streaming

export interface AEvent {
  type: string;
  [k: string]: J;
}

/** True for events that carry model output (the "first token" boundary for failover). */
export function isContentEvent(e: AEvent): boolean {
  if (e.type === 'content_block_delta') return true;
  if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') return true;
  return false;
}

/** OpenAI chat.completion.chunk stream → Anthropic stream events. */
export class OpenAIToAnthropicStream {
  private started = false;
  private open: { kind: 'text' | 'tool'; index: number; oaIndex?: number } | null = null;
  private next = 0;
  private tools = new Map<number, number>();
  private finish: string | null = null;
  private usage = { input_tokens: 0, output_tokens: 0 };
  private done = false;

  constructor(private model: string, private id = 'msg_pocket_' + Date.now().toString(36)) {}

  private start(out: AEvent[]) {
    if (this.started) return;
    this.started = true;
    out.push({ type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  private close(out: AEvent[]) {
    if (this.open) out.push({ type: 'content_block_stop', index: this.open.index });
    this.open = null;
  }

  /** Feed one parsed chunk (or the string "[DONE]"). */
  push(chunk: J | '[DONE]'): AEvent[] {
    const out: AEvent[] = [];
    if (chunk === '[DONE]') return this.end();
    this.start(out);
    if (chunk.usage) {
      this.usage.input_tokens = chunk.usage.prompt_tokens ?? this.usage.input_tokens;
      this.usage.output_tokens = chunk.usage.completion_tokens ?? this.usage.output_tokens;
    }
    for (const ch of chunk.choices ?? []) {
      const d = ch.delta ?? {};
      if (typeof d.content === 'string' && d.content !== '') {
        if (!this.open || this.open.kind !== 'text') {
          this.close(out);
          this.open = { kind: 'text', index: this.next++ };
          out.push({ type: 'content_block_start', index: this.open.index, content_block: { type: 'text', text: '' } });
        }
        out.push({ type: 'content_block_delta', index: this.open.index, delta: { type: 'text_delta', text: d.content } });
      }
      for (const tc of d.tool_calls ?? []) {
        const oa = tc.index ?? 0;
        if (!this.tools.has(oa)) {
          this.close(out);
          const index = this.next++;
          this.tools.set(oa, index);
          this.open = { kind: 'tool', index, oaIndex: oa };
          out.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: tc.id ?? `toolu_pocket_${index}`, name: tc.function?.name ?? '', input: {} } });
        }
        const args = tc.function?.arguments;
        if (args) out.push({ type: 'content_block_delta', index: this.tools.get(oa)!, delta: { type: 'input_json_delta', partial_json: args } });
      }
      if (ch.finish_reason) this.finish = ch.finish_reason;
    }
    return out;
  }

  end(): AEvent[] {
    if (this.done) return [];
    this.done = true;
    const out: AEvent[] = [];
    this.start(out);
    this.close(out);
    const stop = FINISH_TO_STOP[this.finish ?? 'stop'] ?? 'end_turn';
    out.push({ type: 'message_delta', delta: { stop_reason: this.tools.size && stop === 'end_turn' ? 'tool_use' : stop, stop_sequence: null }, usage: { input_tokens: this.usage.input_tokens, output_tokens: this.usage.output_tokens } });
    out.push({ type: 'message_stop' });
    return out;
  }

  get tokens() {
    return this.usage;
  }
}

/** Anthropic stream events → OpenAI chunks (for the OpenAI-compatible endpoint). Returns serialisable chunks or "[DONE]". */
export class AnthropicToOpenAIStream {
  private id = 'chatcmpl-pocket-' + Date.now().toString(36);
  private created = Math.floor(Date.now() / 1000);
  private toolIdx = new Map<number, number>();
  private nextTool = 0;
  private inTok = 0;
  private outTok = 0;
  private sentRole = false;

  constructor(private model: string) {}

  private chunk(delta: J, finish: string | null = null): J {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finish }] };
  }

  private role(delta: J): J {
    if (this.sentRole) return delta;
    this.sentRole = true;
    return { role: 'assistant', ...delta };
  }

  push(e: AEvent): (J | '[DONE]')[] {
    switch (e.type) {
      case 'message_start':
        this.inTok = e.message?.usage?.input_tokens ?? 0;
        return [this.chunk(this.role({ content: '' }))];
      case 'content_block_start':
        if (e.content_block?.type === 'tool_use') {
          const i = this.nextTool++;
          this.toolIdx.set(e.index, i);
          return [this.chunk(this.role({ tool_calls: [{ index: i, id: e.content_block.id, type: 'function', function: { name: e.content_block.name, arguments: '' } }] }))];
        }
        return [];
      case 'content_block_delta':
        if (e.delta?.type === 'text_delta') return [this.chunk(this.role({ content: e.delta.text }))];
        if (e.delta?.type === 'input_json_delta') {
          const i = this.toolIdx.get(e.index) ?? 0;
          return [this.chunk({ tool_calls: [{ index: i, function: { arguments: e.delta.partial_json } }] })];
        }
        return [];
      case 'message_delta': {
        this.outTok = e.usage?.output_tokens ?? this.outTok;
        if (e.usage?.input_tokens) this.inTok = e.usage.input_tokens;
        return [this.chunk({}, STOP_TO_FINISH[e.delta?.stop_reason] ?? 'stop')];
      }
      case 'message_stop':
        return [
          { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: { prompt_tokens: this.inTok, completion_tokens: this.outTok, total_tokens: this.inTok + this.outTok } },
          '[DONE]',
        ];
      default:
        return [];
    }
  }
}

/** Shift content block indices by `by` (used to make room for the degraded banner block). */
export function shiftIndex(e: AEvent, by: number): AEvent {
  if (by && typeof e.index === 'number') return { ...e, index: e.index + by };
  return e;
}

export function bannerEvents(text: string): AEvent[] {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
  ];
}

/** Collect a full Anthropic message from its stream events (used for usage accounting). */
export function usageFromEvents(events: AEvent[]): { input: number; output: number } {
  let input = 0;
  let output = 0;
  for (const e of events) {
    if (e.type === 'message_start') input = e.message?.usage?.input_tokens ?? input;
    if (e.type === 'message_delta') {
      output = e.usage?.output_tokens ?? output;
      if (e.usage?.input_tokens) input = e.usage.input_tokens;
    }
  }
  return { input, output };
}
