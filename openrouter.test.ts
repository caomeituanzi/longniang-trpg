import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptRequest, TOOL_ERROR_PREFIX } from '../server/ai/deepseek';
import { OPENROUTER_BASE_URL, OpenRouterProvider } from '../server/ai/openrouter';
import { AiError, AiRefusal, partialUsageOf, textOf, toolUsesOf, type MessagesRequest } from '../server/ai/types';

// OpenRouter（OpenAI 的 chat completions 格式）：请求和回复的翻译、流式回复、出错和重试、模型列表和价格。不联网，用假的 fetch。

type Sent = { url: string; headers: Record<string, string>; body: any };

/** 假的 fetch：按顺序给出准备好的回复（每个都是现做一个 Response 的函数），记下发出去的请求。 */
function fakeFetch(replies: (() => Response)[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    const next = replies.shift();
    if (!next) throw new Error('测试没准备更多回复');
    return next();
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const usage = () => ({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.001 });

/** 普通回复。extra 覆盖整条回复的字段（id、model、usage……）。 */
function completion(message: Record<string, unknown>, finish: string | null = 'stop', extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return () =>
    Response.json(
      {
        id: 'gen-1',
        object: 'chat.completion',
        created: 1,
        model: 'openai/gpt-5.2',
        choices: [{ index: 0, message: { role: 'assistant', content: null, ...message }, finish_reason: finish, native_finish_reason: finish }],
        usage: usage(),
        ...extra,
      },
      { headers },
    );
}

const errorReply = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) => () => Response.json({ error }, { status, headers });

/** 流式回复的正文：对象是一段 data，字符串原样（注释行、data: [DONE]）。 */
const sse = (events: (Record<string, unknown> | string)[]) => events.map((e) => (typeof e === 'string' ? `${e}\n\n` : `data: ${JSON.stringify(e)}\n\n`)).join('');
const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => ({
  id: 'gen-s',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'openai/gpt-5.2',
  choices: [{ index: 0, delta, finish_reason: finish, native_finish_reason: finish }],
  ...extra,
});

/** 流式回复。pieceBytes：把正文切成这么多字节一段送过来（会切断中文字和事件）。 */
function stream(body: string, headers: Record<string, string> = {}, pieceBytes = 0) {
  return () => {
    const bytes = new TextEncoder().encode(body);
    const size = pieceBytes || bytes.length || 1;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      },
    });
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', ...headers } });
  };
}

const noWait = async () => {};
const base: MessagesRequest = { model: 'openai/gpt-5.2', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] };

