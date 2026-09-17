import type { ToolActivityItem, ToolActivityStatus } from '../api.js';

export type { ToolActivityItem } from '../api.js';

interface ToolActivityProps {
  readonly items: readonly ToolActivityItem[];
  readonly expanded: boolean;
  readonly isProcessing: boolean;
  readonly onToggle: () => void;
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  probe_media: '读取视频信息',
  extract_audio: '提取音频',
  transcribe_audio: '识别对白',
  extract_video_frames: '提取画面',
  extract_video_range_frames: '检查局部画面',
  analyze_images: '分析画面',
  trim_video: '裁剪视频',
  concat_videos: '拼接视频',
  add_audio: '添加音频',
  add_subtitles: '添加字幕',
  resize_video: '调整分辨率',
  crop_video: '裁剪画面',
  set_speed: '调整速度',
};

const STATUS_LABELS: Readonly<Record<ToolActivityStatus, string>> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
};

/** 将 Trace 中的技术工具名压缩为面向用户的执行过程。 */
export function ToolActivity({
  items,
  expanded,
  isProcessing,
  onToggle,
}: ToolActivityProps) {
  const showsDetails = isProcessing || expanded;

  return (
    <section className="tool-activity" aria-label="工具执行过程">
      {isProcessing ? (
        <div className="tool-heading">
          <span>工具执行</span>
          <span>{items.length} 项</span>
        </div>
      ) : (
        <button
          className="tool-heading tool-toggle"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? '收起工具执行过程' : `已执行 ${items.length} 个工具`}
          onClick={onToggle}
        >
          <span>{expanded ? '收起工具执行过程' : `已执行 ${items.length} 个工具`}</span>
          <svg className="tool-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </button>
      )}
      {showsDetails && (
        <ol className="tool-list">
          {items.map((item) => (
            <li key={item.toolCallId} className="tool-row">
              <span className={`tool-state state-${item.status}`} aria-hidden="true">
                <svg viewBox="0 0 16 16" width="16" height="16">
                  {item.status === 'running' ? <circle className="tool-spinner" cx="8" cy="8" r="5" />
                    : item.status === 'completed' ? <path d="m3 8 3 3 7-7" />
                      : item.status === 'failed' ? <path d="m4 4 8 8M12 4l-8 8" />
                        : <rect x="4" y="4" width="8" height="8" rx="1" />}
                </svg>
              </span>
              <div className="tool-copy">
                <strong>{TOOL_LABELS[item.toolName] ?? '执行工具'}</strong>
                <code>{item.toolName}</code>
              </div>
              <span className={`tool-status state-${item.status}`}>
                <span>{STATUS_LABELS[item.status]}</span>
                {item.durationMs !== undefined && <span>{item.durationMs} ms</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
