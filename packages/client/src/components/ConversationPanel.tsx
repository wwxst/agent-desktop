import type { ReactNode, RefObject } from 'react';
import type { ClientConversationMessage } from '../api.js';
import { AssistantMessage } from './AssistantMessage.js';
import { ComposerSeat } from './ComposerSeat.js';
import { UserTaskMessage } from './UserTaskMessage.js';

interface ConversationPanelProps {
  readonly messages: readonly ClientConversationMessage[];
  readonly hasConversation: boolean;
  readonly composer: ReactNode;
  readonly historyRef: RefObject<HTMLDivElement | null>;
  readonly onHistoryScroll: () => void;
  readonly onToggleActivity: (messageId: number) => void;
  readonly onRevealFile: (path: string) => Promise<void>;
}

/**
 * 对话工作区：可滚动的阅读轴按轮保留用户任务、活动轨迹和 Agent 回复，输入区占据独立布局空间。
 * 滚动容器由调用方通过 historyRef 控制，使会话切换和自动滚动仍由 App 的会话状态驱动；
 * onHistoryScroll 把用户的真实滚动位置回传给 App，用于判断是否继续跟随最新内容。
 */
export function ConversationPanel({
  messages,
  hasConversation,
  composer,
  historyRef,
  onHistoryScroll,
  onToggleActivity,
  onRevealFile,
}: ConversationPanelProps) {
  return (
    <main
      className={`conversation-scroll${hasConversation ? '' : ' conversation-scroll-empty'}`}
      aria-label="对话工作区"
    >
      <div className="conversation-history" ref={historyRef} onScroll={onHistoryScroll}>
        <div className="conversation-feed" aria-live="polite">
          {messages.map((message) => message.role === 'user' ? (
            <UserTaskMessage
              key={message.id}
              text={message.text}
              attachments={message.attachments}
              {...(message.attachmentRoles === undefined ? {} : { attachmentRoles: message.attachmentRoles })}
            />
          ) : (
            <AssistantMessage
              key={message.id}
              message={message}
              onToggleActivity={onToggleActivity}
              onRevealFile={onRevealFile}
            />
          ))}
        </div>
      </div>

      <ComposerSeat hasConversation={hasConversation} composer={composer} />
    </main>
  );
}
