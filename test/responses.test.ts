import { afterEach, describe, expect, it } from 'vitest';
import { openAIBehaviour, rateLimited, rig, Rig, sseEvents } from './helpers.js';
import { responsesToAnthropicRequest } from '../src/responses.js';

let r: Rig | null = null;
afterEach(async () => {
  await r?.close();
  r = null;
});

function responsesPost(r: Rig, body: object, headers: Record<string, string> = {}) {
  return fetch(`${r.base}/openai/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}`, ...headers },
    body: JSON.stringify(body),
  });
}

// the shape Codex sends (trimmed): instructions, input items, function + custom tools, hosted tools
const SHELL = { type: 'function', name: 'shell', description: 'run a command', strict: false, parameters: { type: 'object', properties: { command: { type: 'array', items: { type: 'string' } } }, required: ['command'] } };
const APPLY_PATCH = { type: 'custom', name: 'apply_patch', description: 'apply a patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: ...' } };
const codexReq = (input: any[], extra: object = {}) => ({
  model: 'gpt-5-codex',
  instructions: 'You are Codex.',
  input,
  tools: [SHELL, APPLY_PATCH, { type: 'web_search' }],
  tool_choice: 'auto',
  parallel_tool_calls: false,
  reasoning: { effort: 'medium', summary: 'auto' },
  store: false,
  stream: true,
  include: ['reasoning.encrypted_content'],
  prompt_cache_key: 'abc',
  ...extra,
});
const userMsg = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

