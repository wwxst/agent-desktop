import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { candidateDigest } from './candidate-digest.js';
import type { ToolCallId, ToolResult } from '@agent-desktop/model';
import { SessionPersistenceError, type SessionEvent } from '@agent-desktop/session';
import { executePreparedAction, resolveToolContract, ToolExecutionError, type Tool, type ToolContract, type ToolExecutionContext, type ToolPreparation } from '@agent-desktop/tools';
import { createFileArtifact } from '@agent-desktop/local-tools';
import {
  DECLARE_VIDEO_OUTPUTS_TOOL,
  PUBLISH_VIDEO_OUTPUT_TOOL,
  VALIDATE_VIDEO_CANDIDATE_TOOL,
  latestValidationForCandidate,
  latestValidationForItem,
  readVideoDeliveryFacts,
  videoToolCallKey,
  type Candidate,
  type CandidateValidation,
  type OutputItem,
  type OutputRequirement,
  type OutputTarget,
  type PublishedOutput,
  type RequirementCheck,
} from './delivery.js';

/**
 * 视频交付的应用工具与写出边界。
 *
 * 业务标识、工作目录、实际路径、生产调用归属和检查结论全部由这里产生；模型只能提交
 * 声明内容与候选路径，不能提交「通过」结论，也不能指定更宽松的发布条件。
 *
 * 候选路径是唯一由模型提交的引用：应用层用它反查真实写出结果与检查证据，
 * 因此模型无法用别的文件、别的候选或别的输出项的检查结果冒充本候选的证据。
 */

/** 读取当前会话事实的只读端口；由应用层组装时注入，工具自己不持有会话。 */
export type SessionReader = () => readonly SessionEvent[];

/** 当前会写出候选文件的视频工具；只有它们的成功结果可以建立候选。 */
export const VIDEO_WRITE_TOOL_NAMES = new Set([
  'trim_video',
  'concat_videos',
  'add_audio',
  'add_subtitles',
  'resize_video',
  'crop_video',
  'set_speed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResult(error: unknown): ToolResult {
  // 只把标准 Error 转为 Tool 失败；取消和非 Error 抛出值属于控制流或程序错误，继续向上暴露。
  if (!(error instanceof Error)) throw error;
  if (error.name === 'AbortError') throw error;
  if (error instanceof SessionPersistenceError) throw error;
  return { status: 'error', message: error.message,
    ...(error instanceof ToolExecutionError ? { failureKind: error.failureKind } : {}) };
}

/** 最近开始的轮次；声明「每轮最多一次」的判定依赖它。 */
function latestTurnId(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn.started') return event.turnId;
  }
  return undefined;
}