test('OpenRouter：请求翻译成 chat completions：system 合成一条，工具调用和结果对得上，不发思考和缓存标记', async () => {
  const { fetchImpl, sent } = fakeFetch([completion({ content: '好' })]);
  const provider = new OpenRouterProvider({ apiKey: 'sk-or-test', fetchImpl });
  assert.equal(provider.name, 'openrouter');
  assert.equal(provider.priced, true);
  assert.deepEqual(provider.status, { ready: true, message: null });
  const schema = { type: 'object', properties: { modifier: { type: 'integer' } } };
  await provider.send({
    model: 'anthropic/claude-sonnet-5.5',
    max_tokens: 16000,
    system: [
      { type: 'text', text: '主持规则', cache_control: { type: 'ephemeral', ttl: '1h' } },
      { type: 'text', text: '剧本', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    tools: [{ name: 'roll_check', description: '掷骰检定', input_schema: schema }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '结算这个行动' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先想一想', signature: 'sig' },
          { type: 'redacted_thinking', data: 'xxx' },
          { type: 'text', text: '先掷骰。' },
          { type: 'tool_use', id: 'call_1', name: 'roll_check', input: { modifier: 1 } },
          { type: 'tool_use', id: 'call_2', name: 'give_clue', input: { clue: 'key' } },
          { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          // 文字写在工具结果前面也一样：翻译以后工具结果要紧跟着调用
          { type: 'text', text: '请写出这次行动的叙述正文。' },
          { type: 'tool_result', tool_use_id: 'call_1', content: '{"total":9}' },
          { type: 'tool_result', tool_use_id: 'call_2', content: '没有这个线索', is_error: true, cache_control: { type: 'ephemeral' } },
        ],
      },
      // 只有思考的 assistant 消息：什么都不剩，不发
      { role: 'assistant', content: [{ type: 'thinking', thinking: '再想想', signature: 'sig2' }] },
      { role: 'user', content: '继续' },
    ],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    metadata: { user_id: 'anon-123' },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `${OPENROUTER_BASE_URL}/chat/completions`);
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-or-test');
  const body = sent[0].body;
  assert.equal(body.model, 'anthropic/claude-sonnet-5.5');
  assert.equal(body.max_tokens, 16000);
  assert.equal(body.user, 'anon-123', '玩家的匿名编号');
  assert.deepEqual(body.messages, [
    { role: 'system', content: '主持规则\n\n剧本' },
    { role: 'user', content: '结算这个行动' },
    {
      role: 'assistant',
      content: '先掷骰。',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'roll_check', arguments: '{"modifier":1}' } },
        { id: 'call_2', type: 'function', function: { name: 'give_clue', arguments: '{"clue":"key"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"total":9}' },
    { role: 'tool', tool_call_id: 'call_2', content: `${TOOL_ERROR_PREFIX}没有这个线索` },
    { role: 'user', content: '请写出这次行动的叙述正文。' },
    { role: 'user', content: '继续' },
  ]);
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'roll_check', description: '掷骰检定', parameters: schema } }]);
  // 思考、思考强度、缓存标记、Claude 专用的字段都不发；不要求 JSON、不是流式时也没有对应的字段
  const raw = JSON.stringify(body);
  for (const word of ['cache_control', 'thinking', 'signature', 'redacted', 'reasoning', 'effort', 'output_config', 'metadata', 'server_tool_use', 'response_format', 'stream']) {
    assert.ok(!raw.includes(word), `不该有 ${word}`);
  }
  assert.ok(!raw.includes('先想一想') && !raw.includes('再想想'));
});

