/**
 * `@agent-desktop/local-tools` 的唯一职责是实现本地文件与进程工具。
 *
 * 它不持有 Session、不选模型、不编排任务，也不承担宿主权限管理：
 * 需要宿主决定的操作（当前是目录访问、创建文件与修改文件）一律通过调用方注入的端口回调，
 * 读取范围由 `resolveScopedPath` 统一解析，工具自己不做字符串前缀判断。
 */
export {
  BoundedTextBuffer,
  createCommandOutputBuffer,
  RunCommandTool,
  type CommandOutcome,
  type CommandPort,
} from './command.js';
export { EditTextFileTool } from './edit-text-file.js';
export { createFileArtifact } from './artifact.js';
export { ApplyPatchTool } from './apply-patch.js';
export { GitReadTool, type GitReadToolName } from './git.js';
export { ListDirectoryTool } from './list-directory.js';
export { resolveCreatablePath, resolveScopedPath, type ScopedPath } from './path-scope.js';
export { ReadFileTool } from './read-file.js';
export { SearchTextTool, type RipgrepMatch, type RipgrepOutcome, type RipgrepRunner } from './search-text.js';
export { SetWorkingDirectoryTool } from './workspace.js';
export type { ApprovalTarget, WorkspacePort } from './workspace.js';
export { WriteTextFileTool } from './write-text-file.js';