/** 判断一个路径是否严格落在某个目录内部；相等不算内部。 */
export async function resolveThroughExistingParent(filePath: string): Promise<string> {
  let currentPath = resolve(filePath);
  const missingParts: string[] = [];

  while (true) {
    try {
      const existingPath = await realpath(currentPath);
      return resolve(existingPath, ...missingParts.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parentPath = parse(currentPath).dir;
      if (parentPath === currentPath) throw error;
      missingParts.push(parse(currentPath).base);
      currentPath = parentPath;
    }
  }
}

export async function isInsideDirectory(childPath: string, parentPath: string): Promise<boolean> {
  const [realChildPath, realParentPath] = await Promise.all([
    resolveThroughExistingParent(childPath),
    realpath(resolve(parentPath)),
  ]);
  const relativePath = relative(realParentPath, realChildPath);
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

/** 默认首选路径由选定来源推导，不改变输入语义，也不占用全局序号。 */
function defaultPreferredPath(sourcePath: string): string {
  const parsed = parse(sourcePath);
  return join(parsed.dir, `${parsed.name}-edited${parsed.ext || '.mp4'}`);
}

/** 默认目标的第 n 个候选名称；名称是否可用由发布时的独占创建决定。 */
function automaticTargetPath(preferredPath: string, sequence: number): string {
  if (sequence === 1) return preferredPath;
  const parsed = parse(preferredPath);
  return join(parsed.dir, `${parsed.name}-${sequence}${parsed.ext || '.mp4'}`);
}

/** 模型输入属于真实边界：解析结果要么是可用值，要么是一条可回给模型的错误说明。 */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

function parseTarget(value: unknown): Parsed<OutputTarget> {
  if (!isRecord(value)) return { ok: false, message: 'target 必须是对象' };
  if (value.kind === 'automatic') return { ok: true, value: { kind: 'automatic', preferredPath: '' } };
  if (value.kind === 'explicit') {
    if (typeof value.path !== 'string' || value.path.length === 0) {
      return { ok: false, message: 'explicit 目标必须给出 path' };
    }
    if (!isAbsolute(value.path)) return { ok: false, message: `明确目标必须使用绝对路径：${value.path}` };
    return { ok: true, value: { kind: 'explicit', path: resolve(value.path) } };
  }
  return { ok: false, message: 'target.kind 只能是 explicit 或 automatic' };
}

function parseRequirements(value: unknown): Parsed<readonly OutputRequirement[]> {
  if (value === undefined) return { ok: true, value: [] };
  if (!Array.isArray(value)) return { ok: false, message: 'requirements 必须是数组' };

  const requirements: OutputRequirement[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return { ok: false, message: 'requirements 的每一项必须是对象' };
    // 要求 id 由应用层生成，模型不能自行指定或复用。
    const id = `r${requirements.length + 2}`;
    if (raw.kind === 'no-black-segments') {
      requirements.push({ id, kind: 'no-black-segments' });
      continue;
    }
    if (raw.kind === 'semantic') {
      if (typeof raw.description !== 'string' || raw.description.length === 0) {
        return { ok: false, message: 'semantic 要求必须给出 description' };
      }
      requirements.push({ id, kind: 'semantic', description: raw.description });
      continue;
    }
    if (raw.kind === 'duration-range') {
      if (typeof raw.minSeconds !== 'number' || typeof raw.maxSeconds !== 'number'
        || !Number.isFinite(raw.minSeconds) || !Number.isFinite(raw.maxSeconds)
        || raw.minSeconds <= 0 || raw.maxSeconds < raw.minSeconds) {
        return { ok: false, message: 'duration-range 要求必须给出有效的 minSeconds 与 maxSeconds' };
      }
      requirements.push({ id, kind: 'duration-range', minSeconds: raw.minSeconds, maxSeconds: raw.maxSeconds });
      continue;
    }
    return { ok: false, message: `不支持的要求类型：${String(raw.kind)}` };
  }
  return { ok: true, value: requirements };
}

/**
 * 声明本轮要交付的视频输出项集合。
 *
 * 声明列表就是预期交付集合：不额外插入从首个附件推导的最终路径，也不默认要求多视频合并。
 */
export class DeclareVideoOutputsTool implements Tool {
  readonly contract = { approvalRequirement: 'none' } as const;
  readonly name = DECLARE_VIDEO_OUTPUTS_TOOL;
  // 目录创建是声明阶段唯一的宿主副作用；在 mkdir 前持久化检查点，保存失败时不创建目录。
  readonly executionBoundary = 'checkpointed' as const;
  readonly description = '声明本轮要交付的视频输出项集合（来源、目标与必要要求）；写出候选前必须先声明';
  readonly inputSchema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            sourcePaths: { type: 'array', items: { type: 'string' }, minItems: 1 },
            target: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['explicit', 'automatic'] },
                path: { type: 'string' },
              },
              required: ['kind'],
              additionalProperties: false,
            },
            requirements: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: ['duration-range', 'no-black-segments', 'semantic'] },
                  minSeconds: { type: 'number' },
                  maxSeconds: { type: 'number' },
                  description: { type: 'string' },
                },
                required: ['kind'],
                additionalProperties: false,
              },
            },
          },
          required: ['sourcePaths', 'target'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };

  constructor(private readonly readEvents: SessionReader) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    if (!isRecord(input) || !Array.isArray(input.items) || input.items.length === 0) {
      return { status: 'error', message: 'declare_video_outputs 需要非空的 items 数组' };
    }

    const events = this.readEvents();
    const facts = readVideoDeliveryFacts(events);
    const turnId = latestTurnId(events);
    if (turnId !== undefined && facts.declarationTurnId === turnId) {
      return {
        status: 'error',
        message: '本轮已经声明过输出项；需要改变目标或要求时请开始新一轮。',
      };
    }

    const items: OutputItem[] = [];
    const explicitTargets = new Set<string>();

    for (const raw of input.items) {
      if (!isRecord(raw)
        || !Array.isArray(raw.sourcePaths)
        || raw.sourcePaths.length === 0
        || !raw.sourcePaths.every((path) => typeof path === 'string' && path.length > 0)) {
        return { status: 'error', message: '每个输出项都必须给出非空的 sourcePaths 字符串数组' };
      }

      const sourcePaths = (raw.sourcePaths as string[]).map((path) => resolve(path));
      const parsedTarget = parseTarget(raw.target);
      if (!parsedTarget.ok) return { status: 'error', message: parsedTarget.message };
      const target = parsedTarget.value;

      const parsedRequirements = parseRequirements(raw.requirements);
      if (!parsedRequirements.ok) return { status: 'error', message: parsedRequirements.message };
      const requirements = parsedRequirements.value;

      // 目标目录：明确路径用它的父目录，默认目标用选定来源的目录。
      const targetPath = target.kind === 'explicit' ? target.path : defaultPreferredPath(sourcePaths[0]!);
      const resolvedTarget: OutputTarget = target.kind === 'explicit'
        ? target
        : { kind: 'automatic', preferredPath: targetPath };

      if (target.kind === 'explicit') {
        if (explicitTargets.has(targetPath)) {
          return { status: 'error', message: `同一声明中有两个输出项指向同一路径：${targetPath}` };
        }
        explicitTargets.add(targetPath);
      }

      const itemId = `out-${randomUUID().slice(0, 8)}`;
      // 工作目录名不使用最终交付序号；它只用于定位候选并限制视频工具写出位置。
      const workingDirectory = join(parse(targetPath).dir, `.agent-output-${itemId}`);
      items.push({
        id: itemId,
        sourcePaths,
        target: resolvedTarget,
        workingDirectory,
        // 全文件解码由应用层自动加入，模型不能删除；它是所有视频成片的必要条件。
        requirements: [{ id: 'r1', kind: 'decodable-video' }, ...requirements],
      });
    }

    // 所有模型输入都通过解析后，才创建任何工作目录；声明失败不会留下部分目录。
    context.checkpoint?.({ kind: 'video-output-directory', paths: items.map((item) => item.workingDirectory) });
    for (const item of items) await mkdir(item.workingDirectory, { recursive: true });

    return { status: 'success', output: { kind: 'video.outputs.declared', items } };
  }
}