test('OpenRouter：结构化输出和 DeepSeek 一样写进提示、打开 JSON 模式；回复里只取 JSON，取不出来原样返回', async () => {
  const { fetchImpl, sent } = fakeFetch([
    completion({ content: '好的，结果如下：\n```json\n{"minutes": 15, "reason": "走过去", "kind": "action"}\n```' }),
    completion({ content: '这个算不出来' }),
    completion({ content: '{"minutes": 5}' }),
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
  const schema = { type: 'object', properties: { minutes: { type: 'integer' } }, required: ['minutes'] };
  const request: MessagesRequest = {
    ...base,
    messages: [{ role: 'user', content: '估一下要多久' }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  };
  const res = await provider.send(request);
  assert.deepEqual(JSON.parse(textOf(res)), { minutes: 15, reason: '走过去', kind: 'action' }, '代码块和前后的话去掉了');
  const body = sent[0].body;
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.ok(!JSON.stringify(body).includes('json_schema'), '不发 json_schema');
  // 格式要求和 DeepSeek 的一字不差
  const last = body.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.equal(last.content, adaptRequest(request).body.messages.at(-1)!.content);
  assert.match(last.content, /^估一下要多久\n\n# 输出格式\n只输出一个 JSON 对象/);
  assert.ok(last.content.includes(JSON.stringify(schema)));

  assert.equal(textOf(await provider.send(request)), '这个算不出来', '取不出 JSON：原样返回');

  // 最后一条用户消息只有工具结果：格式要求跟在工具结果后面，成为一条新的用户消息
  await provider.send({
    ...request,
    messages: [
      { role: 'user', content: '开始' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'look', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
    ],
  });
  const messages = sent[2].body.messages;
  assert.deepEqual(
    messages.map((m: { role: string }) => m.role),
    ['user', 'assistant', 'tool', 'user'],
  );
  assert.equal(messages[1].content, null, '只有工具调用的 assistant 消息 content 是 null');
  assert.match(messages[3].content, /^# 输出格式\n/);
});

test('OpenRouter：回复翻译回 Claude 格式：文字、工具调用、停止原因、用量和花费', async () => {
  const { fetchImpl } = fakeFetch([
    completion(
      { content: '我来掷骰。', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'roll_check', arguments: '{"modifier":2}' } }] },
      'tool_calls',
      {
        id: 'gen-abc',
        model: 'openai/gpt-5.2-20251211',
        usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 600 }, cost: 0.0123 },
      },
      { 'x-generation-id': 'gen-abc' },
    ),
    completion({ content: '写到一半' }, 'length'),
    completion({ content: '' }, 'content_filter'),
    completion({ refusal: '我不能帮你做这个。' }, 'stop'),
    completion({ content: '完' }, 'stop', { usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.05, is_byok: true, cost_details: { upstream_inference_cost: 1 } } }),
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
  const res = await provider.send(base);
  assert.equal(res.type, 'message');
  assert.equal(res.role, 'assistant');
  assert.equal(res.id, 'gen-abc');
  assert.equal(res.model, 'openai/gpt-5.2-20251211');
  assert.equal(res.request_id, 'gen-abc');
  assert.equal(res.stop_reason, 'tool_use');
  assert.deepEqual(res.content, [
    { type: 'text', text: '我来掷骰。' },
    { type: 'tool_use', id: 'call_9', name: 'roll_check', input: { modifier: 2 } },
  ]);
  // 输入用量不算读缓存的部分；花费直接用 OpenRouter 报的
  assert.deepEqual(res.usage, { input_tokens: 400, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, cost_usd: 0.0123 });
  assert.equal(res.wasted_usage, undefined);

  const truncated = await provider.send(base);
  assert.equal(truncated.stop_reason, 'max_tokens');
  assert.equal(truncated.request_id, 'gen-1', '没有 X-Generation-Id 时用回复的 id');
  const filtered = await provider.send(base);
  assert.equal(filtered.stop_reason, 'refusal');
  assert.equal(filtered.stop_details?.category, 'openrouter:content_filter', '别家的拒绝带上前缀，不自动封号');
  assert.deepEqual(filtered.content, []);
  const refused = await provider.send(base);
  assert.equal(refused.stop_reason, 'refusal');
  assert.equal(refused.stop_details?.explanation, '我不能帮你做这个。');
  // 用自己的服务商密钥（BYOK）：OpenRouter 的手续费加上服务商那边收的
  const byok = await provider.send(base);
  assert.equal(byok.stop_reason, 'end_turn');
  assert.equal(textOf(byok), '完');
  assert.equal(byok.usage.cost_usd, 1.05);
});

test('OpenRouter：工具参数不是完整的 JSON 就重新要，那次的用量也记上；写到上限被截断的不重来', async () => {
  const bad = completion({ tool_calls: [{ id: 'c1', type: 'function', function: { name: 'roll_check', arguments: '{"modifier":' } }] }, 'tool_calls');
  const good = completion({ tool_calls: [{ id: 'c2', type: 'function', function: { name: 'roll_check', arguments: '{"modifier":1}' } }] }, 'tool_calls');
  let { fetchImpl, sent } = fakeFetch([bad, good]);
  const res = await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait }).send(base);
  assert.equal(sent.length, 2);
  assert.deepEqual(
    toolUsesOf(res).map((u) => u.input),
    [{ modifier: 1 }],
  );
  assert.equal(res.wasted_usage?.input_tokens, 100);
  assert.equal(res.wasted_usage?.output_tokens, 20);
  assert.equal(res.wasted_usage?.cost_usd, 0.001, '花掉的美元也记上');

  // 不能再重试了：报可以重试的错，带着那次的用量
  ({ fetchImpl, sent } = fakeFetch([bad]));
  const err = await new OpenRouterProvider({ apiKey: 'k', fetchImpl, maxRetries: 0 }).send(base).catch((e) => e);
  assert.ok(err instanceof AiError && err.retryable);
  assert.match(err.message, /工具参数/);
  assert.equal(partialUsageOf(err)?.output_tokens, 20);

  // 写到 max_tokens 被截断：没写完的工具调用去掉，交给调用的地方按 max_tokens 处理
  ({ fetchImpl, sent } = fakeFetch([completion({ content: '我', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'roll_check', arguments: '{"mod' } }] }, 'length')]));
  const cut = await new OpenRouterProvider({ apiKey: 'k', fetchImpl }).send(base);
  assert.equal(sent.length, 1);
  assert.equal(cut.stop_reason, 'max_tokens');
  assert.deepEqual(toolUsesOf(cut), []);
});

