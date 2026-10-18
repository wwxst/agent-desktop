import type { PermissionMode } from '@agent-desktop/client';
import type { SessionEvent, TurnId } from '@agent-desktop/session';
import { parseStoredSettings, type snapshotRuntimeSettings } from './runtime-settings.js';

/** 会话事件中的公开执行配置；不含模型、OAuth 或插件凭据。 */
export interface TurnConfiguration {
  readonly settings: ReturnType<typeof snapshotRuntimeSettings>;
  readonly permissionMode: PermissionMode;
  readonly workingDirectory?: string;
  readonly executionBoundary: 'host-policy';
  /** 模型实际可见的工具集合；扩展重建后必须与原轮次一致。 */
  readonly toolNames?: readonly string[];
}

/** 数据来自持久化事件；恢复必须使用原配置，缺失或损坏时不能静默采用当前选择。 */
export function readTurnConfiguration(events: readonly SessionEvent[], turnId: TurnId): TurnConfiguration {
  const event = events.findLast(item => item.type === 'turn.configuration' && item.turnId === turnId);
  if (event?.type !== 'turn.configuration') throw new Error('原任务缺少有效配置快照，无法安全恢复；请重新提交任务。');
  return parseTurnConfiguration(event.data);
}

export function parseTurnConfiguration(value: unknown): TurnConfiguration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('任务配置快照无效。');
  const data = value as Record<string, unknown>;
  if (data.permissionMode !== 'ask' && data.permissionMode !== 'auto-review' && data.permissionMode !== 'full-access') throw new Error('任务审批策略快照无效。');
  if (data.executionBoundary !== 'host-policy') throw new Error('任务执行边界快照无效。');
  if (data.workingDirectory !== undefined && (typeof data.workingDirectory !== 'string' || !data.workingDirectory)) throw new Error('任务工作目录快照无效。');
  if (data.toolNames !== undefined) {
    if (!Array.isArray(data.toolNames) || data.toolNames.some(item => typeof item !== 'string' || item.trim() === '')
      || new Set(data.toolNames).size !== data.toolNames.length) throw new Error('任务工具集合快照无效。');
  }
  const settings = parseStoredSettings(data.settings);
  if (settings.modelProviders === undefined || settings.conversationModel === undefined || settings.conversationModel === null) throw new Error('任务模型配置快照不完整。');
  return { settings, permissionMode: data.permissionMode, executionBoundary: data.executionBoundary,
    ...(data.workingDirectory === undefined ? {} : { workingDirectory: data.workingDirectory as string }),
    ...(data.toolNames === undefined ? {} : { toolNames: [...data.toolNames as string[]] }) };
}

/**
 * 恢复前比较工具暴露事实；排序后比较避免注册顺序变化掩盖实际集合漂移。
 * unknown-effect 恢复只允许原集合的安全子集，外部能力已经被宿主主动收紧。
 */
export function assertTurnToolNames(configuration: TurnConfiguration, actual: readonly string[], restricted: boolean): void {
  if (configuration.toolNames === undefined) throw new Error('原任务缺少工具集合快照，无法安全恢复；请重新提交任务。');
  const expected = new Set(configuration.toolNames);
  const current = new Set(actual);
  const matches = restricted
    ? [...current].every(name => expected.has(name))
    : current.size === expected.size && [...current].every(name => expected.has(name));
  if (!matches) throw new Error('原任务的工具能力集合已变化，无法安全恢复；请重新提交任务。');
}
