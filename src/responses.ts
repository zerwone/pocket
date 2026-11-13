// OpenAI Responses API (what Codex speaks since it dropped chat/completions) ⇄ pocket's Anthropic pivot.
// Only what a coding agent needs: text, function tools, Codex's freeform "custom" tools (apply_patch),
// tool results, streaming. Hosted tools (web_search, file_search, ...) are dropped, reasoning items
// from earlier turns are skipped: no other provider can read them.

import { AEvent, TranslateError } from './translate.js';

type J = any;

function parseArgs(s: J): J {
  if (s && typeof s === 'object') return s;
  if (typeof s !== 'string' || !s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

function partsText(content: J): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p: J) => (typeof p?.text === 'string' ? p.text : typeof p?.refusal === 'string' ? p.refusal : '')).join('');
}

function outputText(output: J): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return partsText(output);
  if (output && typeof output === 'object' && typeof output.content === 'string') return output.content;
  return output === undefined || output === null ? '' : JSON.stringify(output);
}

// ---------------------------------------------------------------- tools

const DEFAULT_NS = 'functions'; // Codex: same as no namespace

export interface ToolEntry {
  name: string;
  namespace: string | null;
  custom: boolean;
  description: string;
  parameters: J;
}

/** Codex tool list flattened for providers that know no namespaces, keyed by the name the provider sees. */
export type ToolMap = Map<string, ToolEntry>;

/** Provider-safe flat name: Codex's own `{namespace}{name}` form, limited to [A-Za-z0-9_-]{1,64}. */
export function flatName(namespace: string | null, name: string): string {
  const raw = namespace && namespace !== DEFAULT_NS ? `${namespace}${name}` : name;
  let s = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  if (s.length > 64) {
    let h = 0;
    for (const c of raw) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    s = s.slice(0, 55) + '_' + h.toString(36).slice(0, 8);
  }
  return s || 'tool';
}

function addTool(map: ToolMap, t: J, namespace: string | null) {
  if (t?.type === 'function' || t?.type === 'custom') {
    if (!t.name) return;
    const flat = flatName(namespace, t.name);
    map.set(flat, { name: t.name, namespace: namespace && namespace !== DEFAULT_NS ? namespace : null, custom: t.type === 'custom', description: t.description ?? '', parameters: t.parameters });
  } else if (t?.type === 'namespace' && Array.isArray(t.tools)) {
    for (const inner of t.tools) addTool(map, inner, t.name ?? null);
  }
  // web_search, tool_search, file_search, image_generation, local_shell ...: hosted or OpenAI-only, dropped
}

/** Every callable tool in a Responses request: top-level, inside namespaces, and added mid-conversation. */
export function toolMap(req: J): ToolMap {
  const map: ToolMap = new Map();
  for (const t of Array.isArray(req?.tools) ? req.tools : []) addTool(map, t, null);
  for (const it of Array.isArray(req?.input) ? req.input : []) {
    if (it?.type === 'additional_tools' && Array.isArray(it.tools)) for (const t of it.tools) addTool(map, t, null);
  }
  return map;
}

