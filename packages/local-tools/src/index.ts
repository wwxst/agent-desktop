/**
 * `@agent-desktop/local-tools` 的唯一职责是实现本地文件与进程工具。
 *
 * 它不持有 Session、不选模型、不编排任务，也不承担宿主权限管理：
 * 需要宿主决定的目录访问一律通过调用方注入的端口回调。
 */
export { SetWorkingDirectoryTool } from './workspace.js';
export type { ApprovalTarget, WorkspacePort } from './workspace.js';