/** 会话里 tool.called 记录的调用名；Trace 不复制工具内容，工具名只能从这里读。 */
function collectToolNames(events: readonly SessionEvent[]): Map<string, string> {
  const toolNames = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'tool.called') toolNames.set(videoToolCallKey(event), event.name);
  }
  return toolNames;
}

interface SuccessfulProducer {
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly input: unknown;
  readonly calledIndex: number;
  readonly resultIndex: number;
  readonly outputPath: string;
}

function collectSuccessfulProducers(
  events: readonly SessionEvent[],
  toolNames: Map<string, string>,
): readonly SuccessfulProducer[] {
  const calls = new Map<string, { readonly input: unknown; readonly calledIndex: number }>();
  const producers: SuccessfulProducer[] = [];

  events.forEach((event, index) => {
    if (event.type === 'tool.called') {
      calls.set(videoToolCallKey(event), { input: event.input, calledIndex: index });
      return;
    }
    if (event.type !== 'tool.result' || event.result.status !== 'success') return;
    const name = toolNames.get(videoToolCallKey(event));
    const call = calls.get(videoToolCallKey(event));
    if (name === undefined || call === undefined || !VIDEO_WRITE_TOOL_NAMES.has(name)) return;
    if (!isRecord(event.result.output) || typeof event.result.output.outputPath !== 'string') return;
    producers.push({
      toolCallId: event.toolCallId,
      name,
      input: call.input,
      calledIndex: call.calledIndex,
      resultIndex: index,
      outputPath: resolve(event.result.output.outputPath),
    });
  });

  return producers;
}

function producerInputPaths(producer: SuccessfulProducer): readonly string[] | undefined {
  if (!isRecord(producer.input)) return undefined;
  if (producer.name === 'concat_videos') {
    return Array.isArray(producer.input.inputPaths)
      && producer.input.inputPaths.every((path) => typeof path === 'string')
      ? producer.input.inputPaths as string[]
      : undefined;
  }
  const inputField = producer.name === 'add_audio' || producer.name === 'add_subtitles'
    ? 'videoPath'
    : 'inputPath';
  return typeof producer.input[inputField] === 'string'
    ? [producer.input[inputField] as string]
    : undefined;
}