/** Responses API request → Anthropic request. */
export function responsesToAnthropicRequest(req: J): J {
  const tmap = toolMap(req);
  const system: string[] = [];
  if (typeof req.instructions === 'string' && req.instructions) system.push(req.instructions);
  const messages: J[] = [];
  const push = (role: string, bs: J[]) => {
    if (!bs.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...bs);
    else messages.push({ role, content: bs });
  };
  const items: J[] = typeof req.input === 'string' ? [{ type: 'message', role: 'user', content: req.input }] : Array.isArray(req.input) ? req.input : [];
  if (!items.length) throw new TranslateError('input is required');

  for (const it of items) {
    const type = it?.type ?? (it?.role ? 'message' : undefined);
    if (type === 'message') {
      const role = it.role;
      if (role === 'system' || role === 'developer') {
        const t = partsText(it.content);
        if (t) system.push(t);
        continue;
      }
      const bs: J[] = [];
      if (typeof it.content === 'string') bs.push({ type: 'text', text: it.content });
      else
        for (const p of it.content ?? []) {
          if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
            if (p.text) bs.push({ type: 'text', text: p.text });
          } else if (p.type === 'refusal') {
            if (p.refusal) bs.push({ type: 'text', text: p.refusal });
          } else if (p.type === 'input_image') {
            const url: string = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
            if (!url) continue;
            const mm = /^data:([^;]+);base64,(.*)$/s.exec(url);
            bs.push(mm ? { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } } : { type: 'image', source: { type: 'url', url } });
          }
          // input_file and other parts: skipped
        }
      push(role === 'assistant' ? 'assistant' : 'user', bs);
    } else if (type === 'function_call') {
      push('assistant', [{ type: 'tool_use', id: it.call_id, name: flatName(it.namespace ?? null, it.name), input: parseArgs(it.arguments) }]);
    } else if (type === 'custom_tool_call') {
      push('assistant', [{ type: 'tool_use', id: it.call_id, name: flatName(it.namespace ?? null, it.name), input: { input: it.input ?? '' } }]);
    } else if (type === 'local_shell_call') {
      push('assistant', [{ type: 'tool_use', id: it.call_id, name: 'local_shell', input: it.action ?? {} }]);
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
      push('user', [{ type: 'tool_result', tool_use_id: it.call_id, content: outputText(it.output) }]);
    }
    // reasoning, web_search_call, item_reference, ...: skipped
  }
  if (!messages.length) throw new TranslateError('input has no messages pocket can forward');
  // Anthropic needs the conversation to start with a user turn
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });

  const out: J = { model: req.model, messages, max_tokens: req.max_output_tokens ?? 16384, stream: !!req.stream };
  if (system.length) out.system = system.join('\n\n');
  if (req.temperature !== undefined && req.temperature !== null) out.temperature = req.temperature;
  if (req.top_p !== undefined && req.top_p !== null) out.top_p = req.top_p;
  const tools: J[] = [];
  for (const [flat, t] of tmap) {
    if (!t.custom) tools.push({ name: flat, description: t.description, input_schema: t.parameters ?? { type: 'object', properties: {} } });
    else
      tools.push({
        name: flat,
        description: `${t.description}\n\nPut the complete raw text for this tool in the "input" field.`.trim(),
        input_schema: { type: 'object', properties: { input: { type: 'string', description: 'raw text input for the tool' } }, required: ['input'] },
      });
  }
  if (tools.length) {
    out.tools = tools;
    const tc = req.tool_choice;
    if (tc === 'required') out.tool_choice = { type: 'any' };
    else if (tc === 'none') out.tool_choice = { type: 'none' };
    else if (tc && typeof tc === 'object' && (tc.type === 'function' || tc.type === 'custom') && tc.name) out.tool_choice = { type: 'tool', name: flatName(tc.namespace ?? null, tc.name) };
    else out.tool_choice = { type: 'auto' };
  }
  return out;
}

function respId() {
  return 'resp_pocket_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function usageOf(input: number, output: number): J {
  return { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output };
}

/** A provider tool call as the Codex item it stands for: original name and namespace, custom or function. */
function toolItem(id: string, callId: string, flat: string, args: string, tools: ToolMap, status: string): J {
  const t = tools.get(flat);
  const name = t?.name ?? flat;
  const ns = t?.namespace ? { namespace: t.namespace } : {};
  if (t?.custom) {
    const a = parseArgs(args);
    const input = !args ? '' : typeof a.input === 'string' ? a.input : typeof a._raw === 'string' ? a._raw : JSON.stringify(a);
    return { id, type: 'custom_tool_call', status, call_id: callId, name, ...ns, input };
  }
  return { id, type: 'function_call', status, call_id: callId, name, ...ns, arguments: args || '{}' };
}

