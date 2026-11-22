import {
  ChunkMode,
  ContentBlock,
  MessageState,
  SSEEvent,
  SSEFormat,
  TokenUsage,
} from '../types';

const CLAUDE_EVENT_TYPES = new Set([
  'message_start',
  'content_block_start',
  'content_block_delta',
  'content_block_stop',
  'message_delta',
  'message_stop',
  'ping',
  'error',
]);

interface PendingBlock {
  event?: string;
  id?: string;
  dataLines: string[];
  comments: string[];
  rawLines: string[];
}

const newPendingBlock = (): PendingBlock => ({
  dataLines: [],
  comments: [],
  rawLines: [],
});

/** Per the SSE spec, a single leading space after the colon is ignored. */
const stripLeadingSpace = (value: string) => (value.startsWith(' ') ? value.slice(1) : value);

const tryParseJSON = (text: string): any | undefined => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
};

const isCompleteJSON = (text: string) => {
  const trimmed = text.trim();
  return trimmed === '[DONE]' || tryParseJSON(trimmed) !== undefined;
};

const normalizeData = (lines: string[]): { data: string; parsedData?: any } => {
  // SSE multi-line data fields are joined with a newline.
  const joined = lines.join('\n');
  let parsedData = tryParseJSON(joined);

  // Some exporters concatenate data fields without inserting a newline.
  if (parsedData === undefined && lines.length > 1) {
    parsedData = tryParseJSON(lines.join(''));
  }

  return { data: joined, parsedData };
};

/**
 * Parse raw SSE text (including pasted HTTP headers).
 *
 * The parser is intentionally tolerant:
 * - headers before the first SSE field are skipped;
 * - `CRLF` and a leading BOM are normalized;
 * - blocks without the trailing blank line are flushed too (some proxies strip it);
 * - a new `id:`/`event:` or a complete JSON `data:` line starts a new block even
 *   when the separating blank line is missing.
 */