const fullStream = sse([
  ': OPENROUTER PROCESSING',
  chunk({ role: 'assistant', content: '' }),
  chunk({ reasoning: '先想想' }),
  chunk({ content: '门开了，' }),
  chunk({ content: '大堂里空无一人。' }),
  ': OPENROUTER PROCESSING',
  chunk({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'roll_check', arguments: '' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"modi' } }] }),
  chunk({
    tool_calls: [
      { index: 0, function: { arguments: 'fier":' } },
      { index: 1, id: 'call_b', type: 'function', function: { name: 'give_clue', arguments: '{"clue":"key"}' } },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '3}' } }] }),
  chunk({}, 'tool_calls'),
  // OpenRouter 最后一段带着用量
  chunk({ content: '' }, 'tool_calls', { usage: { prompt_tokens: 200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 50 }, cost: 0.002 } }),
  'data: [DONE]',
]);

test('OpenRouter：流式回复拼成整条消息：文字、分好几段来的工具参数、最后的用量和花费；注释行不管；边写边报进度', async () => {
  const { fetchImpl, sent } = fakeFetch([stream(fullStream, { 'x-generation-id': 'gen-s' }, 7), stream(fullStream.replace(/\n/g, '\r\n'))]);
  const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
  const progress: number[] = [];
  const res = await provider.send({ ...base, stream: true }, undefined, { onProgress: (n) => progress.push(n) });
  assert.equal(sent[0].body.stream, true);
  assert.equal(sent[0].body.stream_options, undefined, 'OpenRouter 的流式回复总会带用量，不用另外要');
  assert.equal(res.stop_reason, 'tool_use');
  assert.equal(res.request_id, 'gen-s');
  assert.deepEqual(res.content, [
    { type: 'text', text: '门开了，大堂里空无一人。' },
    { type: 'tool_use', id: 'call_a', name: 'roll_check', input: { modifier: 3 } },
    { type: 'tool_use', id: 'call_b', name: 'give_clue', input: { clue: 'key' } },
  ]);
  assert.deepEqual(res.usage, { input_tokens: 150, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 50, cost_usd: 0.002 });
  // 推理、正文、工具参数的字数都算进度
  assert.equal(progress.at(-1), [...'先想想门开了，大堂里空无一人。'].length + '{"modifier":3}'.length + '{"clue":"key"}'.length);
  assert.ok(progress.every((n, i) => i === 0 || n > progress[i - 1]));

  // 换行是 \r\n 的也一样
  const crlf = await provider.send({ ...base, stream: true });
  assert.deepEqual(crlf.content, res.content);
  assert.deepEqual(crlf.usage, res.usage);

  // 进度回调出错：照样读完，不重新要
  const again = fakeFetch([stream(fullStream)]);
  const hooked = await new OpenRouterProvider({ apiKey: 'k', fetchImpl: again.fetchImpl }).send({ ...base, stream: true }, undefined, {
    onProgress: () => {
      throw new Error('推送失败');
    },
  });
  assert.equal(hooked.stop_reason, 'tool_use');
  assert.equal(again.sent.length, 1);
});

test('OpenRouter：流式回复中途断开：重新要一次，断开那次估一个用量；再断就报错，带着估算的用量', async () => {
  const full = sse([chunk({ role: 'assistant', content: '' }), chunk({ content: '门开了。' }), chunk({}, 'stop', { usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.003 } }), 'data: [DONE]']);
  const cut = sse([chunk({ role: 'assistant', content: '' }), chunk({ content: '门开了，大堂' })]);
  let { fetchImpl, sent } = fakeFetch([stream(cut), stream(full)]);
  const res = await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait }).send({ ...base, stream: true });
  assert.equal(sent.length, 2);
  assert.equal(textOf(res), '门开了。');
  assert.equal(res.usage.cost_usd, 0.003);
  assert.ok(res.wasted_usage, '断开的那次也记上了');
  assert.equal(res.wasted_usage.output_tokens, 6, '按收到的字数估：“门开了，大堂”六个字');
  assert.ok(res.wasted_usage.input_tokens > 0, '提示按发出去的请求估');
  assert.equal(res.wasted_usage.cost_usd, undefined, '不知道这个模型的价格：不估美元');

  // 再断：不再要第三次，错误上带着两次估算的用量
  ({ fetchImpl, sent } = fakeFetch([stream(cut), stream(cut), stream(full)]));
  const err = await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait }).send({ ...base, stream: true }).catch((e) => e);
  assert.ok(err instanceof AiError && err.retryable);
  assert.match(err.message, /中途断开/);
  assert.equal(sent.length, 2);
  assert.equal(partialUsageOf(err)?.output_tokens, 12);

  // 收到 [DONE] 却没有 finish_reason：也是没写完
  ({ fetchImpl, sent } = fakeFetch([stream(cut + 'data: [DONE]\n\n'), stream(full)]));
  assert.equal(textOf(await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait }).send({ ...base, stream: true })), '门开了。');
  assert.equal(sent.length, 2);
});

