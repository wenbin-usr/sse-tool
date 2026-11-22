import React from 'react';
import { MessageState, SSEFormat } from '../types';

interface MessagePreviewProps {
  state: MessageState;
  hasEvents?: boolean;
}

const FORMAT_LABELS: Record<SSEFormat, string> = {
  claude: 'Claude / Anthropic',
  openai: 'OpenAI compatible',
  bailian: 'Bailian / DashScope',
  unknown: 'Unknown',
};

const prettyArguments = (input: any): string => {
  if (input === undefined || input === null || input === '') return '';
  if (typeof input === 'string') {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch {
      return input;
    }
  }
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
};

const InfoCard: React.FC<{ label: string; value: React.ReactNode; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => (
  <div className="p-3 bg-white border border-slate-200 rounded-lg shadow-sm">
    <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">{label}</div>
    <div className={`text-sm font-semibold text-slate-700 ${mono ? 'mono break-all' : ''}`}>
      {value}
    </div>
  </div>
);

const MessagePreview: React.FC<MessagePreviewProps> = ({ state, hasEvents = false }) => {
  if (state.format === 'unknown' && hasEvents && state.blocks.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center space-y-2">
        <div className="text-amber-600 font-semibold">Unrecognized SSE format</div>
        <p className="text-xs text-slate-500 max-w-md leading-relaxed">
          The stream was parsed, but its payload does not match Claude, OpenAI or Bailian
          (DashScope). Expand an event on the left to inspect the raw JSON.
        </p>
      </div>
    );
  }

  if (
    !hasEvents &&
    state.blocks.length === 0 &&
    !state.usage &&
    !state.model &&
    !state.request_id &&
    !state.error
  ) {
    return (
      <div className="h-full flex items-center justify-center text-slate-400 italic">
        Paste stream content to see reconstruction...
      </div>
    );
  }

  const usage = state.usage;
  const usageRows: Array<{ label: string; value: number }> = [];
  if (usage) {
    if (usage.input_tokens !== undefined) usageRows.push({ label: 'Input', value: usage.input_tokens });
    if (usage.output_tokens !== undefined) usageRows.push({ label: 'Output', value: usage.output_tokens });
    if (usage.total_tokens !== undefined) usageRows.push({ label: 'Total', value: usage.total_tokens });
    if (usage.reasoning_tokens !== undefined) {
      usageRows.push({ label: 'Reasoning', value: usage.reasoning_tokens });
    }
    if (usage.cache_read_input_tokens !== undefined) {
      usageRows.push({ label: 'Cache Read', value: usage.cache_read_input_tokens });
    }
    if (usage.cache_creation_input_tokens !== undefined) {
      usageRows.push({ label: 'Cache Write', value: usage.cache_creation_input_tokens });
    }
  }

  return (
    <div className="space-y-6">
      {state.error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 shadow-sm">
          <div className="text-[10px] font-bold uppercase tracking-widest mb-1">Stream Error</div>
          <div className="text-sm whitespace-pre-wrap leading-relaxed">{state.error}</div>
        </div>
      )}

      {/* Header Info */}
      <div className="grid grid-cols-2 gap-3 md:gap-4">
        <InfoCard label="Model" value={state.model || '—'} mono />
        <InfoCard label="Format" value={FORMAT_LABELS[state.format ?? 'unknown']} />
        <InfoCard label="Stop Reason" value={state.stop_reason || 'Not provided'} />
        <InfoCard label="Role" value={state.role || '—'} />
      </div>

      {state.request_id && (
        <div className="p-3 bg-white border border-slate-200 rounded-lg shadow-sm">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">
            Request ID
          </div>
          <div className="text-xs mono text-slate-600 break-all">{state.request_id}</div>
        </div>
      )}

      {/* Content Blocks */}
      <div className="space-y-4">
        {state.blocks.map((block, idx) => (
          <div key={idx} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className={`px-4 py-2 text-[10px] font-bold uppercase tracking-widest border-b flex justify-between items-center gap-3 ${
              block.type === 'thinking' ? 'bg-amber-50 border-amber-100 text-amber-700' :
              block.type === 'tool_use' ? 'bg-indigo-50 border-indigo-100 text-indigo-700' :
              block.type === 'tool_result' ? 'bg-emerald-50 border-emerald-100 text-emerald-700' :
              'bg-slate-50 border-slate-100 text-slate-500'
            }`}>
              <span>
                {block.type === 'tool_use' ? 'Tool Call' : block.type} Block #{idx}
              </span>
              {(block.name || block.id) && (
                <span className="mono normal-case text-xs truncate text-right">
                  {block.name}
                  {block.name && block.id ? ' · ' : ''}
                  {block.id}
                </span>
              )}
            </div>

            <div className="p-4">
              {block.type === 'thinking' && (
                <div className="text-sm text-slate-600 whitespace-pre-wrap leading-relaxed italic">
                  {block.content || '(empty)'}
                </div>
              )}

              {block.type === 'text' && (
                <div className="text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                  {block.content || '(empty)'}
                </div>
              )}

              {block.type === 'tool_use' && (
                <div className="space-y-2">
                   <div className="text-[10px] text-slate-400 font-bold uppercase">
                     {block.name ? `${block.name} · Arguments` : 'Arguments'}
                   </div>
                   <div className="bg-slate-900 rounded-lg p-3 overflow-x-auto">
                     <pre className="text-xs text-indigo-300 mono whitespace-pre-wrap break-words">
                       {prettyArguments(block.input) || '(no arguments yet)'}
                     </pre>
                   </div>
                </div>
              )}

              {block.type === 'tool_result' && (
                <div className={`text-xs mono whitespace-pre-wrap leading-relaxed ${block.is_error ? 'text-red-600' : 'text-slate-700'}`}>
                  {typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2)}
                </div>
              )}

              {block.signature && (
                <div className="mt-4 pt-4 border-t border-slate-100">
                  <div className="text-[10px] text-slate-400 font-bold uppercase mb-1">Signature</div>
                  <div className="text-[10px] mono text-slate-400 truncate">{block.signature}</div>
                </div>
              )}
            </div>
          </div>
        ))}

        {state.blocks.length === 0 && !state.error && (
          <div className="text-sm text-slate-400 italic">
            No content blocks were reconstructed from this stream.
          </div>
        )}
      </div>

      {/* Usage */}
      {usage && usageRows.length > 0 && (
        <div className="bg-slate-50 rounded-xl p-4 border border-slate-200">
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3">
            Token Usage
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
            {usageRows.map((row) => (
              <div key={row.label}>
                <div className="text-[10px] text-slate-500">{row.label}</div>
                <div className="text-lg font-bold text-slate-700">{row.value.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default MessagePreview;
