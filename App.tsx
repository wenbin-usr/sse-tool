import React, { useState, useEffect, useCallback, useRef } from 'react';
import { parseRawSSE, reconstructMessage } from './services/sseParser';
import { SSEEvent, MessageState, ClaudeChatHistory, SSEFormat } from './types';
import EventItem from './components/EventItem';
import MessagePreview from './components/MessagePreview';
import ChatHistory from './components/ChatHistory';

const EXAMPLE_SSE = `HTTP/1.1 200 OK
Date: Thu, 22 Jan 2026 07:47:40 GMT
Content-Type: text/event-stream

event: message_start
data: {"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","id":"msg_018cm4M9aUKGUBQVjTopFThQ","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"cache_creation_input_tokens":5646,"cache_read_input_tokens":13370,"output_tokens":1}} }

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""} }

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"用"} }

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"户"} }

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"请求"} }

event: content_block_stop
data: {"type":"content_block_stop","index":0 }

event: message_stop
data: {"type":"message_stop"}
`;

const EXAMPLE_HTTP = `{
    "model": "claude-haiku-4-5-20251001",
    "messages": [
        {
            "role": "user",
            "content": [
                { "type": "text", "text": "@src/Hello.java 有错误，告诉我原因，我应该怎么修复" }
            ]
        },
        {
            "role": "assistant",
            "content": [
                {
                    "type": "thinking",
                    "thinking": "用户要求我检查 \`/src/Hello.java\` 文件中的错误。我需要读取这个文件。",
                    "signature": "EtQCCkYICxgCKkBd7b7bG3Dstd88+eyZgO9gCMl3FJwOmhEKbg6QvMGXKm+CzZaR+KjZJGTJ3qkGk0mvV6YCFL8MKrF+T4CaycpOEgyezDUI1T"
                },
                {
                    "type": "tool_use",
                    "id": "toolu_01X2snB1Lu3u4464Q3Zf8cqe",
                    "name": "Read",
                    "input": { "file_path": "/Users/tommy/temp/myProject/src/Hello.java" }
                }
            ]
        },
        {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "content": "<tool_use_error>File does not exist.</tool_use_error>",
                    "is_error": true,
                    "tool_use_id": "toolu_01X2snB1Lu3u4464Q3Zf8cqe"
                }
            ]
        }
    ]
}`;

// Bailian (DashScope) native request body: model + input.messages + parameters.
const EXAMPLE_BAILIAN_REQUEST = JSON.stringify(
  {
    model: 'qwen3-max',
    input: {
      messages: [
        { role: 'system', content: [{ text: '你是一个乐于助人的助手。' }] },
        { role: 'user', content: [{ text: '杭州今天天气怎么样？' }] },
        {
          role: 'assistant',
          content: [{ text: '我先查一下天气。' }],
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"杭州"}' },
            },
          ],
        },
        {
          role: 'tool',
          name: 'get_weather',
          tool_call_id: 'call_1',
          content: '{"temperature":18,"weather":"晴"}',
        },
      ],
    },
    parameters: {
      result_format: 'message',
      incremental_output: true,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查询指定城市的实时天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: '城市名' } },
              required: ['city'],
            },
          },
        },
      ],
    },
  },
  null,
  2,
);

// Bailian/DashScope example built from real JSON objects so escaping stays valid.
const BAILIAN_REQUEST_ID = '8b26e699-411a-9bb6-9ec2-2314a3af5a72';

const bailianUsage = (outputTokens: number, reasoningTokens = 0) => ({
  input_tokens: 6715,
  output_tokens: outputTokens,
  total_tokens: 6715 + outputTokens,
  output_tokens_details: {
    reasoning_tokens: reasoningTokens,
    text_tokens: outputTokens - reasoningTokens,
  },
  prompt_tokens_details: { cached_tokens: 0 },
  input_tokens_details: { text_tokens: 6715 },
});