describe('Responses API (Codex)', () => {
  it('translates a Codex request: instructions → system, function + custom tools, hosted tools dropped', () => {
    const a = responsesToAnthropicRequest(
      codexReq([
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'env: linux' }] },
        userMsg('fix the bug'),
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'xxx' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'shell', arguments: '{"command":["ls"]}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'src\ntest' },
        { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_b', name: 'apply_patch', input: '*** Begin Patch' },
        { type: 'custom_tool_call_output', call_id: 'call_b', output: 'Done!' },
      ]),
    );
    expect(a.system).toBe('You are Codex.\n\nenv: linux');
    expect(a.stream).toBe(true);
    expect(a.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'fix the bug' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_a', name: 'shell', input: { command: ['ls'] } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'src\ntest' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_b', name: 'apply_patch', input: { input: '*** Begin Patch' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_b', content: 'Done!' }] },
    ]);
    expect(a.tools.map((t: any) => t.name)).toEqual(['shell', 'apply_patch']);
    expect(a.tools[1].input_schema.required).toEqual(['input']);
    expect(a.tool_choice).toEqual({ type: 'auto' });
  });

  it('namespaced tools (Codex "functions" + MCP namespaces) are flattened for the provider and restored on the way back', async () => {
    const tools = [
      { type: 'namespace', name: 'functions', description: '', tools: [SHELL, APPLY_PATCH] },
      { type: 'namespace', name: 'mcp__github__', description: 'Tools in the mcp__github__ namespace.', tools: [{ type: 'function', name: 'create_issue', description: 'open an issue', strict: false, parameters: { type: 'object', properties: { title: { type: 'string' } } } }] },
      { type: 'tool_search', execution: 'client', description: 'x', parameters: { type: 'object', properties: {} } },
    ];
    const a = responsesToAnthropicRequest(
      codexReq([userMsg('go'), { type: 'function_call', call_id: 'c1', name: 'create_issue', namespace: 'mcp__github__', arguments: '{"title":"t"}' }, { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'ok' }] }], { tools }),
    );
    expect(a.tools.map((t: any) => t.name)).toEqual(['shell', 'apply_patch', 'mcp__github__create_issue']);
    expect(a.messages[1].content[0]).toMatchObject({ type: 'tool_use', id: 'c1', name: 'mcp__github__create_issue' });
    expect(a.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'c1', content: 'ok' });

    r = await rig({ policy: 'order: [groq]\n', groq: openAIBehaviour('unused', { tool: { name: 'mcp__github__create_issue', args: { title: 'bug' } } }) });
    const res = await responsesPost(r, codexReq([userMsg('file a bug')], { tools }));
    const ev = await sseEvents(res);
    const done = ev.find((e) => e.event === 'response.output_item.done')!.data.item;
    expect(done).toMatchObject({ type: 'function_call', name: 'create_issue', namespace: 'mcp__github__', call_id: 'call_1', arguments: '{"title":"bug"}' });

    await r.close();
    r = await rig({ policy: 'order: [groq]\n', groq: openAIBehaviour('unused', { tool: { name: 'apply_patch', args: { input: 'P' } } }) });
    const ev2 = await sseEvents(await responsesPost(r, codexReq([userMsg('patch')], { tools })));
    const done2 = ev2.find((e) => e.event === 'response.output_item.done')!.data.item;
    // the default "functions" namespace means no namespace to Codex
    expect(done2).toEqual({ id: done2.id, type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'apply_patch', input: 'P' });
  });

  it('429 failover, streaming: Codex gets a well-formed event stream ending in response.completed', async () => {
    r = await rig({ paid: rateLimited });
    const res = await responsesPost(r, codexReq([userMsg('hi')]), { 'x-pocket-agent': 'codex' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/event-stream/);
    expect(res.headers.get('x-pocket-provider')).toBe('groq');
    const ev = await sseEvents(res);
    const types = ev.map((e) => e.event);
    expect(types[0]).toBe('response.created');
    expect(types[types.length - 1]).toBe('response.completed');
    for (const e of ev) expect(e.data.type).toBe(e.event);
    // sequence numbers count up from 0
    expect(ev.map((e) => e.data.sequence_number)).toEqual(ev.map((_, i) => i));
    const text = ev.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join('');
    expect(text).toBe('[pocket] running on groq/openai/gpt-oss-120b, anthropic quota exhausted (429)\n\nhello from groq');
    const done = ev.find((e) => e.event === 'response.output_item.done')!.data.item;
    expect(done).toMatchObject({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] });
    const fin = ev[ev.length - 1].data.response;
    expect(fin.status).toBe('completed');
    expect(fin.output).toEqual([done]);
    expect(fin.usage).toMatchObject({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
    // groq got the Codex instructions as a system message and only the function tools
    const sent = r.groq.requests[0].body;
    expect(sent.messages[0]).toEqual({ role: 'system', content: 'You are Codex.' });
    expect(sent.tools.map((t: any) => t.function.name)).toEqual(['shell', 'apply_patch']);
  });

  it('function tool calls stream as function_call items with call_id and full arguments', async () => {
    r = await rig({ policy: 'order: [groq]\n', groq: openAIBehaviour('unused', { tool: { name: 'shell', args: { command: ['ls', '-la'] } } }) });
    const res = await responsesPost(r, codexReq([userMsg('list files')]));
    const ev = await sseEvents(res);
    const added = ev.find((e) => e.event === 'response.output_item.added')!.data.item;
    expect(added).toMatchObject({ type: 'function_call', status: 'in_progress', call_id: 'call_1', name: 'shell' });
    const args = ev.filter((e) => e.event === 'response.function_call_arguments.delta').map((e) => e.data.delta).join('');
    expect(JSON.parse(args)).toEqual({ command: ['ls', '-la'] });
    const done = ev.find((e) => e.event === 'response.output_item.done')!.data.item;
    expect(done).toEqual({ id: added.id, type: 'function_call', status: 'completed', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls","-la"]}' });
    expect(ev[ev.length - 1].event).toBe('response.completed');
    expect(ev[ev.length - 1].data.response.output).toEqual([done]);
  });

  it("Codex's freeform apply_patch comes back as a custom_tool_call with the raw patch text", async () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch';
    r = await rig({ policy: 'order: [groq]\n', groq: openAIBehaviour('unused', { tool: { name: 'apply_patch', args: { input: patch } } }) });
    const res = await responsesPost(r, codexReq([userMsg('add a file')]));
    const ev = await sseEvents(res);
    const done = ev.find((e) => e.event === 'response.output_item.done')!.data.item;
    expect(done).toMatchObject({ type: 'custom_tool_call', status: 'completed', call_id: 'call_1', name: 'apply_patch', input: patch });
    expect(ev.some((e) => e.event === 'response.function_call_arguments.delta')).toBe(false);
  });

  it('second turn: tool output goes back to the provider as a tool message', async () => {
    r = await rig({ policy: 'order: [groq]\n', groq: openAIBehaviour('two files', { tool: { name: 'shell', args: { command: ['ls'] } } }) });
    const res = await responsesPost(
      r,
      codexReq([userMsg('list files'), { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"command":["ls"]}' }, { type: 'function_call_output', call_id: 'call_1', output: 'a\nb' }], { stream: false }),
    );
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two files' }] }] });
    const sent = r.groq.requests[0].body.messages;
    expect(sent.slice(1)).toEqual([
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":["ls"]}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'a\nb' },
    ]);
  });

  it('when nothing can serve, Codex gets a clear JSON error, not a hung stream', async () => {
    r = await rig({ paid: rateLimited, groq: rateLimited });
    const res = await responsesPost(r, codexReq([userMsg('hi')]));
    expect(res.status).toBe(503);
    const body: any = await res.json();
    expect(body.error.message).toMatch(/no provider could serve this request/);
  });
});