test('OpenRouter：流式回复中途报错：服务商断了就重新要，请求本身有问题就不重试', async () => {
  const full = sse([chunk({ content: '好。' }, 'stop', { usage: usage() }), 'data: [DONE]']);
  const failed = (code: number | string, message: string) =>
    sse([
      chunk({ content: '写了一半' }),
      {
        id: 'gen-e',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'openai/gpt-5.2',
        provider: 'OpenAI',
        error: { code, message },
        choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
      },
    ]);
  let { fetchImpl, sent } = fakeFetch([stream(failed(502, 'Provider disconnected unexpectedly')), stream(full)]);
  const res = await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait }).send({ ...base, stream: true });
  assert.equal(textOf(res), '好。');
  assert.equal(sent.length, 2);
  assert.ok(res.wasted_usage && res.wasted_usage.output_tokens > 0, '报错前写出来的部分也记上');

  ({ fetchImpl, sent } = fakeFetch([stream(failed('server_error', 'Provider disconnected unexpectedly')), stream(full)]));
  assert.equal(textOf(await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait }).send({ ...base, stream: true })), '好。');
  assert.equal(sent.length, 2, 'code 不是数字的也当成服务商那边断了');

  ({ fetchImpl, sent } = fakeFetch([stream(failed(400, 'Invalid tool schema')), stream(full)]));
  await assert.rejects(
    new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait }).send({ ...base, stream: true }),
    (err: unknown) => err instanceof AiError && !err.retryable && err.message.includes('Invalid tool schema'),
  );
  assert.equal(sent.length, 1);
});

test('OpenRouter：出错时给出中文说明：密钥不对说清楚改哪一项；余额不够、请求有问题不重试；内容被审核拦下算被拒绝', async () => {
  const once = async (reply: () => Response) => {
    const { fetchImpl, sent } = fakeFetch([reply, completion({ content: '不该到这里' })]);
    const err = await new OpenRouterProvider({ apiKey: 'sk-wrong', fetchImpl, sleep: noWait }).send(base).catch((e) => e);
    assert.equal(sent.length, 1, '不重试');
    assert.ok(err instanceof AiError);
    assert.equal(err.retryable, false);
    return err;
  };
  const unauthorized = await once(errorReply(401, { code: 401, message: 'No auth credentials found' }));
  assert.match(unauthorized.message, /OpenRouter 的 API 密钥不对，请检查 \.env 文件里的 OPENROUTER_API_KEY/);
  assert.ok(!unauthorized.message.includes('sk-wrong'), '不把密钥写进错误');
  assert.equal(unauthorized.status, 401);

  assert.match((await once(errorReply(402, { code: 402, message: 'Insufficient credits' }))).message, /余额不够/);

  const invalid = await once(errorReply(400, { code: 400, message: 'openai/gpt-9 is not a valid model ID' }));
  assert.match(invalid.message, /openai\/gpt-9 is not a valid model ID/, '带上接口说的原因');
  assert.equal(invalid.status, 400);
  assert.match((await once(errorReply(404, { code: 404, message: 'No endpoints found that support tool use' }))).message, /找不到这个模型.*No endpoints found/);

  const flagged = await once(
    errorReply(403, {
      code: 403,
      message: 'Input was flagged',
      metadata: { reasons: ['violence'], flagged_input: '……', provider_name: 'OpenAI', model_slug: 'openai/gpt-5.2' },
    }),
  );
  assert.ok(flagged instanceof AiRefusal, '内容被审核拦下：按被拒绝处理');
  assert.equal(flagged.category, 'openrouter:moderation');
  assert.match(flagged.message, /内容审核拦下了（violence）/);
  const declined = await once(errorReply(403, { code: 403, message: 'The model declined', metadata: { error_type: 'refusal', provider_name: 'Anthropic' } }));
  assert.ok(declined instanceof AiRefusal);
  assert.equal(declined.category, 'openrouter:refusal');

  const forbidden = await once(errorReply(403, { code: 403, message: 'Key not allowed for this model', metadata: { error_type: 'permission_denied' } }));
  assert.ok(!(forbidden instanceof AiRefusal), '没有权限不是玩家的问题，不算被拒绝');
  assert.match(forbidden.message, /没有权限/);
});