const bailianChunk = (message: any, outputTokens: number, reasoningTokens = 0, finishReason = 'null') => ({
  output: {
    choices: [{ finish_reason: finishReason, message, index: 0 }],
  },
  usage: bailianUsage(outputTokens, reasoningTokens),
  request_id: BAILIAN_REQUEST_ID,
});

const EXAMPLE_BAILIAN = [
  bailianChunk(
    {
      role: 'assistant',
      content: [],
      reasoning_content: '用户想查看工作区里的技能文件。',
    },
    12,
    12,
  ),
  bailianChunk(
    {
      role: 'assistant',
      content: [],
      reasoning_content: '先看看目录结构。',
    },
    21,
    21,
  ),
  bailianChunk(
    {
      role: 'assistant',
      content: [{ text: '我来' }],
      reasoning_content: '',
    },
    26,
    21,
  ),
  bailianChunk(
    {
      role: 'assistant',
      content: [{ text: '查看工作区目录。' }],
      reasoning_content: '',
    },
    31,
    21,
  ),
  bailianChunk(
    {
      role: 'assistant',
      content: [],
      reasoning_content: '',
      tool_calls: [
        {
          id: 'call_8b26e699',
          index: 0,
          type: 'function',
          function: { name: 'list_directory', arguments: '' },
        },
      ],
    },
    49,
    21,
  ),
  bailianChunk(
    {
      role: 'assistant',
      content: [],
      reasoning_content: '',
      tool_calls: [
        {
          id: '',
          index: 0,
          type: 'function',
          function: { arguments: '{"path":"' },
        },
      ],
    },
    52,
    21,
  ),
  bailianChunk(
    {
      role: 'assistant',
      content: [],
      reasoning_content: '',
      tool_calls: [
        {
          id: '',
          index: 0,
          type: 'function',
          function: { arguments: '-workspace_skills"}' },
        },
      ],
    },
    63,
    21,
  ),
  bailianChunk(
    {
      role: 'assistant',
      content: [],
      reasoning_content: '',
    },
    63,
    21,
    'tool_calls',
  ),
]
  .map(
    (payload, index) =>
      `id:${index + 1}\nevent:result\n:HTTP_STATUS/200\ndata:${JSON.stringify(payload)}\n`,
  )
  .join('\n');

const FORMAT_META: Record<SSEFormat, { label: string; className: string }> = {
  claude: { label: 'CLAUDE', className: 'bg-indigo-100 text-indigo-700 border-indigo-200' },
  openai: { label: 'OPENAI', className: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  bailian: { label: 'BAILIAN', className: 'bg-amber-100 text-amber-700 border-amber-200' },
  unknown: { label: 'UNKNOWN', className: 'bg-slate-100 text-slate-600 border-slate-200' },
};

const CLAUDE_PART_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'image', 'document']);

/** Infer which request-body convention a pasted request JSON follows. */
const detectRequestFormat = (json: any, messages: any[]): SSEFormat => {
  if (Array.isArray(json?.input?.messages)) return 'bailian';
  if (json?.parameters) return 'bailian';

  const hasClaudeParts = messages.some(
    (msg) =>
      Array.isArray(msg?.content) &&
      msg.content.some((part: any) => part?.type && CLAUDE_PART_TYPES.has(part.type)),
  );
  if (json?.system || hasClaudeParts) return 'claude';

  const hasOpenAIShape = messages.some(
    (msg) => msg?.role === 'tool' || Array.isArray(msg?.tool_calls) || typeof msg?.reasoning_content === 'string',
  );
  if (hasOpenAIShape) return 'openai';

  return 'unknown';
};

const MIN_LEFT_WIDTH = 18;
const MAX_LEFT_WIDTH = 70;