export const parseRawSSE = (rawText: string): SSEEvent[] => {
  const normalized = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const events: SSEEvent[] = [];
  let pending = newPendingBlock();
  let started = false;

  const flush = () => {
    if (!pending.event && pending.dataLines.length === 0) {
      pending = newPendingBlock();
      return;
    }

    const { data, parsedData } = normalizeData(pending.dataLines);
    events.push({
      event: pending.event || 'message',
      data,
      parsedData,
      id: pending.id,
      comments: pending.comments.length > 0 ? pending.comments : undefined,
      raw: pending.rawLines.join('\n'),
      timestamp: Date.now(),
    });
    pending = newPendingBlock();
  };

  for (const line of lines) {
    if (!started) {
      // Ignore a pasted HTTP status line / response headers.
      if (line.startsWith('event:') || line.startsWith('data:') || line.startsWith('id:')) {
        started = true;
      } else {
        continue;
      }
    }

    if (line === '') {
      flush();
      continue;
    }

    if (line.startsWith(':')) {
      // SSE comment. DashScope uses `:HTTP_STATUS/200`.
      pending.comments.push(line.slice(1).trim());
      pending.rawLines.push(line);
      continue;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : stripLeadingSpace(line.slice(colon + 1));

    switch (field) {
      case 'event': {
        // `event:` normally opens a block; if data already exists, this belongs
        // to a new event (blank line may have been stripped).
        if (pending.dataLines.length > 0) flush();
        pending.event = value.trim();
        break;
      }
      case 'data': {
        if (pending.dataLines.length > 0) {
          const previous = pending.dataLines.join('\n');
          // If both the previous payload and this line are complete JSON, they
          // are separate events whose blank separator was lost.
          if (isCompleteJSON(previous) && isCompleteJSON(value)) flush();
        }
        pending.dataLines.push(value);
        break;
      }
      case 'id': {
        // `id:` starts a new block in both OpenAI compatible and DashScope
        // streams. If the previous block has data, flush it first.
        if (pending.dataLines.length > 0) flush();
        pending.id = value.trim();
        break;
      }
      default:
        // Unknown fields (retry:, etc.) are ignored.
        break;
    }

    pending.rawLines.push(line);
  }

  // The final event may not be followed by a blank line.
  flush();

  return events;
};

/**
 * Identify which protocol produced the stream using its JSON payloads.
 */
export const detectSSEFormat = (events: SSEEvent[]): SSEFormat => {
  let claudeScore = 0;
  let openaiScore = 0;
  let bailianScore = 0;

  for (const event of events) {
    const data = event.parsedData;

    if (event.event === 'result') bailianScore += 2;
    if (event.data.trim() === '[DONE]') openaiScore += 3;

    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

    if (typeof data.type === 'string' && CLAUDE_EVENT_TYPES.has(data.type)) {
      claudeScore += 3;
    }

    if (data.object === 'chat.completion.chunk') openaiScore += 4;

    if (Array.isArray(data.choices)) {
      if (data.choices.some((choice: any) => choice && typeof choice === 'object' && 'delta' in choice)) {
        openaiScore += 3;
      }
    }

    if (data.output && Array.isArray(data.output.choices)) bailianScore += 5;
    if (data.request_id && (data.output || data.code)) bailianScore += 3;
    if (typeof data.code === 'string' && typeof data.message === 'string' && data.request_id) {
      bailianScore += 2;
    }
  }

  if (bailianScore > 0 && bailianScore >= claudeScore && bailianScore >= openaiScore) {
    return 'bailian';
  }
  if (claudeScore > 0 && claudeScore >= openaiScore) return 'claude';
  if (openaiScore > 0) return 'openai';
  if (bailianScore > 0) return 'bailian';
  return 'unknown';
};

const firstString = (...values: any[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
};

const asArgumentString = (value: any): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Combine a chunk with content accumulated so far.
 * In cumulative mode each chunk is a full snapshot, so it replaces the value.
 */
const appendChunk = (previous: string, chunk: string, mode: ChunkMode): string => {
  if (!chunk) return previous;
  if (mode === 'cumulative') return chunk;
  return previous + chunk;
};

/**
 * Extract text from the different shapes used by DashScope/OpenAI:
 * a string, an array of `{ text }` parts, or a content object.
 */
const extractText = (content: any): string => {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'number' || typeof content === 'boolean') return String(content);

  if (Array.isArray(content)) {
    return content.map(extractText).join('');
  }

  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
    if (Array.isArray(content.content)) return extractText(content.content);
    return '';
  }

  return '';
};

const normalizeFinishReason = (value: any): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return undefined;
  return trimmed;
};

const mapUsage = (usage: any): TokenUsage => {
  const mapped: TokenUsage = {};
  if (!usage || typeof usage !== 'object') return mapped;

  const setNumber = (key: keyof TokenUsage, value: any) => {
    if (typeof value === 'number' && Number.isFinite(value)) mapped[key] = value;
  };

  setNumber('input_tokens', usage.input_tokens ?? usage.prompt_tokens);
  setNumber('output_tokens', usage.output_tokens ?? usage.completion_tokens);
  setNumber('total_tokens', usage.total_tokens);
  setNumber(
    'cache_read_input_tokens',
    usage.cache_read_input_tokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens,
  );
  setNumber('cache_creation_input_tokens', usage.cache_creation_input_tokens);
  setNumber(
    'reasoning_tokens',
    usage.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.completion_tokens_details?.reasoning_tokens,
  );

  return mapped;
};

const mergeUsage = (state: MessageState, usage: any) => {
  const mapped = mapUsage(usage);
  if (Object.keys(mapped).length > 0) {
    state.usage = { ...state.usage, ...mapped };
  }
};

interface MessageBuilder {
  blocks: ContentBlock[];
  addReasoning: (fragment: string) => void;
  addText: (fragment: string) => void;
  addToolCall: (
    index: string | number | undefined,
    id: string | undefined,
    name: string | undefined,
    args: string | undefined,
  ) => void;
}

/**
 * Shared accumulator used by OpenAI/DashScope responses. Consecutive chunks
 * are merged into a thinking block, a text block, and one block per tool call.
 */