test('OpenRouter：限流按 Retry-After 等了再试；一直忙、一直断网就报可以重试的错；200 的回复里写着错误也重试；等的时候取消马上停', async () => {
  const waits: number[] = [];
  let { fetchImpl, sent } = fakeFetch([errorReply(429, { code: 429, message: 'Rate limit exceeded' }, { 'retry-after': '2' }), completion({ content: '好' })]);
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  assert.equal(textOf(await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep }).send(base)), '好');
  assert.equal(sent.length, 2);
  assert.deepEqual(waits, [2000]);

  // 余额暂时不够（同时在进行的请求太多）：带着 Retry-After，等一会儿就好
  ({ fetchImpl, sent } = fakeFetch([
    errorReply(402, { code: 402, message: 'Insufficient credits for in-flight requests', metadata: { limit_source: 'openrouter_in_flight_budget' } }, { 'retry-after': '1' }),
    completion({ content: '好' }),
  ]));
  assert.equal(textOf(await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep }).send(base)), '好');
  assert.equal(sent.length, 2);

  ({ fetchImpl, sent } = fakeFetch([0, 1, 2].map(() => errorReply(503, { code: 503, message: 'No available providers' }))));
  const busy = await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait, maxRetries: 2 }).send(base).catch((e) => e);
  assert.ok(busy instanceof AiError && busy.retryable);
  assert.equal(busy.status, 503);
  assert.match(busy.message, /过一会儿会自动重试/);
  assert.equal(sent.length, 3);

  let calls = 0;
  const offline = new OpenRouterProvider({
    apiKey: 'k',
    maxRetries: 1,
    sleep: noWait,
    fetchImpl: (async () => {
      calls++;
      throw new TypeError('fetch failed');
    }) as typeof fetch,
  });
  await assert.rejects(offline.send(base), (err: unknown) => err instanceof AiError && err.retryable && /连不上 OpenRouter 的服务器/.test(err.message));
  assert.equal(calls, 2);

  // 已经回了 200 以后才出的错：整条回复只有 error
  ({ fetchImpl, sent } = fakeFetch([() => Response.json({ id: 'gen-x', error: { code: 502, message: 'Provider returned error' } }), completion({ content: '好' })]));
  assert.equal(textOf(await new OpenRouterProvider({ apiKey: 'k', fetchImpl, sleep: noWait }).send(base)), '好');
  assert.equal(sent.length, 2);

  // 等着重试的时候取消：不用等到重试时间
  const stuck = new OpenRouterProvider({
    apiKey: 'k',
    fetchImpl: (async () => errorReply(429, { code: 429, message: 'slow down' })()) as typeof fetch,
    sleep: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const pending = stuck.send(base, controller.signal);
  setTimeout(() => controller.abort(new Error('取消了')), 10);
  await assert.rejects(pending, /取消了/);
});

