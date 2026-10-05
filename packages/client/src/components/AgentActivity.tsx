import { useState } from 'react';
import type {
  AgentActivityDetail,
  AgentActivityFile,
  AgentActivityItem,
  AgentActivityStatus,
} from '../api.js';

export type { AgentActivityItem } from '../api.js';

interface AgentActivityProps {
  readonly items: readonly AgentActivityItem[];
  readonly expanded: boolean;
  readonly isProcessing: boolean;
  readonly onToggle: () => void;
  readonly onRevealFile: (path: string) => Promise<void>;
}

const TOOL_LABELS: Readonly<Record<string, string>> = {
  load_skill: '加载技能',
  ask_user: '询问用户',
  delegate_tasks: '委派只读任务',
  set_working_directory: '设置工作目录',
  list_directory: '列出目录',
  read_file: '读取文件',
  search_text: '搜索内容',
  write_text_file: '创建文本文件',
  edit_text_file: '修改文本文件',
  run_command: '执行命令',
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
  if (item.kind === 'tool') return TOOL_LABELS[item.toolName ?? ''] ?? (item.toolName?.startsWith('p_') ? '调用插件工具' : '执行工具');
  return '分析任务';
}

/** 分析行在技术工具名的位置显示该步真实产生的工具调用数量。 */
function activityDetail(item: AgentActivityItem): string | undefined {
  if (item.kind === 'tool') return item.toolName;
  if (item.plannedToolCallCount === undefined) return undefined;
  return item.plannedToolCallCount === 0 ? '生成回复' : `计划调用 ${item.plannedToolCallCount} 个工具`;
}