const createMessageBuilder = (mode: ChunkMode): MessageBuilder => {
  const blocks: ContentBlock[] = [];
  const toolBlocks = new Map<string, ContentBlock>();
  let reasoningBlock: ContentBlock | undefined;
  let textBlock: ContentBlock | undefined;

  return {
    blocks,
    addReasoning(fragment) {
      if (!fragment) return;
      if (!reasoningBlock) {
        reasoningBlock = { type: 'thinking', content: '' };
        blocks.push(reasoningBlock);
      }
      reasoningBlock.content = appendChunk(reasoningBlock.content, fragment, mode);
    },
    addText(fragment) {
      if (!fragment) return;
      if (!textBlock) {
        textBlock = { type: 'text', content: '' };
        blocks.push(textBlock);
      }
      textBlock.content = appendChunk(textBlock.content, fragment, mode);
    },
    addToolCall(index, id, name, args) {
      const key =
        index === undefined || index === null || index === ''
          ? String(toolBlocks.size)
          : String(index);

      let block = toolBlocks.get(key);
      if (!block) {
        block = { type: 'tool_use', content: '', input: '' };
        toolBlocks.set(key, block);
        blocks.push(block);
      }

      if (id && !block.id) block.id = id;
      if (name) block.name = name;

      if (args !== undefined && args !== null && args !== '') {
        block.input = appendChunk(typeof block.input === 'string' ? block.input : '', args, mode);
      }
    },
  };
};

const reconstructClaude = (events: SSEEvent[]): MessageState => {
  const state: MessageState = { format: 'claude', blocks: [] };

  const ensureBlock = (index: number, type: ContentBlock['type']): ContentBlock => {
    if (!state.blocks[index]) {
      state.blocks[index] = { type, content: '' };
    }
    return state.blocks[index];
  };

  for (const event of events) {
    const data = event.parsedData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

    switch (data.type) {
      case 'message_start': {
        state.model = firstString(data.message?.model) ?? state.model;
        state.role = firstString(data.message?.role) ?? state.role;
        state.request_id = firstString(data.message?.id) ?? state.request_id;
        if (data.message?.usage) mergeUsage(state, data.message.usage);
        break;
      }

      case 'content_block_start': {
        const index = typeof data.index === 'number' ? data.index : state.blocks.length;
        const contentBlock = data.content_block ?? {};
        const type: ContentBlock['type'] =
          contentBlock.type === 'thinking'
            ? 'thinking'
            : contentBlock.type === 'tool_use'
              ? 'tool_use'
              : contentBlock.type === 'tool_result'
                ? 'tool_result'
                : 'text';

        const block = ensureBlock(index, type);
        block.type = type;
        block.id = firstString(contentBlock.id) ?? block.id;
        block.name = firstString(contentBlock.name) ?? block.name;
        block.input = '';
        block.content = extractText(contentBlock.text ?? contentBlock.thinking);
        block.signature = firstString(contentBlock.signature) ?? block.signature;
        break;
      }

      case 'content_block_delta': {
        const index = typeof data.index === 'number' ? data.index : 0;
        const delta = data.delta ?? {};
        let type: ContentBlock['type'] =
          delta.type === 'thinking_delta'
            ? 'thinking'
            : delta.type === 'input_json_delta'
              ? 'tool_use'
              : 'text';
        if (!state.blocks[index]) ensureBlock(index, type);
        const block = state.blocks[index];

        if (delta.type === 'thinking_delta') {
          block.content += delta.thinking ?? '';
        } else if (delta.type === 'text_delta') {
          block.content += delta.text ?? '';
        } else if (delta.type === 'input_json_delta') {
          block.input += delta.partial_json ?? '';
        } else if (delta.type === 'signature_delta') {
          block.signature = delta.signature;
        }
        break;
      }

      case 'message_delta': {
        const stopReason = normalizeFinishReason(data.delta?.stop_reason);
        if (stopReason) state.stop_reason = stopReason;
        if (data.usage) mergeUsage(state, data.usage);
        break;
      }

      case 'error': {
        state.error =
          firstString(data.error?.message, data.message) ?? 'The stream reported an error.';
        break;
      }

      default:
        break;
    }
  }

  // Drop any sparse entries caused by missing indexes.
  state.blocks = state.blocks.filter(Boolean);

  return state;
};