function sourcePathsForProducer(
  producer: SuccessfulProducer,
  producers: readonly SuccessfulProducer[],
  visiting: ReadonlySet<number> = new Set(),
): readonly string[] | undefined {
  // 事件索引唯一标识一次生产；跨步骤复用模型调用 ID 不是来源链循环。
  if (visiting.has(producer.calledIndex)) return undefined;
  const inputPaths = producerInputPaths(producer);
  if (inputPaths === undefined) return undefined;

  const nextVisiting = new Set(visiting);
  nextVisiting.add(producer.calledIndex);
  const sourcePaths = new Set<string>();
  for (const inputPath of inputPaths) {
    const inputAbsolutePath = resolve(inputPath);
    let previousProducer: SuccessfulProducer | undefined;
    for (const candidate of producers) {
      if (candidate.resultIndex < producer.calledIndex
        && candidate.outputPath === inputAbsolutePath
        && (previousProducer === undefined || candidate.resultIndex > previousProducer.resultIndex)) {
        previousProducer = candidate;
      }
    }
    if (previousProducer === undefined) {
      sourcePaths.add(inputAbsolutePath);
      continue;
    }
    const previousSources = sourcePathsForProducer(previousProducer, producers, nextVisiting);
    if (previousSources === undefined) return undefined;
    for (const sourcePath of previousSources) sourcePaths.add(sourcePath);
  }
  return [...sourcePaths];
}

function producerMatchesSources(
  producer: SuccessfulProducer,
  item: OutputItem,
  producers: readonly SuccessfulProducer[],
): boolean {
  const actual = sourcePathsForProducer(producer, producers);
  if (actual === undefined) return false;
  const expected = new Set(item.sourcePaths.map((path) => resolve(path)));
  return actual.length === expected.size && actual.every((path) => expected.has(path));
}

/**
 * 找出写出本候选的那次成功生产调用。
 *
 * 归属按结构化 `outputPath` 判定，不从文字里提取路径，也不接受模型提交的调用标识：
 * 模型只需要给出候选路径，候选身份与生产调用由应用层核对。
 */
function findProducerToolCall(
  events: readonly SessionEvent[],
  toolNames: Map<string, string>,
  item: OutputItem,
  candidatePath: string,
): SuccessfulProducer | undefined {
  const producers = collectSuccessfulProducers(events, toolNames);
  let found: SuccessfulProducer | undefined;
  for (const producer of producers) {
    if (producer.outputPath !== candidatePath) continue;
    if (found === undefined || producer.resultIndex > found.resultIndex) found = producer;
  }
  // 同路径已被最新成功调用覆盖时，不能回退较旧的来源匹配记录授予权限或通过验收。
  return found !== undefined && producerMatchesSources(found, item, producers) ? found : undefined;
}

/** 宿主授权候选读取时复用交付的生产归属；单独声明目录不能授予文件权限。 */
export function producedVideoItem(events: readonly SessionEvent[], candidatePath: string): OutputItem | undefined {
  const names = collectToolNames(events);
  return readVideoDeliveryFacts(events).items.find(item => findProducerToolCall(events, names, item, resolve(candidatePath)) !== undefined);
}

/**
 * 找出针对本候选的一次真实检查证据。
 *
 * 直接媒体检查的实际输入路径必须与候选路径一致，因此源视频、别的候选或别的输出项的
 * 检查结果都不会被当成当前候选的证据。
 */
function findCheckEvidence(
  events: readonly SessionEvent[],
  toolNames: Map<string, string>,
  toolName: string,
  candidatePath: string,
  producerResultIndex: number,
  canonicalPath?: string,
): { readonly toolCallId: ToolCallId; readonly output: Record<string, unknown> } | undefined {
  let found: { readonly toolCallId: ToolCallId; readonly output: Record<string, unknown> } | undefined;
  for (let index = producerResultIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type !== 'tool.result' || event.result.status !== 'success') continue;
    if (toolNames.get(videoToolCallKey(event)) !== toolName) continue;
    if (!isRecord(event.result.output) || typeof event.result.output.inputPath !== 'string') continue;
    const checkedPath = resolve(event.result.output.inputPath);
    if (checkedPath !== candidatePath && checkedPath !== canonicalPath) continue;
    found = { toolCallId: event.toolCallId as ToolCallId, output: event.result.output };
  }
  return found;
}

function blocked(
  requirementId: string,
  reason: 'capability-unavailable' | 'insufficient-evidence',
  detail: string,
): RequirementCheck {
  return { requirementId, evidenceToolCallIds: [], detail, outcome: 'blocked', reason };
}