test('OpenRouter：模型列表的价格换成每百万 token 的美元，缓存一小时；没报花费时按缓存的价格算', async () => {
  const page1 = {
    data: [
      {
        id: 'openai/gpt-5.2',
        name: 'OpenAI: GPT-5.2',
        context_length: 400000,
        pricing: { prompt: '0.00000175', completion: '0.000014', input_cache_read: '0.000000175', request: '0' },
      },
      { id: 'openrouter/auto', name: 'Auto Router', context_length: 2000000, pricing: { prompt: '-1', completion: '-1' } },
      { id: 'meta/some-model:free', name: 'Some Model (free)', context_length: 131072, pricing: { prompt: '0', completion: '0' } },
      { id: 'no/pricing', name: '' },
    ],
    links: { next: '/api/v1/models?offset=4' },
    total_count: 5,
  };
  const page2 = {
    data: [
      {
        id: 'anthropic/claude-x',
        name: 'Anthropic: Claude X',
        context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003', input_cache_write: '0.00000375' },
      },
    ],
    links: { next: null },
    total_count: 5,
  };
  const noCost = (extra: Record<string, unknown> = {}) =>
    completion({ content: '好' }, 'stop', { usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000, prompt_tokens_details: { cached_tokens: 400_000 }, ...extra } });
  const cut = sse([chunk({ content: '门开了，大堂' })]);
  const full = sse([chunk({ content: '好' }, 'stop', { usage: usage() }), 'data: [DONE]']);
  const { fetchImpl, sent } = fakeFetch([
    () => Response.json(page1),
    () => Response.json(page2),
    () => Response.json(page1),
    () => Response.json(page2),
    noCost(),
    noCost(),
    stream(cut),
    stream(full),
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'sk-or', fetchImpl, sleep: noWait });
  assert.equal(provider.priceOf('openai/gpt-5.2'), null, '还没取过列表');

  const models = await provider.listModels();
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/models');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-or');
  assert.equal(sent[1].url, 'https://openrouter.ai/api/v1/models?offset=4', '列表分页：跟着 links.next 取下一页');
  assert.equal(sent[1].headers.authorization, 'Bearer sk-or');
  assert.deepEqual(models, [
    { id: 'openai/gpt-5.2', name: 'OpenAI: GPT-5.2', contextLength: 400000, price: { input: 1.75, output: 14, cacheRead: 0.175 } },
    { id: 'openrouter/auto', name: 'Auto Router', contextLength: 2000000, price: null },
    { id: 'meta/some-model:free', name: 'Some Model (free)', contextLength: 131072, price: { input: 0, output: 0, cacheRead: null } },
    { id: 'no/pricing', name: 'no/pricing', contextLength: null, price: null },
    { id: 'anthropic/claude-x', name: 'Anthropic: Claude X', contextLength: 200000, price: { input: 3, output: 15, cacheRead: 0.3 } },
  ]);

  // 一小时内不重新取；force 时重新取
  assert.equal(await provider.listModels(), models);
  assert.equal(sent.length, 2);
  await provider.listModels(true);
  assert.equal(sent.length, 4);
  assert.deepEqual(provider.priceOf('openai/gpt-5.2'), { input: 1.75, output: 14, cacheRead: 0.175 });
  assert.equal(provider.priceOf('openrouter/auto'), null);
  assert.equal(provider.priceOf('unknown/model'), null);

  // 回复里没报花费：按缓存的价格算（读缓存的部分按读缓存的价格）
  const priced = await provider.send({ ...base, model: 'openai/gpt-5.2' });
  assert.equal(priced.usage.input_tokens, 600_000);
  // 60 万输入 × 1.75 + 40 万读缓存 × 0.175 + 10 万输出 × 14（每百万 token）
  assert.equal(Math.round(priced.usage.cost_usd! * 1e6) / 1e6, 2.52);
  // 不知道价格的模型：不填，记账时再按价格表算
  assert.equal((await provider.send({ ...base, model: 'unknown/model' })).usage.cost_usd, undefined);
  // 中途断开那次的估算用量也按价格算美元
  const resumed = await provider.send({ ...base, model: 'openai/gpt-5.2', stream: true });
  assert.ok((resumed.wasted_usage?.cost_usd ?? 0) > 0);
  assert.equal(resumed.usage.cost_usd, 0.001, '报了花费的用报的');
});

test('OpenRouter：没设置密钥时用不了，说清楚是 .env 的哪一项', async () => {
  const none = new OpenRouterProvider({ apiKey: undefined });
  assert.equal(none.status.ready, false);
  assert.equal(none.status.message, '还没有设置 OpenRouter 的 API 密钥（项目文件夹里 .env 文件的 OPENROUTER_API_KEY），OpenRouter 的模型暂时用不了。');
  await assert.rejects(none.send(base), (err: unknown) => err instanceof AiError && !err.retryable && /OPENROUTER_API_KEY/.test(err.message));
  await assert.rejects(none.listModels(), /OPENROUTER_API_KEY/);
  const other = new OpenRouterProvider({ apiKey: '', label: 'OpenAI', keyName: 'OPENAI_API_KEY' });
  assert.match(other.status.message!, /还没有设置 OpenAI 的 API 密钥（项目文件夹里 \.env 文件的 OPENAI_API_KEY）/);
});