/** Full Anthropic message → Responses API response object. */
export function anthropicToResponsesResponse(msg: J, model: string, tools: ToolMap = new Map()): J {
  const output: J[] = [];
  let n = 0;
  const text = (msg.content ?? []).filter((b: J) => b.type === 'text').map((b: J) => b.text).join('');
  if (text) output.push({ id: `msg_pocket_${n++}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const b of msg.content ?? []) {
    if (b.type === 'tool_use') output.push(toolItem(`fc_pocket_${n++}`, b.id, b.name, JSON.stringify(b.input ?? {}), tools, 'completed'));
  }
  const inTok = msg.usage?.input_tokens ?? 0;
  const outTok = msg.usage?.output_tokens ?? 0;
  const incomplete = msg.stop_reason === 'max_tokens';
  return {
    id: respId(),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: incomplete ? 'incomplete' : 'completed',
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    error: null,
    model,
    output,
    parallel_tool_calls: true,
    usage: usageOf(inTok, outTok),
  };
}

/** Anthropic stream events → Responses API stream events (as [eventName, payload] pairs). */
export class AnthropicToResponsesStream {
  private id = respId();
  private created = Math.floor(Date.now() / 1000);
  private seq = 0;
  private started = false;
  private finished = false;
  private output: J[] = [];
  private text: { item: J; outIdx: number; buf: string } | null = null;
  private tools = new Map<number, { item: J; outIdx: number; args: string; flat: string }>();
  private inTok = 0;
  private outTok = 0;
  private stop: string | null = null;

  constructor(private model: string, private toolsMap: ToolMap = new Map()) {}

  private ev(type: string, body: J): [string, J] {
    return [type, { type, sequence_number: this.seq++, ...body }];
  }

  private resp(status: string): J {
    return {
      id: this.id,
      object: 'response',
      created_at: this.created,
      status,
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      error: null,
      model: this.model,
      output: status === 'in_progress' ? [] : this.output,
      parallel_tool_calls: true,
      usage: status === 'in_progress' ? null : usageOf(this.inTok, this.outTok),
    };
  }

  private begin(out: [string, J][]) {
    if (this.started) return;
    this.started = true;
    out.push(this.ev('response.created', { response: this.resp('in_progress') }));
    out.push(this.ev('response.in_progress', { response: this.resp('in_progress') }));
  }

  private closeText(out: [string, J][]) {
    if (!this.text) return;
    const { item, outIdx, buf } = this.text;
    const part = { type: 'output_text', text: buf, annotations: [] };
    out.push(this.ev('response.output_text.done', { item_id: item.id, output_index: outIdx, content_index: 0, text: buf }));
    out.push(this.ev('response.content_part.done', { item_id: item.id, output_index: outIdx, content_index: 0, part }));
    const done = { ...item, status: 'completed', content: [part] };
    this.output[outIdx] = done;
    out.push(this.ev('response.output_item.done', { output_index: outIdx, item: done }));
    this.text = null;
  }

  private textDelta(out: [string, J][], delta: string) {
    if (!this.text) {
      const outIdx = this.output.length;
      const item = { id: `msg_pocket_${outIdx}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
      this.output.push(item);
      this.text = { item, outIdx, buf: '' };
      out.push(this.ev('response.output_item.added', { output_index: outIdx, item }));
      out.push(this.ev('response.content_part.added', { item_id: item.id, output_index: outIdx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
    }
    this.text.buf += delta;
    out.push(this.ev('response.output_text.delta', { item_id: this.text.item.id, output_index: this.text.outIdx, content_index: 0, delta }));
  }

  private closeTool(out: [string, J][], index: number) {
    const t = this.tools.get(index);
    if (!t) return;
    this.tools.delete(index);
    const done = toolItem(t.item.id, t.item.call_id, t.flat, t.args, this.toolsMap, 'completed');
    if (done.type === 'function_call') out.push(this.ev('response.function_call_arguments.done', { item_id: done.id, output_index: t.outIdx, arguments: done.arguments }));
    this.output[t.outIdx] = done;
    out.push(this.ev('response.output_item.done', { output_index: t.outIdx, item: done }));
  }

  push(e: AEvent): [string, J][] {
    const out: [string, J][] = [];
    if (this.finished) return out;
    this.begin(out);
    switch (e.type) {
      case 'message_start':
        this.inTok = e.message?.usage?.input_tokens ?? this.inTok;
        break;
      case 'content_block_start':
        if (e.content_block?.type === 'tool_use') {
          this.closeText(out);
          const outIdx = this.output.length;
          const flat = e.content_block.name ?? '';
          const item = toolItem(`fc_pocket_${outIdx}`, e.content_block.id, flat, '', this.toolsMap, 'in_progress');
          this.output.push(item);
          this.tools.set(e.index, { item, outIdx, args: '', flat });
          out.push(this.ev('response.output_item.added', { output_index: outIdx, item }));
        }
        break;
      case 'content_block_delta':
        if (e.delta?.type === 'text_delta' && e.delta.text) this.textDelta(out, e.delta.text);
        else if (e.delta?.type === 'input_json_delta') {
          const t = this.tools.get(e.index);
          if (t && e.delta.partial_json) {
            t.args += e.delta.partial_json;
            if (t.item.type === 'function_call') out.push(this.ev('response.function_call_arguments.delta', { item_id: t.item.id, output_index: t.outIdx, delta: e.delta.partial_json }));
          }
        }
        break;
      case 'content_block_stop':
        if (this.tools.has(e.index)) this.closeTool(out, e.index);
        else this.closeText(out);
        break;
      case 'message_delta':
        this.outTok = e.usage?.output_tokens ?? this.outTok;
        if (e.usage?.input_tokens) this.inTok = e.usage.input_tokens;
        if (e.delta?.stop_reason) this.stop = e.delta.stop_reason;
        break;
      case 'message_stop':
        out.push(...this.finish());
        break;
    }
    return out;
  }

  /** Close everything and emit response.completed (idempotent). */
  finish(): [string, J][] {
    const out: [string, J][] = [];
    if (this.finished) return out;
    this.begin(out);
    this.closeText(out);
    for (const i of [...this.tools.keys()]) this.closeTool(out, i);
    this.finished = true;
    const status = this.stop === 'max_tokens' ? 'incomplete' : 'completed';
    // always response.completed: Codex treats a stream without it as broken; the status inside says incomplete
    out.push(this.ev('response.completed', { response: this.resp(status) }));
    return out;
  }

  /** A failure after output started: tell Codex the turn failed instead of leaving it hanging. */
  fail(message: string): [string, J][] {
    if (this.finished) return [];
    const out: [string, J][] = [];
    this.begin(out);
    this.finished = true;
    out.push(this.ev('response.failed', { response: { ...this.resp('failed'), error: { code: 'server_error', message } } }));
    return out;
  }
}