/** 逐条计算一项必要要求的检查结论；缺少证据时保留受阻而不是省略。 */
function checkRequirement(
  requirement: OutputRequirement,
  candidatePath: string,
  events: readonly SessionEvent[],
  toolNames: Map<string, string>,
  producerResultIndex: number,
  digest: string,
  outputItemId: string,
  canonicalPath: string,
): RequirementCheck {
  switch (requirement.kind) {
    case 'decodable-video': {
      const found = findCheckEvidence(events, toolNames, 'decode_video', candidatePath, producerResultIndex, canonicalPath);
      if (found === undefined) {
        return blocked(requirement.id, 'insufficient-evidence', '缺少本候选的全文件解码检查证据。');
      }
      const decoded = found.output.hasVideoStream === true && found.output.fullyDecoded === true;
      return {
        requirementId: requirement.id,
        evidenceToolCallIds: [found.toolCallId],
        outcome: decoded ? 'passed' : 'failed',
        detail: decoded
          ? '存在视频流，全文件解码完成。'
          : '文件缺少可用视频流，或无法完成全文件解码。',
      };
    }
    case 'duration-range': {
      // 插件返回宿主 realpath；保留候选引用路径也能消费 CLI 的原始路径结果。
      const found = findCheckEvidence(events, toolNames, 'probe_media', candidatePath, producerResultIndex, canonicalPath);
      if (found === undefined) {
        return blocked(requirement.id, 'insufficient-evidence', '缺少本候选的时长探测证据。');
      }
      const duration = found.output.duration;
      if (typeof duration !== 'number') {
        return {
          requirementId: requirement.id,
          evidenceToolCallIds: [found.toolCallId],
          outcome: 'blocked',
          reason: 'insufficient-evidence',
          detail: '探测结果没有给出可用时长，无法判断是否落在要求范围内。',
        };
      }
      const inRange = duration >= requirement.minSeconds && duration <= requirement.maxSeconds;
      return {
        requirementId: requirement.id,
        evidenceToolCallIds: [found.toolCallId],
        outcome: inRange ? 'passed' : 'failed',
        detail: `实际时长 ${duration} 秒，要求范围 ${requirement.minSeconds}–${requirement.maxSeconds} 秒。`,
      };
    }
    case 'no-black-segments': {
      const found = findCheckEvidence(
        events,
        toolNames,
        'detect_black_segments',
        candidatePath,
        producerResultIndex,
        canonicalPath,
      );
      if (found === undefined) {
        return blocked(requirement.id, 'insufficient-evidence', '缺少本候选的黑段检测证据。');
      }
      const clean = found.output.hasBlackSegments === false;
      return {
        requirementId: requirement.id,
        evidenceToolCallIds: [found.toolCallId],
        outcome: clean ? 'passed' : 'failed',
        detail: clean
          ? '在声明的检测参数下未检出黑段。'
          : '在声明的检测参数下检出了黑段区间。',
      };
    }
    case 'semantic': {
      const found = findCheckEvidence(events, toolNames, 'check_video_semantics', candidatePath, producerResultIndex);
      if (found === undefined) return blocked(requirement.id, 'insufficient-evidence', `内容要求「${requirement.description}」缺少本候选的语义检查。`);
      if (found.output.outputItemId !== outputItemId) return blocked(requirement.id, 'insufficient-evidence', '语义证据不属于当前输出项。');
      const checks = found.output.checks;
      const check: unknown = Array.isArray(checks) ? checks.find((entry: unknown) => isRecord(entry) && entry.requirementId === requirement.id) : undefined;
      if (!isRecord(check) || !['passed', 'failed', 'blocked'].includes(String(check.outcome))
        || typeof check.detail !== 'string' || !check.detail.trim()
        || (check.outcome === 'passed' && found.output.coverage !== 'all-frames-and-transcript')) {
        return blocked(requirement.id, 'insufficient-evidence', '语义证据没有覆盖完整候选与本项要求。');
      }
      // Probe 缺失或被拒绝时尚未读取候选摘要；保留明确的阻塞原因，不能误报候选被修改。
      if (found.output.candidateSha256 === undefined && check.outcome === 'blocked' && found.output.coverage === 'incomplete') {
        return blocked(requirement.id, 'insufficient-evidence', check.detail);
      }
      if (found.output.candidateSha256 !== digest) return blocked(requirement.id, 'insufficient-evidence', '语义证据对应的候选内容已经改变。');
      return { requirementId: requirement.id, evidenceToolCallIds: [found.toolCallId], detail: check.detail,
        ...(check.outcome === 'blocked' ? { outcome: 'blocked', reason: 'insufficient-evidence' } : { outcome: check.outcome as 'passed' | 'failed' }) };
    }
  }
}

/**
 * 从成功生产结果建立候选，并用真实证据逐条验收。
 *
 * 模型只提交输出项与候选路径：生产调用、候选身份、证据归属和检查结论都由应用层核对，
 * 因此模型既不能提交「通过」结论，也不能拿别的文件或别的输出项的检查结果冒充本候选证据。
 */
