import { type CSSProperties } from 'react';
import { Copy, Loader2, RefreshCw, Send, X, CheckCircle2 } from 'lucide-react';
import MentionPromptInput from '../nodes/MentionPromptInput';
import type { MediaMention } from '../nodes/mediaMentions';

// 时间轴导演台 / CodexCliAgent 共用的「流式对话」创作台 —— 照搬同一套渲染，杜绝残次复刻。
export type CodexStudioRole = 'user' | 'assistant' | 'tool';
export interface CodexStudioMessage {
  id: string;
  role: CodexStudioRole;
  content: string;
  status?: 'running' | 'success' | 'error';
}
export type CodexStudioIntent = 'llm' | 'img';

export interface CodexStudioTheme {
  border: string;
  bg: string;
  surface: string;
  surfaceStrong: string;
  accent: string;
  accentText: string;
  surfaceStrongText: string;
  text: string;
  subText: string;
  danger: string;
  isDark: boolean;
  isPixel: boolean;
}

interface ParamGroup { label: string; options: Array<{ label: string; value: string }>; }

export interface CodexStudioConversationProps {
  theme: CodexStudioTheme;
  headerInfo: string;
  presetLabel: string;
  messages: CodexStudioMessage[];
  streamingReply?: string;
  emptyHint: string;
  intent: CodexStudioIntent;
  onIntentChange: (intent: CodexStudioIntent) => void;
  isBusy: boolean;
  onStop: () => void;
  onRefresh: () => void;
  onSubmit: () => void;
  inputValue: string;
  inputMentions: MediaMention[];
  materials: any[];
  onInputChange: (value: string, mentions: MediaMention[]) => void;
  inputPlaceholder: string;
  persistPrompt: boolean;
  onPersistPromptChange: (next: boolean) => void;
  onAppendImagegenParam: (value: string) => void;
  paramLists: ParamGroup[];
  quickParams: Array<{ label: string; value: string }>;
  onCopyMessage: (text: string) => void;
  intentOptions: Array<{ id: CodexStudioIntent; label: string; title: string }>;
}

function segmentedButtonStyle(theme: CodexStudioTheme, active: boolean): CSSProperties {
  return {
    borderColor: active ? theme.accent : theme.border,
    background: active ? (theme.isDark ? 'rgba(56,189,248,0.16)' : theme.surfaceStrong) : theme.bg,
    color: active ? theme.accent : theme.subText,
  };
}

