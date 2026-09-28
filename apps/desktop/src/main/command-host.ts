import { join } from 'node:path';
import type { AgentActivityDetail } from '@agent-desktop/client';
import { createCommandOutputBuffer, type CommandPort } from '@agent-desktop/local-tools';
import type { ToolProgressEvent } from '@agent-desktop/tools';

/**
 * 子进程只拿到运行工具链所需的基础变量。
 *
 * 这里刻意不使用 `process.env`：宿主进程里的模型密钥属于设置，
 * 不应随命令注入到子进程。这也减少意外暴露，但不把同用户权限进程描述成安全边界。
 */
const BASE_ENVIRONMENT_KEYS = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'NUMBER_OF_PROCESSORS',
  'OS',
  'PROCESSOR_ARCHITECTURE',
] as const;

/** 实时输出按约 50 毫秒合并成一批，避免每个输出块都触发一次跨进程消息。 */
const FLUSH_INTERVAL_MS = 50;

/**
 * 宿主解析并固定的命令执行边界。
 *
 * 解释器绝对路径由宿主给出，因此工具不搜索 PATH，也不静默在多个解释器之间切换。
 */
export function createCommandPort(): CommandPort {
  const systemRoot = process.env.SystemRoot;
  // 解析不到系统目录时不猜一个可能错误的路径，直接失败让问题可见。
  if (systemRoot === undefined) throw new Error('SystemRoot 未设置，无法解析命令解释器路径。');

  const environment: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }

  return {
    interpreterPath: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    environment,
  };
}

/**
 * 命令实时输出的宿主侧投影。
 *
 * 它把小块合并成约 50 毫秒一批，并用与工具最终结果相同的保留预算限制累积量：
 * 输出速度不会因为界面消费速度而阻塞子进程，界面缓存也不会随输出无限增长。
 */
export class CommandOutputProjection {
  private stdout = createCommandOutputBuffer();
  private stderr = createCommandOutputBuffer();
  private timer: NodeJS.Timeout | undefined;
  private activityId: string | undefined;
  private command = '';

  public constructor(
    private readonly publish: (activityId: string, detail: AgentActivityDetail) => void,
  ) {}

  public push(activityId: string, command: string, event: ToolProgressEvent): void {
    // 工具串行执行，但换到另一条命令前必须先结清上一批，避免输出串到别的工具行。
    if (this.activityId !== activityId) {
      this.flush();
      this.stdout = createCommandOutputBuffer();
      this.stderr = createCommandOutputBuffer();
      this.activityId = activityId;
      this.command = command;
    }
    (event.stream === 'stdout' ? this.stdout : this.stderr).append(event.text);

    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, FLUSH_INTERVAL_MS);
    }
  }

  /** 结清尚未推送的输出：进度不能被静默丢弃，取消后的展示快照也要包含它。 */
  public flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.activityId === undefined) return;

    this.publish(this.activityId, {
      kind: 'command-output',
      command: this.command,
      stdout: this.stdout.text(),
      stderr: this.stderr.text(),
      truncated: this.stdout.truncated() || this.stderr.truncated(),
      droppedBytes: this.stdout.droppedBytes() + this.stderr.droppedBytes(),
    });
  }
}