export class ValidateVideoCandidateTool implements Tool {
  readonly contract = { approvalRequirement: 'none' } as const;
  readonly name = VALIDATE_VIDEO_CANDIDATE_TOOL;
  // 验收只读取候选和已有证据；补齐检查事实后必须允许对同一候选重新验收。
  readonly executionBoundary = 'read-only' as const;
  readonly description = '验收某个输出项的候选文件：按候选路径核对真实写出结果与检查证据，缺少证据的要求记为受阻';
  readonly inputSchema = {
    type: 'object',
    properties: {
      outputItemId: { type: 'string' },
      candidatePath: { type: 'string' },
    },
    required: ['outputItemId', 'candidatePath'],
    additionalProperties: false,
  };

  constructor(private readonly readEvents: SessionReader) {}

  async execute(input: unknown): Promise<ToolResult> {
    if (!isRecord(input)
      || typeof input.outputItemId !== 'string'
      || typeof input.candidatePath !== 'string'
      || input.candidatePath.length === 0) {
      return {
        status: 'error',
        message: 'validate_video_candidate 需要 outputItemId 和 candidatePath 字符串',
      };
    }

    const events = this.readEvents();
    const facts = readVideoDeliveryFacts(events);
    const item = facts.items.find((candidateItem) => candidateItem.id === input.outputItemId);
    if (item === undefined) {
      return { status: 'error', message: `找不到输出项：${input.outputItemId}` };
    }

    const candidatePath = resolve(input.candidatePath);
    // 跨输出项目录中的文件不能直接冒充本项候选。
    if (!(await isInsideDirectory(candidatePath, item.workingDirectory))) {
      return {
        status: 'error',
        message: `候选文件不在该输出项的工作目录内：${candidatePath}`,
      };
    }

    // 候选必须来自一次成功写出该文件的生产调用，不能只凭磁盘上有文件或模型给出一条路径。
    const toolNames = collectToolNames(events);
    const producer = findProducerToolCall(events, toolNames, item, candidatePath);
    if (producer === undefined) {
      return {
        status: 'error',
        message: `找不到来源匹配的成功生产调用：${candidatePath}`,
      };
    }

    // 只复用最近生产之后的验收身份；同路径与调用 ID 再次出现仍是新的生产事实。
    const existing = readVideoDeliveryFacts(events.slice(producer.resultIndex + 1)).candidates.find((candidate) => (
      candidate.outputItemId === item.id
      && candidate.path === candidatePath
      && candidate.producerToolCallId === producer.toolCallId
    ));
    const candidate: Candidate = existing ?? {
      id: `candidate-${randomUUID().slice(0, 8)}`,
      outputItemId: item.id,
      path: candidatePath,
      producerToolCallId: producer.toolCallId,
    };

    const digest = await candidateDigest(candidatePath);
    const canonicalPath = await realpath(candidatePath);
    const checks = item.requirements.map((requirement) => (
      checkRequirement(requirement, candidatePath, events, toolNames, producer.resultIndex, digest, item.id, canonicalPath)
    ));

    const validation: CandidateValidation = {
      id: `validation-${randomUUID().slice(0, 8)}`,
      candidateId: candidate.id,
      candidateSha256: digest,
      checks,
    };

    return {
      status: 'success',
      output: { kind: 'video.candidate.validated', candidate, validation },
    };
  }
}

/**
 * 独占创建目标后复制候选。
 *
 * 目标已存在时由 `wx` 直接拒绝，目标在审批前已经固定，冲突不能批准后改名；
 * 复制未完成时清理本次调用创建的目标，并把清理失败如实暴露。
 */
async function copyExclusively(
  sourcePath: string,
  targetPath: string,
  signal: AbortSignal | undefined,
  checkpoint: ToolExecutionContext['checkpoint'],
): Promise<void> {
  // 保存检查点失败时不创建目标；已存在目标保持永久拒绝，不尝试未获批的新路径。
  checkpoint?.({ kind: 'video-publish', targetPath });
  // open 在 try 之外：创建失败说明目标不属于本次调用，不能去删除已有文件。
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(targetPath, 'wx');
  } catch (error) {
    // 目标冲突证明本次调用没有创建文件；调用方保留永久拒绝，不尝试其他名称。
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolExecutionError(`发布目标已存在：${targetPath}`, 'permanent', { cause: error });
    if (error instanceof Error) throw new ToolExecutionError(error.message, 'permanent', { cause: error });
    throw error;
  }
  try {
    const sink = handle.createWriteStream({ autoClose: true });
    if (signal === undefined) await pipeline(createReadStream(sourcePath), sink);
    else await pipeline(createReadStream(sourcePath), sink, { signal });
  } catch (error) {
    // 未完成的目标不能被登记为交付，也不能留给后续自动覆盖。
    await handle.close().catch(() => undefined);
    try {
      await unlink(targetPath);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ToolExecutionError(`发布未完成，且无法清理未完成的目标文件：${targetPath}`, 'unknown-outcome', { cause: cleanupError });
      }
    }
    if (error instanceof Error && error.name !== 'AbortError') {
      throw new ToolExecutionError(error.message, 'permanent', { cause: error });
    }
    throw error;
  }
}