export default function CodexStudioConversation(props: CodexStudioConversationProps) {
  const { theme, messages, streamingReply = '' } = props;
  const stopEvt = (event: any) => { event.stopPropagation?.(); event.nativeEvent?.stopImmediatePropagation?.(); };

  const intentToggle = (
    <div className="grid grid-cols-2 gap-1 rounded-xl border p-1" style={{ borderColor: theme.accent, background: theme.isDark ? 'rgba(8,13,28,0.72)' : theme.bg }}>
      {props.intentOptions.map((item) => {
        const active = props.intent === item.id;
        const intentLabel = item.id === 'img' ? '生图模式' : '文字模式';
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            className="nodrag flex min-h-[42px] flex-col items-center justify-center rounded-lg border px-3 py-1.5 text-xs font-black transition"
            style={{ ...segmentedButtonStyle(theme, active), outline: active ? `2px solid ${theme.accent}` : '1px solid transparent', transform: active ? 'translateY(-1px)' : undefined }}
            onClick={() => props.onIntentChange(item.id)}
            title={item.title}
          >
            <span className="inline-flex items-center justify-center gap-1 leading-none">
              {active && <CheckCircle2 size={13} strokeWidth={3} />}
              <span>{item.label}</span>
              {active && <span className="rounded-full border px-1.5 py-0.5 text-[9px] font-black leading-none" style={{ borderColor: theme.border, background: theme.surface, color: theme.accent }}>当前</span>}
            </span>
            <span className="mt-0.5 text-[10px] font-bold leading-none opacity-80">{intentLabel}</span>
          </button>
        );
      })}
    </div>
  );

  const imagegenBar = props.intent === 'img' ? (
    <div className="nodrag mb-2 grid gap-1.5" style={{ color: theme.subText }}>
      <div className="grid grid-cols-2 gap-1.5">
        {props.paramLists.map((group) => (
          <select
            key={group.label}
            className="nodrag min-w-0 rounded-md border px-2 py-1 text-[10px] font-black outline-none"
            style={{ borderColor: theme.border, background: theme.bg, color: theme.text }}
            value=""
            onChange={(event) => { const v = event.currentTarget.value; if (v) props.onAppendImagegenParam(v); }}
            title={`追加${group.label}参数`}
          >
            <option value="">{group.label}</option>
            {group.options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {props.quickParams.map((item) => (
          <button
            key={item.value}
            type="button"
            className="nodrag rounded-md border px-2 py-1 text-[10px] font-black leading-none"
            style={{ borderColor: theme.border, background: theme.surfaceStrong, color: theme.surfaceStrongText }}
            onClick={() => props.onAppendImagegenParam(item.value)}
            title={`追加 ${item.value}`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <main className="flex min-h-0 flex-col" style={{ background: theme.isDark ? undefined : '#ffffff' }}>
      <div className="border-b-2 px-4 py-3" style={{ borderColor: theme.border, background: theme.surface }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-black" style={{ color: theme.text }}>流式对话</div>
            <div className="truncate text-[11px]" style={{ color: theme.subText }}>{props.headerInfo}</div>
          </div>
          <div className="flex items-center gap-2">
            {intentToggle}
            {props.isBusy && (
              <button type="button" className="nodrag inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-black" style={{ borderColor: theme.danger, color: theme.danger, background: theme.surface }} onClick={props.onStop}>
                <X size={14} /> 停止
              </button>
            )}
          </div>
        </div>
      </div>

      <div
        className="nodrag nopan nowheel min-h-0 flex-1 overflow-auto p-5"
        style={{ userSelect: 'text', WebkitUserSelect: 'text' } as CSSProperties}
        onMouseDownCapture={stopEvt}
        onPointerDownCapture={stopEvt}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="w-full max-w-none space-y-5 select-text">
          {messages.length === 0 && (
            <div className="py-4 text-sm leading-relaxed" style={{ color: theme.subText }}>{props.emptyHint}</div>
          )}
          {messages.map((msg) => {
            const roleLabel = msg.role === 'user' ? 'USER' : msg.role === 'tool' ? 'TOOL' : 'CODEX';
            const messageContent = msg.content || (msg.status === 'running' && msg.role === 'assistant' ? streamingReply : '') || (msg.status === 'running' ? 'Codex 正在生成...' : '');
            if (msg.role === 'tool') {
              return (
                <div key={msg.id} className="group flex items-start gap-2 text-[11px]" style={{ color: theme.subText }}>
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: theme.accent }} />
                  <span className="nodrag nopan min-w-0 select-text whitespace-pre-wrap leading-relaxed" style={{ userSelect: 'text' } as CSSProperties} onMouseDownCapture={stopEvt} onMouseDown={(event) => event.stopPropagation()}>{msg.content}</span>
                  <button type="button" className="nodrag shrink-0 rounded-md border px-1.5 py-1 opacity-70 transition hover:opacity-100" style={{ borderColor: theme.border, background: theme.surface, color: theme.text }} onClick={() => props.onCopyMessage(msg.content)} title="复制这条消息"><Copy size={11} /></button>
                </div>
              );
            }
            return (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`min-w-0 max-w-[92%] ${msg.role === 'user' ? 'text-right' : 'text-left'}`}>
                  <div className={`mb-1 flex items-center gap-2 text-[10px] font-black uppercase tracking-wide ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`} style={{ color: theme.subText }}>
                    <span>{roleLabel}</span>
                    {msg.status === 'running' && <Loader2 size={12} className="animate-spin" />}
                    <button type="button" className="nodrag rounded-md border px-1 py-0.5 opacity-70 transition hover:opacity-100" style={{ borderColor: theme.border, background: theme.surface, color: theme.text }} onClick={() => props.onCopyMessage(messageContent)} title="复制这条消息"><Copy size={10} /></button>
                  </div>
                  <div className="nodrag nopan select-text whitespace-pre-wrap text-sm leading-relaxed" style={{ color: theme.text, userSelect: 'text' } as CSSProperties} onMouseDownCapture={stopEvt} onMouseDown={(event) => event.stopPropagation()}>{messageContent}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t-2 p-4" style={{ borderColor: theme.border, background: theme.bg }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-black" style={{ color: theme.text }}>输入任务</div>
            <div className="text-[11px]" style={{ color: theme.subText }}>支持 @ 产物和 /Skill 直接调用能力</div>
          </div>
          <div className="rounded-lg border px-2 py-1 text-[11px] font-bold" style={{ borderColor: theme.border, background: theme.surface, color: theme.subText }}>{props.presetLabel}</div>
        </div>
        <div className="rounded-xl border-2 p-2" style={{ borderColor: theme.accent, background: theme.bg }}>
          {imagegenBar}
          <MentionPromptInput
            value={props.inputValue}
            mentions={props.inputMentions}
            materials={props.materials}
            onChange={props.onInputChange}
            onSubmit={props.onSubmit}
            placeholder={props.inputPlaceholder}
            title="Codex 流式对话"
            promptTemplateKind="image"
            isDark={theme.isDark}
            isPixel={theme.isPixel}
            expandable
            className="rounded-lg px-2 py-2 text-sm outline-none"
            style={{ color: theme.text, background: 'transparent', minHeight: 150, height: 150 }}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <label className="nodrag flex items-center gap-2 text-xs" style={{ color: theme.subText }}>
            <input type="checkbox" checked={props.persistPrompt} onChange={(event) => props.onPersistPromptChange(event.currentTarget.checked)} />
            保留 Prompt
          </label>
          <div className="flex items-center gap-2">
            <button type="button" className="nodrag inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-bold" style={{ borderColor: theme.border, background: theme.surface, color: theme.text }} onClick={props.onRefresh}>
              <RefreshCw size={15} /> 刷新
            </button>
            {props.isBusy && (
              <button type="button" className="nodrag inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-black" style={{ borderColor: theme.danger, color: theme.danger, background: theme.surface }} onClick={props.onStop}>
                <X size={15} /> 停止
              </button>
            )}
            <button type="button" className="nodrag inline-flex items-center gap-1 rounded-lg border px-4 py-2 text-sm font-black" style={{ background: theme.accent, color: theme.accentText, borderColor: theme.accent }} disabled={props.isBusy} onClick={props.onSubmit}>
              {props.isBusy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} 发送
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