const reconstructOpenAI = (events: SSEEvent[], mode: ChunkMode): MessageState => {
  const state: MessageState = { format: 'openai', blocks: [] };
  const builder = createMessageBuilder(mode);

  for (const event of events) {
    const data = event.parsedData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

    if (typeof data.model === 'string') state.model = data.model;
    if (typeof data.id === 'string') state.request_id = data.id;

    if (data.error) {
      state.error =
        firstString(data.error.message, data.error.code) ?? 'The stream reported an error.';
    }

    if (data.usage) mergeUsage(state, data.usage);

    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!choice || typeof choice !== 'object') continue;

    const delta = choice.delta ?? choice.message ?? {};
    if (typeof delta.role === 'string') state.role = delta.role;

    const reasoning = firstString(
      delta.reasoning_content,
      delta.reasoning,
      choice.reasoning_content,
    );
    if (reasoning) builder.addReasoning(reasoning);

    const text = extractText(delta.content);
    if (text) builder.addText(text);

    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((toolCall: any, position: number) => {
        builder.addToolCall(
          toolCall?.index ?? position,
          firstString(toolCall?.id),
          firstString(toolCall?.function?.name),
          asArgumentString(toolCall?.function?.arguments),
        );
      });
    } else if (delta.function_call) {
      // Legacy `function_call` streaming format.
      builder.addToolCall(
        0,
        undefined,
        firstString(delta.function_call.name),
        asArgumentString(delta.function_call.arguments),
      );
    }

    const finishReason = normalizeFinishReason(choice.finish_reason);
    if (finishReason) state.stop_reason = finishReason;
  }

  state.blocks = builder.blocks;
  return state;
};

const reconstructBailian = (events: SSEEvent[], mode: ChunkMode): MessageState => {
  const state: MessageState = { format: 'bailian', blocks: [] };
  const builder = createMessageBuilder(mode);

  for (const event of events) {
    const data = event.parsedData;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;

    const requestId = firstString(data.request_id, data.output?.request_id);
    if (requestId) state.request_id = requestId;

    const model = firstString(data.model, data.output?.model, data.model_name);
    if (model) state.model = model;

    if (data.usage) mergeUsage(state, data.usage);

    // DashScope error payloads: { code, message, request_id }
    if (typeof data.code === 'string' && data.message) {
      const code = data.code.trim();
      state.error = code ? `[${code}] ${data.message}` : String(data.message);
    }

    const choice = data.output && Array.isArray(data.output.choices)
      ? data.output.choices[0]
      : undefined;
    if (!choice || typeof choice !== 'object') continue;

    // DashScope native streams use `message`; accept `delta` too for proxies
    // that normalize the payload.
    const message = choice.message ?? choice.delta ?? {};
    if (typeof message.role === 'string') state.role = message.role;

    const reasoning = firstString(message.reasoning_content, message.reasoning);
    if (reasoning) builder.addReasoning(reasoning);

    const text = extractText(message.content);
    if (text) builder.addText(text);

    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((toolCall: any, position: number) => {
        builder.addToolCall(
          toolCall?.index ?? position,
          firstString(toolCall?.id),
          firstString(toolCall?.function?.name, toolCall?.name),
          asArgumentString(toolCall?.function?.arguments ?? toolCall?.arguments),
        );
      });
    } else if (message.function_call) {
      builder.addToolCall(
        0,
        undefined,
        firstString(message.function_call.name),
        asArgumentString(message.function_call.arguments),
      );
    }

    const finishReason = normalizeFinishReason(choice.finish_reason);
    if (finishReason) state.stop_reason = finishReason;
  }

  state.blocks = builder.blocks;
  return state;
};

/**
 * Reconstruct a complete assistant message from parsed SSE events.
 * The protocol (Claude / OpenAI compatible / Bailian DashScope) is auto-detected.
 */
export const reconstructMessage = (
  events: SSEEvent[],
  options: { chunkMode?: ChunkMode } = {},
): MessageState => {
  const mode = options.chunkMode ?? 'incremental';
  const format = detectSSEFormat(events);

  switch (format) {
    case 'claude':
      return reconstructClaude(events);
    case 'openai':
      return reconstructOpenAI(events, mode);
    case 'bailian':
      return reconstructBailian(events, mode);
    default:
      return { format: 'unknown', blocks: [] };
  }
};