/**
 * 发布某个输出项的候选。
 *
 * 只接受验收引用：目标、要求与候选都由应用层从已有事实反查，模型不能在发布时放宽条件。
 */
export type VideoPublishApproval = (
  target: { readonly candidatePath: string; readonly targetPath: string }, context: ToolExecutionContext,
) => Promise<boolean>;

export class PublishVideoOutputTool implements Tool {
  readonly contract = { approvalRequirement: 'policy' } as const;
  readonly name = PUBLISH_VIDEO_OUTPUT_TOOL;
  // 发布前的目标复制是可核验的外部副作用，实际复制前保存检查点。
  readonly executionBoundary = 'checkpointed' as const;
  readonly description = '把通过全项验收的候选发布为最终交付文件；未全部通过或缺少证据时拒绝发布';
  readonly inputSchema = {
    type: 'object',
    properties: { validationId: { type: 'string' } },
    required: ['validationId'],
    additionalProperties: false,
  };

  constructor(private readonly readEvents: SessionReader, private readonly approve?: VideoPublishApproval) {}

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    return executePreparedAction(await this.prepare(input, context), context);
  }

  async prepare(input: unknown, context: ToolExecutionContext): Promise<ToolPreparation> {
    if (!isRecord(input) || typeof input.validationId !== 'string') {
      return { status: 'error', message: 'publish_video_output 需要 validationId 字符串' };
    }

    try {
      const facts = readVideoDeliveryFacts(this.readEvents());
      const validation = facts.validations.find((item) => item.id === input.validationId);
      if (validation === undefined) {
        return { status: 'error', message: `找不到验收记录：${input.validationId}` };
      }

      const candidate = facts.candidates.find((item) => item.id === validation.candidateId);
      if (candidate === undefined) {
        return { status: 'error', message: `找不到候选文件：${validation.candidateId}` };
      }

      const item = facts.items.find((candidateItem) => candidateItem.id === candidate.outputItemId);
      if (item === undefined) {
        return { status: 'error', message: `找不到输出项：${candidate.outputItemId}` };
      }

      // 发布只接受当前候选的最新验收；旧验收不能批准新候选，也不能绕过当前不通过结果。
      if (latestValidationForCandidate(facts, candidate.id)?.id !== validation.id) {
        return { status: 'error', message: '该验收不是当前候选的最新一次验收，不能用于发布。' };
      }
      if (latestValidationForItem(facts, item.id)?.candidateId !== candidate.id) {
        return { status: 'error', message: '该候选不是本输出项当前送验的候选，不能用于发布。' };
      }

      const blocking = validation.checks.filter((check) => check.outcome !== 'passed');
      if (blocking.length > 0) {
        return {
          status: 'error',
          message: `验收未全部通过，不能发布：${blocking.map((check) => check.detail).join('；')}`,
        };
      }

      if (facts.published.some((output) => output.outputItemId === item.id)) {
        return { status: 'error', message: '该输出项已经交付，不能重复发布。' };
      }

      const candidateStat = await stat(candidate.path);
      if (!candidateStat.isFile()) {
        return { status: 'error', message: `候选路径不是文件：${candidate.path}` };
      }

      if (validation.candidateSha256 === undefined || await candidateDigest(candidate.path, context.signal) !== validation.candidateSha256) {
        return { status: 'error', message: '候选内容与验收时不一致，必须重新验收后发布。' };
      }

      // 自动命名在审批前固定；获批后冲突只能失败，不能改为另一个未获批路径。
      let publishedPath = '';
      for (let sequence = 1; ; sequence += 1) {
        const target = item.target.kind === 'explicit' ? item.target.path : automaticTargetPath(item.target.preferredPath, sequence);
        const path = await resolveThroughExistingParent(target);
        try { await lstat(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          publishedPath = path;
          break;
        }
        if (item.target.kind === 'explicit') return { status: 'error', failureKind: 'permanent', message: `目标文件已存在，不会覆盖也不会改名：${path}` };
      }
      const approve = this.approve;
      if (approve === undefined) return { status: 'error', failureKind: 'permanent', message: '发布视频缺少宿主审批入口。' };
      return {
        requestApproval: () => approve({ candidatePath: candidate.path, targetPath: publishedPath }, context),
        execute: async () => {
          try {
            if (await candidateDigest(candidate.path, context.signal) !== validation.candidateSha256) {
              return { status: 'error', failureKind: 'permanent', message: '候选在审批期间改变，必须重新验收。' };
            }
            if (await resolveThroughExistingParent(publishedPath) !== publishedPath) {
              return { status: 'error', failureKind: 'permanent', message: '交付目录在审批期间改变，必须重新准备发布。' };
            }
            try { await copyExclusively(candidate.path, publishedPath, context.signal, context.checkpoint); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { status: 'error', failureKind: 'permanent', message: `目标文件已存在，不会覆盖也不会改名：${publishedPath}` };
              throw error;
            }
            const output: PublishedOutput = { outputItemId: item.id, validationId: validation.id, path: publishedPath };
            return { status: 'success', output: { kind: 'video.output.published', output },
              artifacts: [await createFileArtifact(publishedPath, this.name, context.signal)] };
          } catch (error) { return errorResult(error); }
        },
      };
    } catch (error) {
      return errorResult(error);
    }
  }
}

