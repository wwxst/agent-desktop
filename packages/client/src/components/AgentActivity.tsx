import { useState } from 'react';
import type { AgentActivityFile, AgentActivityItem, AgentActivityStatus } from '../api.js';

export type { AgentActivityItem } from '../api.js';

interface AgentActivityProps {
  readonly items: readonly AgentActivityItem[];
  readonly expanded: boolean;
  readonly isProcessing: boolean;
  readonly onToggle: () => void;
  readonly onRevealFile: (path: string) => Promise<void>;
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  set_working_directory: '设置工作目录',
  list_directory: '列出目录',
  read_file: '读取文件',
  search_text: '搜索内容',
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

const STATUS_LABELS: Readonly<Record<AgentActivityStatus, string>> = {
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
};

/** 长耗时按秒或分钟展示，避免一次真实 ffmpeg 调用只显示一个巨大的毫秒数。 */
function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  return `${Math.floor(durationMs / 60_000)} 分 ${Math.round((durationMs % 60_000) / 1000)} 秒`;
}

/** 分析行显示模型这一步的真实结果；工具行显示 Trace 里的中文动作名。 */
function activityLabel(item: AgentActivityItem): string {
  if (item.kind === 'tool') return TOOL_LABELS[item.toolName ?? ''] ?? '执行工具';
  return '分析任务';
}

/** 分析行在技术工具名的位置显示该步真实产生的工具调用数量。 */
function activityDetail(item: AgentActivityItem): string | undefined {
  if (item.kind === 'tool') return item.toolName;
  if (item.plannedToolCallCount === undefined) return undefined;
  return item.plannedToolCallCount === 0 ? '生成回复' : `计划调用 ${item.plannedToolCallCount} 个工具`;
}

function StatusMark({ status }: { readonly status: AgentActivityStatus }) {
  return (
    <span className={`activity-state state-${status}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16">
        {status === 'running' ? <circle className="activity-spinner" cx="8" cy="8" r="5" />
          : status === 'completed' ? <path d="m3 8 3 3 7-7" />
            : status === 'failed' ? <path d="m4 4 8 8M12 4l-8 8" />
              : <rect x="4" y="4" width="8" height="8" rx="1" />}
      </svg>
    </span>
  );
}

interface FileButtonProps {
  readonly file: AgentActivityFile;
  readonly onReveal: () => void;
}

function FileButton({ file, onReveal }: FileButtonProps) {
  return (
    <button
      className={`activity-file role-${file.role}`}
      type="button"
      title={file.path}
      aria-label={`定位文件：${file.path}`}
      onClick={onReveal}
    >
      {file.role === 'output' && <span className="activity-file-direction" aria-hidden="true">→</span>}
      <span className="activity-file-name">{file.label}</span>
    </button>
  );
}

/**
 * 活动轨迹：按真实执行顺序展示模型工作和工具调用。
 * 每行由状态符号、中文动作名、技术工具名或分析结果、真实文件引用、执行状态和耗时组成；
 * 文件引用只在宿主确认过的真实路径上出现，点击交给宿主定位。
 */
export function AgentActivity({
  items,
  expanded,
  isProcessing,
  onToggle,
  onRevealFile,
}: AgentActivityProps) {
  const showsDetails = isProcessing || expanded;
  const [fileError, setFileError] = useState<{ readonly id: string; readonly message: string } | null>(null);

  const reveal = (id: string, path: string) => {
    void onRevealFile(path).then(
      () => setFileError(null),
      (error: unknown) => setFileError({
        id,
        message: error instanceof Error ? error.message : '无法定位该文件。',
      }),
    );
  };

  return (
    <section className="agent-activity" aria-label="执行过程">
      {isProcessing ? (
        <div className="activity-heading">
          <span>执行过程</span>
          <span>{items.length} 项</span>
        </div>
      ) : (
        <button
          className="activity-heading activity-toggle"
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? '收起执行过程' : `展开执行过程，共 ${items.length} 项`}
          onClick={onToggle}
        >
          <span>{expanded ? '收起执行过程' : `执行过程 · ${items.length} 项`}</span>
          <svg className="activity-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
        </button>
      )}
      {showsDetails && (
        <ol className="activity-list">
          {items.map((item) => {
            const detail = activityDetail(item);
            const inputFiles = item.files?.filter((file) => file.role === 'input') ?? [];
            const outputFiles = item.files?.filter((file) => file.role === 'output') ?? [];
            return (
              <li key={item.id} className="activity-row">
                <StatusMark status={item.status} />
                <div className="activity-copy">
                  <strong>{activityLabel(item)}</strong>
                  {detail !== undefined && (item.kind === 'tool'
                    ? <code>{detail}</code>
                    : <span className="activity-note">{detail}</span>)}
                  {inputFiles.map((file) => (
                    <FileButton key={file.path} file={file} onReveal={() => reveal(item.id, file.path)} />
                  ))}
                  {inputFiles.length > 0 && outputFiles.length > 0 && (
                    <span className="activity-file-separator" aria-hidden="true">→</span>
                  )}
                  {outputFiles.map((file) => (
                    <FileButton key={file.path} file={file} onReveal={() => reveal(item.id, file.path)} />
                  ))}
                </div>
                <span className={`activity-status state-${item.status}`}>
                  <span>{STATUS_LABELS[item.status]}</span>
                  {item.durationMs !== undefined && <span>{formatDuration(item.durationMs)}</span>}
                </span>
                {fileError?.id === item.id && (
                  <p className="activity-file-error" role="status">{fileError.message}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
