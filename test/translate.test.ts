import { describe, expect, it } from 'vitest';
import {
  AnthropicToOpenAIStream,
  anthropicToOpenAIRequest,
  anthropicToOpenAIResponse,
  hasImages,
  OpenAIToAnthropicStream,
  openAIToAnthropicRequest,
  openAIToAnthropicResponse,
  TranslateError,
} from '../src/translate.js';
import { SseParser, sse } from '../src/sse.js';
import { modelFor, tierOf } from '../src/providers.js';

const toolConversation = {
  model: 'claude-sonnet-4-5',
  max_tokens: 1024,
  system: [{ type: 'text', text: 'You are terse.' }, { type: 'text', text: 'Use tools.' }],
  tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
  tool_choice: { type: 'auto' },
  messages: [
    { role: 'user', content: 'What is in a.txt?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'hello' }] }, { type: 'text', text: 'Summarise it.' }] },
  ],
};

describe('requests: Anthropic → OpenAI', () => {
  it('maps system, text, tool_use and tool_result', () => {
    const o = anthropicToOpenAIRequest(toolConversation, 'llama-3.3-70b');
    expect(o.model).toBe('llama-3.3-70b');
    expect(o.max_tokens).toBe(1024);
    expect(o.messages).toEqual([
      { role: 'system', content: 'You are terse.\n\nUse tools.' },
      { role: 'user', content: 'What is in a.txt?' },
      { role: 'assistant', content: 'Reading.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'hello' },
      { role: 'user', content: 'Summarise it.' },
    ]);
    expect(o.tools[0]).toEqual({ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: toolConversation.tools[0].input_schema } });
    expect(o.tool_choice).toBe('auto');
  });

  it('marks tool errors, maps tool_choice any/tool, stop sequences and streaming usage', () => {
    const o = anthropicToOpenAIRequest(
      {
        ...toolConversation,
        stream: true,
        stop_sequences: ['END'],
        tool_choice: { type: 'tool', name: 'read_file' },
        messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'boom', is_error: true }] }],
      },
      'm',
    );
    expect(o.messages[1]).toEqual({ role: 'tool', tool_call_id: 't', content: 'ERROR: boom' });
    expect(o.tool_choice).toEqual({ type: 'function', function: { name: 'read_file' } });
    expect(o.stop).toEqual(['END']);
    expect(o.stream_options).toEqual({ include_usage: true });
    expect(anthropicToOpenAIRequest({ ...toolConversation, tool_choice: { type: 'any' } }, 'm').tool_choice).toBe('required');
  });

  it('translates images to image_url parts; tool-result images become a text note', () => {
    const req = { model: 'x', max_tokens: 10, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what is this' }] }] };
    expect(hasImages(req)).toBe(true);
    expect(anthropicToOpenAIRequest(req, 'm').messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'text', text: 'what is this' },
    ]);
    const bad = { model: 'x', messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A' } }] }] }] };
    // a screenshot inside a tool result must not block the whole session on text-only providers
    expect(hasImages(bad)).toBe(false);
    expect(anthropicToOpenAIRequest(bad, 'm').messages).toEqual([{ role: 'tool', tool_call_id: 't', content: '[image returned by the tool; this model cannot see images]' }]);
    // unknown block types are skipped instead of failing the turn
    expect(anthropicToOpenAIRequest({ messages: [{ role: 'user', content: [{ type: 'document', source: {} }, { type: 'text', text: 'hi' }] }] }, 'm').messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('drops thinking blocks', () => {
    const o = anthropicToOpenAIRequest({ messages: [{ role: 'user', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'hi' }] }] }, 'm');
    expect(o.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('requests: mid-conversation system turns (Claude Code 2.1+)', () => {
  it('leading system turns join the system prompt; later ones ride with the next user turn after its tool results', () => {
    const out = anthropicToOpenAIRequest(
      {
        system: 'base',
        messages: [
          { role: 'system', content: 'early note' },
          { role: 'user', content: 'list files' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
          { role: 'system', content: [{ type: 'text', text: 'mid note' }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a b' }, { type: 'text', text: 'thanks' }] },
          { role: 'system', content: 'late note' },
        ],
        max_tokens: 100,
      },
      'm',
    );
    expect(out.messages).toEqual([
      { role: 'system', content: 'base\n\nearly note' },
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'a b' },
      { role: 'user', content: '<system-reminder>\nmid note\n</system-reminder>\nthanks' },
      { role: 'user', content: '<system-reminder>\nlate note\n</system-reminder>' },
    ]);
    expect(out.messages.filter((m: any) => m.role === 'system')).toHaveLength(1);
  });
});

describe('requests: OpenAI → Anthropic → OpenAI round trip', () => {
  it('keeps the conversation, tools and images', () => {
    const oa = {
      model: 'gpt-4.1',
      max_tokens: 500,
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"dir":"."}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
      ],
      tools: [{ type: 'function', function: { name: 'ls', description: 'list', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'required',
    };
    const a = openAIToAnthropicRequest(oa);
    expect(a.system).toBe('sys');
    expect(a.messages[0].content[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } });
    expect(a.messages[1].content).toEqual([{ type: 'tool_use', id: 'c1', name: 'ls', input: { dir: '.' } }]);
    expect(a.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a.txt' }] });
    expect(a.tool_choice).toEqual({ type: 'any' });
    const back = anthropicToOpenAIRequest(a, 'gpt-4.1');
    expect(back.messages.slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{"dir":"."}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'a.txt' },
    ]);
    expect(back.tool_choice).toBe('required');
  });

  it('defaults max_tokens (Anthropic requires it)', () => {
    expect(openAIToAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: 'x' }] }).max_tokens).toBe(4096);
  });
});

describe('responses', () => {
  it('OpenAI → Anthropic: text, tool calls, stop reasons, usage', () => {
    const a = openAIToAnthropicResponse(
      { id: 'chatcmpl-9', choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{"x":1}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
      'llama',
    );
    expect(a).toMatchObject({ type: 'message', role: 'assistant', model: 'llama', stop_reason: 'tool_use', usage: { input_tokens: 3, output_tokens: 4 } });
    expect(a.content).toEqual([{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'c', name: 'f', input: { x: 1 } }]);
    expect(openAIToAnthropicResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }, 'm').stop_reason).toBe('max_tokens');
  });

  it('Anthropic → OpenAI', () => {
    const o = anthropicToOpenAIResponse({ id: 'msg_1', content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't', name: 'f', input: { y: 2 } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 2 } }, 'claude');
    expect(o.choices[0]).toEqual({ index: 0, message: { role: 'assistant', content: 'a', tool_calls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{"y":2}' } }] }, finish_reason: 'tool_calls' });
    expect(o.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  });
});

describe('streaming', () => {
  const chunk = (delta: object, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

  it('OpenAI deltas → Anthropic events (text then tool call, usage at the end)', () => {
    const s = new OpenAIToAnthropicStream('llama', 'msg_x');
    const ev = [
      ...s.push(chunk({ role: 'assistant', content: '' })),
      ...s.push(chunk({ content: 'Hel' })),
      ...s.push(chunk({ content: 'lo' })),
      ...s.push(chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'ls', arguments: '{"di' } }] })),
      ...s.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'r":"."}' } }] })),
      ...s.push(chunk({}, 'tool_calls')),
      ...s.push({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } }),
      ...s.push('[DONE]'),
    ];
    expect(ev.map((e) => e.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(ev[5]).toEqual({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'ls', input: {} } });
    const json = ev.filter((e) => e.delta?.type === 'input_json_delta').map((e) => e.delta.partial_json).join('');
    expect(JSON.parse(json)).toEqual({ dir: '.' });
    expect(ev[9]).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 9, output_tokens: 4 } });
  });

  it('Anthropic events → OpenAI chunks, and back again, keep text and tool args', () => {
    const up = new OpenAIToAnthropicStream('m');
    const events = [
      ...up.push(chunk({ content: 'ok ' })),
      ...up.push(chunk({ tool_calls: [{ index: 0, id: 'c9', function: { name: 'run', arguments: '{"cmd":"ls"}' } }] })),
      ...up.push(chunk({}, 'tool_calls')),
      ...up.end(),
    ];
    const down = new AnthropicToOpenAIStream('m');
    const chunks = events.flatMap((e) => down.push(e));
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
    const objs = chunks.filter((c) => c !== '[DONE]') as any[];
    const text = objs.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('ok ');
    const args = objs.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []).map((t: any) => t.function?.arguments ?? '').join('');
    expect(JSON.parse(args)).toEqual({ cmd: 'ls' });
    expect(objs.find((c) => c.choices[0]?.finish_reason)?.choices[0].finish_reason).toBe('tool_calls');
    expect(objs.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])[0]).toMatchObject({ index: 0, id: 'c9', function: { name: 'run' } });
  });

  it('SSE parser handles split chunks, CRLF, comments and multi-line data', () => {
    const p = new SseParser();
    const out = [...p.push('event: a\r\nda'), ...p.push('ta: {"x":1}\r\n\r\n: keepalive\n\ndata: l1\ndata: l2\n\n'), ...p.push('data: tail')];
    out.push(...p.end());
    expect(out).toEqual([{ event: 'a', data: '{"x":1}' }, { event: undefined, data: 'l1\nl2' }, { event: undefined, data: 'tail' }]);
    expect(sse('message_stop', { type: 'message_stop' })).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
});

describe('model mapping', () => {
  it('maps agent model names to tiers', () => {
    expect(tierOf('claude-opus-5-5')).toBe('strong');
    expect(tierOf('claude-sonnet-4-5-20250929')).toBe('mid');
    expect(tierOf('claude-haiku-4-5')).toBe('fast');
    expect(tierOf('gpt-4.1-mini')).toBe('fast');
    expect(tierOf('gpt-5-codex')).toBe('strong');
    expect(tierOf('something-else')).toBe('mid');
  });

  it('passes through native model names and maps the rest', () => {
    const anthropic: any = { passthrough: 'claude-', tiers: { strong: 'A', mid: 'B', fast: 'C' } };
    const groq: any = { tiers: { strong: 'llama-70b', mid: 'llama-70b', fast: 'llama-8b' } };
    expect(modelFor(anthropic, 'claude-opus-5-5').model).toBe('claude-opus-5-5');
    expect(modelFor(anthropic, 'gpt-4.1').model).toBe('A');
    expect(modelFor(groq, 'claude-haiku-4-5')).toEqual({ model: 'llama-8b', tier: 'fast' });
    expect(modelFor(groq, 'unknown-model').model).toBe('llama-70b');
  });
});