test('OpenRouter：调用工具时回复里的推理记录（reasoning_details）下一轮原样传回去', async () => {
  const details = [{ type: 'reasoning.encrypted', data: 'c2lnbmF0dXJl', id: 'tool_c1', format: 'google-gemini-v1', index: 0 }];
  const { fetchImpl, sent } = fakeFetch([
    completion({ reasoning: '先看看', reasoning_details: details, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }] }, 'tool_calls'),
    completion({ content: '你看到一扇门。', reasoning: '写叙述', reasoning_details: details }),
  ]);
  const provider = new OpenRouterProvider({ apiKey: 'k', fetchImpl });
  const request: MessagesRequest = { ...base, model: 'google/gemini-3-pro-preview', messages: [{ role: 'user', content: '看看四周' }] };
  const first = await provider.send(request);
  assert.deepEqual(
    first.content.map((b) => b.type),
    ['openrouter_reasoning', 'tool_use'],
  );
  assert.equal(textOf(first), '', '推理的内容不算回复的文字');
  const second = await provider.send({
    ...request,
    messages: [...request.messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: '一扇门' }] }],
  });
  assert.deepEqual(sent[1].body.messages[1], {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }],
    reasoning_details: details,
  });
  assert.deepEqual(
    second.content.map((b) => b.type),
    ['text'],
    '没调用工具时不带推理记录',
  );
});

test('OpenRouter：换成别家 OpenAI 兼容的接口时，不发 OpenRouter 才认的字段', async () => {
  const history: MessagesRequest['messages'] = [
    { role: 'user', content: '开始' },
    {
      role: 'assistant',
      content: [
        { type: 'openrouter_reasoning', reasoning_details: [{ type: 'reasoning.text', text: '想', index: 0 }] },
        { type: 'tool_use', id: 'c1', name: 'look', input: {} },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }] },
  ];
  const request: MessagesRequest = { ...base, messages: history, stream: true, metadata: { user_id: 'anon-9' } };
  // OpenAI 的流式回复：用量在最后一段，choices 是空的
  const done = sse([
    chunk({ content: '好' }, 'stop'),
    { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5.2', choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } } },
    'data: [DONE]',
  ]);

  // OpenAI 自己：max_completion_tokens、safety_identifier、要用量的 stream_options；没有 user 和推理记录
  let { fetchImpl, sent } = fakeFetch([stream(done, { 'x-request-id': 'req_openai' })]);
  const openai = new OpenRouterProvider({ apiKey: 'sk-openai', baseUrl: 'https://api.openai.com/v1/', label: 'OpenAI', keyName: 'OPENAI_API_KEY', fetchImpl });
  const res = await openai.send(request);
  assert.equal(textOf(res), '好');
  assert.equal(res.request_id, 'req_openai');
  assert.deepEqual(res.usage, { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, '没报花费、也不知道价格：不填美元');
  let body = sent[0].body;
  assert.equal(sent[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sent[0].headers.authorization, 'Bearer sk-openai');
  assert.equal(body.max_completion_tokens, 100);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.safety_identifier, 'anon-9');
  assert.equal(body.user, undefined);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.ok(!JSON.stringify(body).includes('reasoning'));
  assert.deepEqual(body.messages[1], { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'look', arguments: '{}' } }] });

  // 别家兼容的接口（本机的服务之类）：只发标准字段
  ({ fetchImpl, sent } = fakeFetch([stream(done)]));
  await new OpenRouterProvider({ apiKey: 'k', baseUrl: 'http://localhost:8000/v1', fetchImpl }).send(request);
  body = sent[0].body;
  assert.equal(sent[0].url, 'http://localhost:8000/v1/chat/completions');
  assert.equal(body.max_tokens, 100);
  assert.equal(body.user, undefined);
  assert.equal(body.safety_identifier, undefined);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.ok(!JSON.stringify(body).includes('reasoning'));

  // OpenRouter：带上 user 和推理记录，不发已经废弃的 stream_options
  ({ fetchImpl, sent } = fakeFetch([stream(done)]));
  await new OpenRouterProvider({ apiKey: 'k', fetchImpl }).send(request);
  body = sent[0].body;
  assert.equal(body.user, 'anon-9');
  assert.equal(body.stream_options, undefined);
  assert.deepEqual(body.messages[1].reasoning_details, [{ type: 'reasoning.text', text: '想', index: 0 }]);
});
