import type { ReactNode } from 'react';

interface ComposerSeatProps {
  readonly hasConversation: boolean;
  readonly composer: ReactNode;
}

/**
 * 输入区座位：空会话时欢迎内容与输入区组成居中整体，产生内容后同一个输入区停靠底部。
 * 两个状态使用同一个 composer 节点，因此切换不会重建输入节点或丢失草稿。
 */
export function ComposerSeat({ hasConversation, composer }: ComposerSeatProps) {
  return (
    <section
      className={`composer-seat ${hasConversation ? 'composer-dock' : 'composer-hero'}`}
      aria-label={hasConversation ? '任务输入' : '开始视频任务'}
    >
      {!hasConversation && (
        <div className="empty-state">
          <h2><svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true"><rect x="3" y="6" width="26" height="20" rx="5" /><path d="m13 11 8 5-8 5Z" /></svg>开始一个视频任务</h2>
          <p>选择视频，或者直接告诉 Agent 你想做什么。</p>
        </div>
      )}
      <div className="composer-wrap">{composer}</div>
    </section>
  );
}
