export type SSEFormat = 'claude' | 'openai' | 'bailian' | 'unknown';

/**
 * DashScope (Bailian) supports two streaming modes:
 * - incremental: each chunk contains only the newly generated fragment
 * - cumulative: each chunk contains all content generated so far
 */
export type ChunkMode = 'incremental' | 'cumulative';

export interface SSEEvent {
  event: string;
  data: string;
  parsedData?: any;
  /** The SSE `id:` field (event id), if present. */
  id?: string;
  /** SSE comment lines, e.g. `:HTTP_STATUS/200` from DashScope. */
  comments?: string[];
  /** Raw lines that make up this event block. */
  raw?: string;
  timestamp: number;
}

export interface ContentBlock {
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result';
  content: string;
  id?: string;
  name?: string;
  /** For tool calls this holds the accumulated arguments JSON string. */
  input?: any;
  signature?: string;
  is_error?: boolean;
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
}

export interface MessageState {
  format?: SSEFormat;
  model?: string;
  role?: string;
  blocks: ContentBlock[];
  usage?: TokenUsage;
  stop_reason?: string;
  request_id?: string;
  error?: string;
}

// New types for Dialogue History (Full HTTP JSON)
export interface ClaudePart {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: any;
  content?: string | any;
  is_error?: boolean;
  tool_use_id?: string;
}

export interface ClaudeMessage {
  role: string;
  content: string | ClaudePart[];
  /** OpenAI / DashScope style function calls on assistant messages. */
  tool_calls?: any[];
  /** DashScope thinking content on assistant messages. */
  reasoning_content?: string;
  /** Set on `role: "tool"` messages to link the result back to its call. */
  tool_call_id?: string;
  name?: string;
}

export interface ClaudeChatHistory {
  model?: string;
  messages: ClaudeMessage[];
  system?: string | any[];
  tools?: any[];
  usage?: any;
  /** DashScope request parameters, e.g. result_format / incremental_output / tools. */
  parameters?: any;
}