/** Harness 的执行过程按事件类型识别条目；运行中状态继续使用真实旋转指示。 */
function ActivityMark({ item }: { readonly item: AgentActivityItem }) {
  return (
    <span className={`activity-state state-${item.status}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16">
        {item.status === 'running' ? <circle className="activity-spinner" cx="8" cy="8" r="5" />
          : item.status === 'failed' ? <path d="m4 4 8 8M12 4l-8 8" />
            : item.status === 'cancelled' ? <rect x="4" y="4" width="8" height="8" rx="1" />
              : item.kind === 'analysis'
                ? <><path d="M8 2.5 9 5a2 2 0 0 0 1.1 1.1l2.5 1L10.1 8A2 2 0 0 0 9 9.1l-1 2.5-1-2.5A2 2 0 0 0 5.9 8L3.4 7l2.5-1A2 2 0 0 0 7 5Z" /><path d="m12.5 11 .4 1 .9.4-.9.4-.4 1-.4-1-.9-.4.9-.4Z" /></>
                : <><path d="m9.6 4.3 2.1 2.1" /><path d="M10.8 2.8a3.2 3.2 0 0 0-4.1 4.1L2.8 10.8a1.7 1.7 0 0 0 2.4 2.4l3.9-3.9a3.2 3.2 0 0 0 4.1-4.1l-2 2-2.4-2.4Z" /></>}
      </svg>
    </span>
  );
}

/** 整轮只统计真实工具调用；模型步骤属于过程，不伪装成额外的工具项。 */
function processSummary(items: readonly AgentActivityItem[], isProcessing: boolean): string {
  const toolCount = items.filter((item) => item.kind === 'tool').length;
  if (toolCount > 0) return `${toolCount} 次工具调用`;
  return isProcessing ? '正在分析' : '已生成回复';
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

/** 命令输出的两条流分别展示：界面不声称两条流之间有操作系统保证的精确顺序。 */
function CommandStreams({ detail }: {
  readonly detail: {
    readonly stdout: string;
    readonly stderr: string;
    readonly truncated: boolean;
    readonly droppedBytes: number;
  };
}) {
  return (
    <div className="activity-command-streams">
      {detail.stdout.length === 0 && detail.stderr.length === 0 && (
        <p className="activity-result-empty">暂无输出</p>
      )}
      {detail.stdout.length > 0 && (
        <div className="activity-command-stream">
          <span>标准输出</span>
          <pre>{detail.stdout}</pre>
        </div>
      )}
      {detail.stderr.length > 0 && (
        <div className="activity-command-stream is-stderr">
          <span>错误输出</span>
          <pre>{detail.stderr}</pre>
        </div>
      )}
      {detail.truncated && (
        <p className="activity-result-note">输出超过保留上限，已省略 {detail.droppedBytes} 字节。</p>
      )}
    </div>
  );
}

function ActivityResultDetail({ detail }: { readonly detail: AgentActivityDetail }) {
  if (detail.kind === 'subagents') return <div className="activity-result">{detail.tasks.map((task) => (
    <div key={task.taskId}><strong>{task.title}</strong><span> {{ running: '执行中', completed: '已完成', failed: '失败', cancelled: '已停止', 'budget-exhausted': '预算耗尽，未完成' }[task.status] ?? task.status}</span><p>{task.summary}</p></div>
  ))}</div>;
  if (detail.kind === 'interaction') return <div className="activity-result"><p>{detail.question}</p><p>{detail.answer}</p></div>;
  if (detail.kind === 'error') {
    return <p className="activity-result-error" role="status">{detail.message}</p>;
  }

  // 命令的实时输出与最终终态共用同一段流渲染：来源可辨，截断如实说明。
  if (detail.kind === 'command-output') {
    return (
      <div className="activity-result">
        <div className="activity-result-meta">
          <code className="activity-command-line">{detail.command}</code>
          <span>执行中</span>
        </div>
        <CommandStreams detail={detail} />
      </div>
    );
  }

  if (detail.kind === 'command') {
    const outcome = detail.termination === 'timed-out'
      ? '超时终止'
      : detail.exitCode === null ? '未正常退出' : `退出码 ${detail.exitCode}`;
    return (
      <div className="activity-result">
        <div className="activity-result-meta">
          <code className="activity-command-line">{detail.command}</code>
          <span>{outcome}</span>
        </div>
        <p className="activity-result-meta" title={detail.workingDirectory}>
          <code>{detail.workingDirectory}</code>
        </p>
        <CommandStreams detail={detail} />
        {detail.note !== undefined && <p className="activity-result-note">{detail.note}</p>}
      </div>
    );
  }

  if (detail.kind === 'file-content') {
    return (
      <div className="activity-result activity-file-content">
        <div className="activity-result-meta" title={detail.filePath}>
          <code>{detail.filePath}</code>
          <span>{detail.totalLines === 0 ? '0 行' : `第 ${detail.startLine}-${detail.endLine} 行，共 ${detail.totalLines} 行`}</span>
        </div>
        {detail.lines.length === 0 ? (
          <p className="activity-result-empty">文件为空</p>
        ) : (
          <ol className="activity-code-lines" start={detail.startLine}>
            {detail.lines.map((line, index) => <li key={`${detail.startLine + index}:${line}`}><code>{line || ' '}</code></li>)}
          </ol>
        )}
        {detail.note !== undefined && <p className="activity-result-note">{detail.note}</p>}
      </div>
    );
  }

  if (detail.kind === 'directory') {
    return (
      <div className="activity-result">
        <div className="activity-result-meta" title={detail.directory}>
          <code>{detail.directory}</code>
          <span>共 {detail.total} 项</span>
        </div>
        {detail.entries.length === 0 ? (
          <p className="activity-result-empty">目录为空</p>
        ) : (
          <ul className="activity-directory-entries">
            {detail.entries.map((entry) => (
              <li key={entry.path} title={entry.path}>
                <span className="activity-entry-mark" aria-hidden="true">{entry.type === 'directory' ? '/' : '·'}</span>
                <code>{entry.name}{entry.type === 'directory' ? '/' : ''}</code>
              </li>
            ))}
          </ul>
        )}
        {detail.note !== undefined && <p className="activity-result-note">{detail.note}</p>}
      </div>
    );
  }

  return (
    <div className="activity-result">
      <div className="activity-result-meta" title={detail.directory}>
        <span>搜索 <code>{detail.pattern}</code></span>
        <span>找到 {detail.total} 处</span>
      </div>
      {detail.matches.length === 0 ? (
        <p className="activity-result-empty">没有匹配内容</p>
      ) : (
        <ul className="activity-search-matches">
          {detail.matches.map((match, index) => (
            <li key={`${match.filePath}:${match.lineNumber}:${index}`}>
              <code className="activity-match-location" title={match.filePath}>{match.filePath}:{match.lineNumber}</code>
              <code className="activity-match-line">{match.line || ' '}</code>
            </li>
          ))}
        </ul>
      )}
      {detail.note !== undefined && <p className="activity-result-note">{detail.note}</p>}
    </div>
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
  const summary = processSummary(items, isProcessing);
  const [fileError, setFileError] = useState<{ readonly id: string; readonly message: string } | null>(null);
  const [expandedResults, setExpandedResults] = useState<ReadonlySet<string>>(() => new Set());

  const reveal = (id: string, path: string) => {
    void onRevealFile(path).then(
      () => setFileError(null),
      (error: unknown) => setFileError({
        id,
        message: error instanceof Error ? error.message : '无法定位该文件。',
      }),
    );
  };

  const toggleResult = (id: string) => {
    setExpandedResults((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="agent-activity" aria-label="执行过程">
      <button
        className="activity-heading activity-toggle"
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? `收起执行过程，共 ${summary}` : `展开执行过程，共 ${summary}`}
        onClick={onToggle}
      >
        <span>{summary}</span>
        <svg className="activity-chevron" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {expanded && (
        <ol className="activity-list">
          {items.map((item) => {
            if (item.kind === 'commentary') return <li key={item.id} className="activity-commentary">{item.text}</li>;
            const detail = activityDetail(item);
            const inputFiles = item.files?.filter((file) => file.role === 'input') ?? [];
            const outputFiles = item.files?.filter((file) => file.role === 'output') ?? [];
            const resultExpanded = item.detail !== undefined && expandedResults.has(item.id);
            return (
              <li key={item.id} className={`activity-row row-${item.status}`}>
                <div className="activity-row-main">
                  <ActivityMark item={item} />
                  <div className="activity-copy">
                    <strong>{activityLabel(item)}</strong>
                    {detail !== undefined && <span className="activity-separator" aria-hidden="true" />}
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
                  {item.retryNote !== undefined && <span className="activity-note">{item.retryNote}</span>}
                  <span className={`activity-status state-${item.status}`}>
                    <span>{STATUS_LABELS[item.status]}</span>
                    {item.durationMs !== undefined && <span>{formatDuration(item.durationMs)}</span>}
                  </span>
                  {item.detail !== undefined && (
                    <button
                      className="activity-result-toggle"
                      type="button"
                      aria-expanded={resultExpanded}
                      aria-label={resultExpanded ? `收起 ${activityLabel(item)} 结果` : `展开 ${activityLabel(item)} 结果`}
                      onClick={() => toggleResult(item.id)}
                    >
                      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
                    </button>
                  )}
                </div>
                {fileError?.id === item.id && (
                  <p className="activity-file-error" role="status">{fileError.message}</p>
                )}
                {resultExpanded && item.detail !== undefined && <ActivityResultDetail detail={item.detail} />}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