/**
 * 视频写出边界：候选只能写进所属输出项的工作目录。
 *
 * 它由应用层组装时套在写出型视频工具外层，因此约束落在真实写出调用上，而不只写在提示词里；
 * 没有声明就写出会被拒绝，直接写最终目标或已有候选路径同样被拒绝。
 */
export class ScopedVideoOutputTool implements Tool {
  readonly prepare?: (input: unknown, context: ToolExecutionContext) => Promise<ToolPreparation>;
  readonly nestedToolNames?: readonly string[];

  constructor(
    private readonly inner: Tool,
    private readonly readEvents: SessionReader,
  ) {
    if (inner.nestedToolNames !== undefined) this.nestedToolNames = inner.nestedToolNames;
    // 包装器不制造内层缺失的审批能力；无效策略工具仍由 Router 在调用前排除。
    if (inner.prepare !== undefined || resolveToolContract(inner).approvalRequirement === 'none') {
      this.prepare = (input, context) => this.prepareScoped(input, context);
    }
  }

  get name(): string { return this.inner.name; }
  get description(): string { return this.inner.description; }
  get inputSchema(): unknown { return this.inner.inputSchema; }
  // 路径校验不增加副作用；保留实际媒体工具或插件钩子的执行边界。
  get executionBoundary() { return this.inner.executionBoundary ?? 'opaque'; }
  get contract(): Partial<ToolContract> { return this.inner.contract ?? {}; }
  // 没有内层投影时使用恒等函数，满足 exactOptionalPropertyTypes 且不改变调用参数。
  get sanitizeInput(): (input: unknown) => unknown { return this.inner.sanitizeInput ?? ((input: unknown) => input); }

  async execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult> {
    if (this.prepare === undefined) return { status: 'error', failureKind: 'permanent', message: `工具 ${this.inner.name} 缺少已准备操作契约。` };
    return executePreparedAction(await this.prepare(input, context), context);
  }

  private async prepareScoped(input: unknown, context: ToolExecutionContext): Promise<ToolPreparation> {
    const prepareInner = (): Promise<ToolPreparation> => {
      if (this.inner.prepare !== undefined) return this.inner.prepare(input, context);
      return Promise.resolve({ requestApproval: async () => true, execute: () => this.inner.execute(input, context) });
    };
    // 输入不是当前契约形状时交给内层工具返回它自己的字段错误，不在这里重复校验。
    const outputPath = isRecord(input) && typeof input.outputPath === 'string' ? input.outputPath : undefined;
    if (outputPath === undefined) return prepareInner();

    if (!isAbsolute(outputPath)) {
      return {
        status: 'error',
        failureKind: 'permanent',
        message: `候选文件必须使用绝对路径：${outputPath}`,
      };
    }

    const resolvedPath = resolve(outputPath);
    const facts = readVideoDeliveryFacts(this.readEvents());
    if (facts.items.length === 0) {
      return {
        status: 'error',
        failureKind: 'permanent',
        message: '本轮还没有声明视频输出项，不能写出候选文件；请先调用 declare_video_outputs。',
      };
    }

    const allowed = (await Promise.all(
      facts.items.map((item) => isInsideDirectory(resolvedPath, item.workingDirectory)),
    )).some(Boolean);
    if (!allowed) {
      return {
        status: 'error',
        failureKind: 'permanent',
        message: `候选文件必须写在本输出项的工作目录内，不能直接写到最终目标或其他位置：${resolvedPath}`,
      };
    }

    return prepareInner();
  }
}