const App: React.FC = () => {
  const [inputText, setInputText] = useState('');
  const [viewMode, setViewMode] = useState<'sse' | 'dialogue'>('sse');
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [messageState, setMessageState] = useState<MessageState>({ blocks: [] });
  const [chatHistory, setChatHistory] = useState<ClaudeChatHistory | null>(null);
  const [requestFormat, setRequestFormat] = useState<SSEFormat>('unknown');
  const [cumulative, setCumulative] = useState(false);
  const [leftWidth, setLeftWidth] = useState(33.33);
  const [isResizing, setIsResizing] = useState(false);

  const mainRef = useRef<HTMLElement>(null);
  const isResizingRef = useRef(false);

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    setIsResizing(true);
  }, []);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      if (!isResizingRef.current || !mainRef.current) return;
      const rect = mainRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, pct)));
    };

    const handleEnd = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      setIsResizing(false);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
    window.addEventListener('pointercancel', handleEnd);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
      window.removeEventListener('pointercancel', handleEnd);
    };
  }, []);

  useEffect(() => {
    document.body.style.userSelect = isResizing ? 'none' : '';
    document.body.style.cursor = isResizing ? 'col-resize' : '';
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing]);

  const handleParse = useCallback(() => {
    if (!inputText.trim()) {
      setViewMode('sse');
      setEvents([]);
      setMessageState({ blocks: [] });
      setChatHistory(null);
      setRequestFormat('unknown');
      return;
    }

    try {
      // Dialogue history is either top-level `messages` (Claude / OpenAI
      // compatible) or `input.messages` (Bailian / DashScope native request).
      const json = JSON.parse(inputText);
      const messages = Array.isArray(json?.messages)
        ? json.messages
        : Array.isArray(json?.input?.messages)
          ? json.input.messages
          : null;

      if (messages) {
        setViewMode('dialogue');
        setRequestFormat(detectRequestFormat(json, messages));
        setChatHistory({
          model: json.model ?? json.input?.model,
          messages,
          system: json.system,
          tools: Array.isArray(json.tools) ? json.tools : json.parameters?.tools,
          parameters: json.parameters,
        });
        setEvents([]);
        setMessageState({ blocks: [] });
        return;
      }
    } catch (e) {
      // Not a pure dialogue JSON, try SSE parsing
    }

    // Default to SSE
    setViewMode('sse');
    setRequestFormat('unknown');
    setChatHistory(null);
    const parsed = parseRawSSE(inputText);
    setEvents(parsed);
    setMessageState(
      reconstructMessage(parsed, {
        chunkMode: cumulative ? 'cumulative' : 'incremental',
      }),
    );
  }, [inputText, cumulative]);

  useEffect(() => {
    handleParse();
  }, [handleParse]);

  const format = messageState.format ?? 'unknown';
  const formatMeta = FORMAT_META[format];

  const requestMeta = FORMAT_META[requestFormat];
  const modeBadge =
    viewMode === 'dialogue'
      ? {
          text: requestFormat === 'unknown' ? 'REQUEST' : `REQUEST · ${requestMeta.label}`,
          className: requestMeta.className,
        }
      : {
          text: format === 'unknown' ? 'SSE' : `SSE · ${formatMeta.label}`,
          className: formatMeta.className,
        };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between gap-4 flex-wrap sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-lg shadow-indigo-200">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-800">SSE Protocol Inspector</h1>
            <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">
              Claude · OpenAI · Bailian (DashScope) stream analysis
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setInputText(EXAMPLE_SSE)}
            className="px-3 py-2 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors border border-indigo-100"
          >
            Claude SSE
          </button>
          <button
            onClick={() => setInputText(EXAMPLE_BAILIAN)}
            className="px-3 py-2 text-xs font-semibold text-amber-600 hover:bg-amber-50 rounded-lg transition-colors border border-amber-100"
          >
            Bailian SSE
          </button>
          <button
            onClick={() => setInputText(EXAMPLE_BAILIAN_REQUEST)}
            className="px-3 py-2 text-xs font-semibold text-amber-600 hover:bg-amber-50 rounded-lg transition-colors border border-amber-100"
          >
            Bailian JSON
          </button>
          <button
            onClick={() => setInputText(EXAMPLE_HTTP)}
            className="px-3 py-2 text-xs font-semibold text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors border border-emerald-100"
          >
            Claude JSON
          </button>
          <button
            onClick={() => {
              setInputText('');
              setEvents([]);
              setMessageState({ blocks: [] });
              setChatHistory(null);
              setViewMode('sse');
              setRequestFormat('unknown');
            }}
            className="px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 rounded-lg transition-colors border border-slate-200"
          >
            Clear
          </button>
        </div>
      </header>

      <main ref={mainRef} className="flex-1 flex flex-col md:flex-row overflow-hidden">
        {/* Input Pane */}
        <div
          style={{ '--left-width': `${leftWidth}%` } as React.CSSProperties}
          className={`w-full md:w-[var(--left-width)] md:flex-none md:shrink-0 flex flex-col h-[calc(100vh-73px)] ${
            isResizing ? '' : 'transition-[width] duration-150'
          }`}
        >
          <div className="p-4 bg-slate-50 border-b border-slate-200">
            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-2 flex justify-between items-center gap-2">
              <span>RAW DATA INPUT</span>
              <span className={`px-2 py-0.5 rounded border font-bold ${modeBadge.className}`}>
                {modeBadge.text}
              </span>
            </div>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Paste an SSE stream (Claude, OpenAI compatible or Bailian/DashScope), or a request JSON (Claude / Bailian)..."
              className="w-full h-48 p-4 bg-white border border-slate-200 rounded-xl shadow-inner focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-all outline-none text-[10px] mono resize-none"
            />
            {viewMode === 'sse' && (
              <label className="mt-3 flex items-start gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={cumulative}
                  onChange={(e) => setCumulative(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-[11px] leading-snug text-slate-500">
                  Chunks are cumulative snapshots
                  <span className="block text-[10px] text-slate-400">
                    Bailian `incremental_output=false`; leave off for incremental deltas.
                  </span>
                </span>
              </label>
            )}
          </div>

          <div className="flex-1 flex flex-col overflow-hidden">
            {viewMode === 'sse' ? (
              <>
                <div className="px-4 py-3 bg-white border-b border-slate-200">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                    Event Sequence ({events.length})
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto bg-white">
                  {events.length === 0 ? (
                    <div className="p-6 text-xs text-slate-400 italic">
                      Paste a stream above to inspect individual events.
                    </div>
                  ) : (
                    events.map((ev, index) => (
                      <EventItem key={`${ev.id ?? 'event'}-${index}`} event={ev} />
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col bg-slate-100 p-8 items-center justify-center text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-emerald-200 flex items-center justify-center text-emerald-600">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <h3 className="font-bold text-slate-700">Request JSON Mode</h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  A complete request body was detected.
                  <br />
                  Visualizing the full message sequence on the right.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Resize Handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          onPointerDown={handleResizeStart}
          className={`hidden md:flex w-2 shrink-0 items-center justify-center cursor-col-resize touch-none select-none z-[6] transition-colors ${
            isResizing ? 'bg-indigo-400' : 'bg-slate-200 hover:bg-indigo-300'
          }`}
        >
          <div
            className={`h-12 w-0.5 rounded-full transition-colors ${
              isResizing ? 'bg-white' : 'bg-slate-400'
            }`}
          />
        </div>

        {/* View Pane */}
        <div className="w-full md:flex-1 md:min-w-0 flex flex-col h-[calc(100vh-73px)] bg-slate-50">
          <div className="px-6 py-4 bg-white border-b border-slate-200 flex items-center justify-between shadow-sm z-[5]">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
              Visual Reconstruction
            </span>
            {viewMode === 'sse'
              ? format !== 'unknown' && (
                  <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${formatMeta.className}`}>
                    {formatMeta.label}
                  </span>
                )
              : (
                  <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${requestMeta.className}`}>
                    {modeBadge.text}
                  </span>
                )}
          </div>
          <div className="flex-1 overflow-y-auto p-8 scroll-smooth">
            {viewMode === 'sse' ? (
              <MessagePreview state={messageState} hasEvents={events.length > 0} />
            ) : chatHistory ? (
              <ChatHistory history={chatHistory} />
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
