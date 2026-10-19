import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallId, ToolResult } from '@agent-desktop/model';
import { candidateDigest } from '../src/candidate-digest.js';
import { InMemorySession, type StepId, type TurnId } from '@agent-desktop/session';
import type { Tool, ToolExecutionContext } from '@agent-desktop/tools';
import {
  DeclareVideoOutputsTool,
  PublishVideoOutputTool,
  ScopedVideoOutputTool,
  ValidateVideoCandidateTool,
} from '../src/delivery-tools.js';
import {
  projectOutputItemResults,
  readVideoDeliveryFacts,
  type OutputItemResult,
} from '../src/delivery.js';

const turnId = 'turn-1' as TurnId;
const stepId = 'step-1' as StepId;

const temporaryDirectories: string[] = [];
let callSequence = 0;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryDirectory(): Promise<string> {
  // Windows CI 的 TEMP 可能使用 8.3 短路径；夹具与发布事实统一使用真实路径。
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'agent-desktop-delivery-')));
  temporaryDirectories.push(directory);
  return directory;
}

/** 测试用的最小执行上下文：只提供当前用例真正使用的取消信号。 */
function toolContext(signal?: AbortSignal): ToolExecutionContext {
  return {
    toolCallId: 'test-call' as ToolCallId,
    reportProgress: () => {},
    ...(signal === undefined ? {} : { signal }),
  };
}

function newSession(): InMemorySession {
  return new InMemorySession([{ type: 'turn.started', turnId }]);
}

function nextCallId(): ToolCallId {
  callSequence += 1;
  return `call-${callSequence}` as ToolCallId;
}

/** 执行工具并像 Agent Loop 一样追加真实事件，让后续工具读到同一份会话事实。 */
async function runTool(
  session: InMemorySession,
  tool: Tool,
  input: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const toolCallId = nextCallId();
  session.append({ type: 'tool.called', turnId, stepId, toolCallId, name: tool.name, input });
  const result = await tool.execute(input, toolContext(signal));
  session.append({ type: 'tool.result', turnId, stepId, toolCallId, result });
  return result;
}

/** 追加一条真实媒体检查结果；它模拟 probe_media / decode_video / detect_black_segments 的返回。 */
function appendCheck(session: InMemorySession, name: string, inputPath: string, output: unknown): ToolCallId {
  const toolCallId = nextCallId();
  session.append({ type: 'tool.called', turnId, stepId, toolCallId, name, input: { inputPath } });
  session.append({ type: 'tool.result', turnId, stepId, toolCallId, result: { status: 'success', output } });
  return toolCallId;
}

function decodableEvidence(inputPath: string, decoded = true): unknown {
  return {
    inputPath,
    hasVideoStream: true,
    videoCodec: 'h264',
    durationSeconds: 5,
    fullyDecoded: decoded,
  };
}

/** 候选写出工具：真实写入文件，并返回结构化生产事实。 */
class CandidateTool implements Tool {
  readonly contract = { approvalRequirement: 'none' } as const;
  readonly description = '测试用候选写出工具';
  readonly inputSchema = { type: 'object', properties: { outputPath: { type: 'string' } } };
  readonly written: string[] = [];

  constructor(readonly name: string = 'trim_video') {}

  async execute(input: unknown): Promise<ToolResult> {
    const outputPath = (input as { readonly outputPath: string }).outputPath;
    this.written.push(outputPath);
    await writeFile(outputPath, `candidate:${outputPath}`);
    return { status: 'success', output: { outputPath } };
  }
}

interface DeliveryTools {
  readonly session: InMemorySession;
  readonly declare: DeclareVideoOutputsTool;
  readonly validate: ValidateVideoCandidateTool;
  readonly publish: PublishVideoOutputTool;
}

function createDeliveryTools(session: InMemorySession = newSession()): DeliveryTools {
  const readEvents = () => session.events();
  return {
    session,
    declare: new DeclareVideoOutputsTool(readEvents),
    validate: new ValidateVideoCandidateTool(readEvents),
    publish: new PublishVideoOutputTool(readEvents, async () => true),
  };
}

interface DeclaredItem {
  readonly outputItemId: string;
  readonly workingDirectory: string;
  readonly preferredPath: string;
  readonly sourcePath: string;
}

/** 声明一项并返回应用层生成的真实标识与目录。 */
async function declareItem(
  tools: DeliveryTools,
  sourcePath: string,
  target: { readonly kind: 'explicit'; readonly path: string } | { readonly kind: 'automatic' },
  requirements?: readonly unknown[],
): Promise<DeclaredItem> {
  const result = await runTool(tools.session, tools.declare, {
    items: [{
      sourcePaths: [sourcePath],
      target,
      ...(requirements === undefined ? {} : { requirements }),
    }],
  });
  if (result.status !== 'success') throw new Error(`declare failed: ${result.message}`);
  const facts = readVideoDeliveryFacts(tools.session.events());
  const item = facts.items[0]!;
  return {
    outputItemId: item.id,
    workingDirectory: item.workingDirectory,
    preferredPath: item.target.kind === 'automatic' ? item.target.preferredPath : item.target.path,
    sourcePath,
  };
}

/** 在输出项工作目录里写出一个候选并返回生产调用标识。 */
async function produceCandidate(
  tools: DeliveryTools,
  workingDirectory: string,
  fileName: string,
  sourcePaths: string | readonly string[],
): Promise<{ readonly toolCallId: ToolCallId; readonly path: string }> {
  const path = join(workingDirectory, fileName);
  const inputs = typeof sourcePaths === 'string' ? [sourcePaths] : sourcePaths;
  const name = inputs.length > 1 ? 'concat_videos' : 'trim_video';
  const toolCallId = nextCallId();
  const input = inputs.length > 1
    ? { inputPaths: inputs, outputPath: path }
    : { inputPath: inputs[0]!, outputPath: path, start: 0, duration: 5 };
  tools.session.append({
    type: 'tool.called',
    turnId,
    stepId,
    toolCallId,
    name,
    input,
  });
  await writeFile(path, `candidate:${fileName}`);
  tools.session.append({
    type: 'tool.result',
    turnId,
    stepId,
    toolCallId,
    result: { status: 'success', output: { outputPath: path } },
  });
  return { toolCallId, path };
}

/**
 * 按候选路径发起验收。
 *
 * 生产调用与检查证据都由应用层按这条路径核对，因此模型不需要、也不能提交调用标识。
 */
async function validateCandidate(
  tools: DeliveryTools,
  outputItemId: string,
  candidatePath: string,
): Promise<{ readonly validationId: string; readonly checks: readonly { readonly outcome: string }[] }> {
  const result = await runTool(tools.session, tools.validate, { outputItemId, candidatePath });
  if (result.status !== 'success') throw new Error(`validate failed: ${result.message}`);
  const facts = readVideoDeliveryFacts(tools.session.events());
  const validation = facts.validations.at(-1)!;
  return { validationId: validation.id, checks: validation.checks };
}

function resultsOf(session: InMemorySession): readonly OutputItemResult[] {
  return projectOutputItemResults(readVideoDeliveryFacts(session.events()));
}

describe('video delivery declaration and write boundary', () => {
  it('consumes canonical Probe evidence for a candidate accessed through a directory link', async () => {
    const directory = await temporaryDirectory(); const target = await temporaryDirectory();
    const link = join(directory, 'linked'); await symlink(target, link, 'junction');
    await writeFile(join(target, 'source.mp4'), 'source');
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(link, 'source.mp4'), { kind: 'automatic' }, [{ kind: 'duration-range', minSeconds: 4, maxSeconds: 6 }]);
    const candidate = await produceCandidate(tools, item.workingDirectory, 'candidate.mp4', item.sourcePath);
    const canonical = await realpath(candidate.path); expect(canonical).not.toBe(candidate.path);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    appendCheck(tools.session, 'probe_media', candidate.path, { inputPath: join(target, 'source.mp4'), duration: 5 });
    expect((await validateCandidate(tools, item.outputItemId, candidate.path)).checks[1]?.outcome).toBe('blocked');
    appendCheck(tools.session, 'probe_media', candidate.path, { inputPath: canonical, duration: 5 });
    expect((await validateCandidate(tools, item.outputItemId, candidate.path)).checks.every(check => check.outcome === 'passed')).toBe(true);
    // CLI 仍返回原引用路径；同一验收契约继续接受它。
    appendCheck(tools.session, 'probe_media', candidate.path, { inputPath: candidate.path, duration: 5 });
    expect((await validateCandidate(tools, item.outputItemId, candidate.path)).checks.every(check => check.outcome === 'passed')).toBe(true);
  });
  it('binds semantic evidence to the declared item, complete coverage, and unchanged bytes', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'automatic' }, [{ kind: 'semantic', description: '只保留讲解' }]);
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    const requirement = readVideoDeliveryFacts(tools.session.events()).items[0]!.requirements.find((entry) => entry.kind === 'semantic')!;
    const evidence = { inputPath: candidate.path, outputItemId: item.outputItemId, candidateSha256: await candidateDigest(candidate.path),
      coverage: 'all-frames-and-transcript', checks: [{ requirementId: requirement.id, outcome: 'passed', detail: '全片为讲解画面' }] };
    for (const incorrect of [{ ...evidence, outputItemId: 'another-item' }, { ...evidence, coverage: 'incomplete' }, { ...evidence, checks: null }]) {
      appendCheck(tools.session, 'check_video_semantics', candidate.path, incorrect);
      const result = await validateCandidate(tools, item.outputItemId, candidate.path);
      expect(result.checks.at(-1)).toMatchObject({ outcome: 'blocked' });
    }
    appendCheck(tools.session, 'check_video_semantics', candidate.path, evidence);
    const passed = await validateCandidate(tools, item.outputItemId, candidate.path);
    expect(passed.checks.every((check) => check.outcome === 'passed')).toBe(true);
    await writeFile(candidate.path, 'changed after validation');
    expect(await runTool(tools.session, tools.publish, { validationId: passed.validationId })).toMatchObject({ status: 'error' });
    expect(readVideoDeliveryFacts(tools.session.events()).published).toEqual([]);
    const changed = await validateCandidate(tools, item.outputItemId, candidate.path);
    expect(changed.checks.at(-1)).toMatchObject({ outcome: 'blocked' });
  });
  it('refuses to write a candidate before any output item is declared', async () => {
    const directory = await temporaryDirectory();
    const session = newSession();
    const candidate = new CandidateTool();
    const scoped = new ScopedVideoOutputTool(candidate, () => session.events());

    const result = await runTool(session, scoped, {
      inputPath: 'source.mp4',
      outputPath: join(directory, 'candidate.mp4'),
    });

    expect(result).toMatchObject({ status: 'error' });
    expect(candidate.written).toEqual([]);
  });

  it('confines candidate writes to the working directory of a declared item', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const candidate = new CandidateTool();
    const scoped = new ScopedVideoOutputTool(candidate, () => tools.session.events());

    const item = await declareItem(
      tools,
      join(directory, 'source.mp4'),
      { kind: 'explicit', path: join(directory, 'source-result.mp4') },
    );

    // 直接写最终目标会被拒绝：最终路径只能由发布产生。
    const toFinalTarget = await runTool(tools.session, scoped, {
      inputPath: join(directory, 'source.mp4'),
      outputPath: join(directory, 'source-result.mp4'),
    });
    expect(toFinalTarget).toMatchObject({ status: 'error' });
    expect(candidate.written).toEqual([]);

    const inside = await runTool(tools.session, scoped, {
      inputPath: join(directory, 'source.mp4'),
      outputPath: join(item.workingDirectory, 'attempt.mp4'),
    });
    expect(inside).toMatchObject({ status: 'success' });
    expect(candidate.written).toEqual([join(item.workingDirectory, 'attempt.mp4')]);
  });

  it('rejects a relative candidate path instead of guessing a base directory', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const candidate = new CandidateTool();
    const scoped = new ScopedVideoOutputTool(candidate, () => tools.session.events());

    await declareItem(
      tools,
      join(directory, 'source.mp4'),
      { kind: 'automatic' },
    );

    const result = await runTool(tools.session, scoped, {
      inputPath: join(directory, 'source.mp4'),
      outputPath: 'relative-candidate.mp4',
    });

    expect(result).toMatchObject({ status: 'error' });
    expect(candidate.written).toEqual([]);
  });

  it('accepts only one complete declaration per turn', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    await declareItem(tools, join(directory, 'a.mp4'), { kind: 'automatic' });

    const second = await runTool(tools.session, tools.declare, {
      items: [{ sourcePaths: [join(directory, 'b.mp4')], target: { kind: 'automatic' } }],
    });

    expect(second).toMatchObject({ status: 'error' });
    expect(readVideoDeliveryFacts(tools.session.events()).items).toHaveLength(1);
  });

  it('rejects two declared items that resolve to the same explicit target', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const target = { kind: 'explicit' as const, path: join(directory, 'same.mp4') };

    const result = await runTool(tools.session, tools.declare, {
      items: [
        { sourcePaths: [join(directory, 'a.mp4')], target },
        { sourcePaths: [join(directory, 'b.mp4')], target },
      ],
    });

    expect(result).toMatchObject({ status: 'error' });
  });

  it('does not create an earlier working directory when a later item is invalid', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const result = await runTool(tools.session, tools.declare, {
      items: [
        { sourcePaths: [join(directory, 'a.mp4')], target: { kind: 'automatic' } },
        { sourcePaths: [join(directory, 'b.mp4')], target: { kind: 'explicit', path: 'relative.mp4' } },
      ],
    });

    expect(result).toMatchObject({ status: 'error' });
    const entries = await readdir(directory);
    expect(entries.filter((entry) => entry.startsWith('.agent-output-'))).toEqual([]);
  });
});

describe('candidate validation', () => {
  it('records a failed check when the evidence proves the candidate misses a requirement', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(
      tools,
      join(directory, 'source.mp4'),
      { kind: 'automatic' },
      [{ kind: 'duration-range', minSeconds: 4.96, maxSeconds: 5.04 }],
    );
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt-a.mp4', item.sourcePath);

    appendCheck(tools.session, 'probe_media', candidate.path, {
      inputPath: candidate.path,
      duration: 4.5,
      width: 64,
      height: 64,
      videoCodec: 'h264',
      audioCodec: null,
    });
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));

    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);

    expect(validation.checks.map((check) => check.outcome)).toEqual(['passed', 'failed']);
    // 检查不通过是验收工具成功执行后的业务结果，不是外层工具错误。
    expect(resultsOf(tools.session)).toEqual([
      { outputItemId: item.outputItemId, status: 'failed', reason: expect.stringContaining('4.5') },
    ]);
  });

  it('keeps a requirement blocked when its evidence is missing', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(
      tools,
      join(directory, 'source.mp4'),
      { kind: 'automatic' },
      [{ kind: 'no-black-segments' }],
    );
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));

    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);

    expect(validation.checks.map((check) => check.outcome)).toEqual(['passed', 'blocked']);
    expect(resultsOf(tools.session)[0]).toMatchObject({ status: 'blocked' });
  });

  it('never upgrades a black-segment pass into a semantic pass', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(
      tools,
      join(directory, 'source.mp4'),
      { kind: 'automatic' },
      [{ kind: 'no-black-segments' }, { kind: 'semantic', description: '全片没有片名卡' }],
    );
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    appendCheck(tools.session, 'detect_black_segments', candidate.path, {
      inputPath: candidate.path,
      hasBlackSegments: false,
      segments: [],
      parameters: { minimumDurationSeconds: 0.04, pixelThreshold: 0.1 },
    });

    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);

    expect(validation.checks.map((check) => check.outcome)).toEqual(['passed', 'passed', 'blocked']);
    const publish = await runTool(tools.session, tools.publish, { validationId: validation.validationId });
    expect(publish).toMatchObject({ status: 'error' });
    expect(resultsOf(tools.session)[0]).toMatchObject({ status: 'blocked' });
  });

  it('does not accept checks performed on a different file', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'automatic' });
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePath);
    // 源视频上的检查不能替代最终候选的验收证据。
    appendCheck(
      tools.session,
      'decode_video',
      join(directory, 'source.mp4'),
      decodableEvidence(join(directory, 'source.mp4')),
    );

    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);

    expect(validation.checks.map((check) => check.outcome)).toEqual(['blocked']);
  });

  it('rejects a candidate produced from a source outside sourcePaths', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source-a.mp4'), { kind: 'automatic' });
    const candidate = await produceCandidate(tools, item.workingDirectory, 'wrong-source.mp4', join(directory, 'source-b.mp4'));
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));

    const result = await runTool(tools.session, tools.validate, {
      outputItemId: item.outputItemId,
      candidatePath: candidate.path,
    });

    expect(result).toMatchObject({ status: 'error' });
  });

  it('rejects the latest same-path producer from a different source instead of reusing older matching production', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'source-a.mp4'); await writeFile(source, 'source a');
    const otherSource = join(directory, 'source-b.mp4'); await writeFile(otherSource, 'source b');
    const tools = createDeliveryTools();
    const item = await declareItem(tools, source, { kind: 'automatic' });
    const first = await produceCandidate(tools, item.workingDirectory, 'same-path.mp4', source);
    appendCheck(tools.session, 'decode_video', first.path, decodableEvidence(first.path));
    expect((await validateCandidate(tools, item.outputItemId, first.path)).checks[0]?.outcome).toBe('passed');

    const second = await produceCandidate(tools, item.workingDirectory, 'same-path.mp4', otherSource);
    await writeFile(second.path, 'candidate from source b');
    // 补齐新文件检查仍不能修复来源错误；只允许最新生产事实决定当前候选归属。
    appendCheck(tools.session, 'decode_video', second.path, decodableEvidence(second.path));
    const result = await runTool(tools.session, tools.validate, {
      outputItemId: item.outputItemId,
      candidatePath: second.path,
    });
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('来源匹配') });
    expect(readVideoDeliveryFacts(tools.session.events()).validations).toHaveLength(1);
    expect(await readFile(second.path, 'utf8')).toBe('candidate from source b');
  });

  it('rejects a merge candidate that includes an undeclared source', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const declaredSources = [join(directory, 'source-a.mp4'), join(directory, 'source-b.mp4')];
    const item = await runTool(tools.session, tools.declare, {
      items: [{ sourcePaths: declaredSources, target: { kind: 'automatic' } }],
    });
    expect(item).toMatchObject({ status: 'success' });
    const declared = readVideoDeliveryFacts(tools.session.events()).items[0]!;
    const candidate = await produceCandidate(
      tools,
      declared.workingDirectory,
      'wrong-merge.mp4',
      [declaredSources[0]!, join(directory, 'source-c.mp4')],
    );
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));

    const result = await runTool(tools.session, tools.validate, {
      outputItemId: declared.id,
      candidatePath: candidate.path,
    });

    expect(result).toMatchObject({ status: 'error' });
  });

  it('does not reuse evidence or candidate identity after the same path is produced again', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const source = join(directory, 'source.mp4');
    const item = await declareItem(tools, source, { kind: 'automatic' });
    const first = await produceCandidate(tools, item.workingDirectory, 'same-path.mp4', source);
    appendCheck(tools.session, 'decode_video', first.path, decodableEvidence(first.path));
    const firstValidation = await validateCandidate(tools, item.outputItemId, first.path);
    expect(firstValidation.checks[0]?.outcome).toBe('passed');

    const second = await produceCandidate(tools, item.workingDirectory, 'same-path.mp4', source);
    const secondValidation = await validateCandidate(tools, item.outputItemId, second.path);
    const facts = readVideoDeliveryFacts(tools.session.events());

    expect(secondValidation.checks[0]?.outcome).toBe('blocked');
    expect(facts.candidates).toHaveLength(2);
    expect(facts.candidates[0]?.id).not.toBe(facts.candidates[1]?.id);
  });

  it('rejects a candidate path that escapes through a junction', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const candidateTool = new CandidateTool();
    const scoped = new ScopedVideoOutputTool(candidateTool, () => tools.session.events());
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'automatic' });
    const outside = join(directory, 'outside');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(outside));
    const link = join(item.workingDirectory, 'link');
    await symlink(outside, link, 'junction');

    const result = await runTool(tools.session, scoped, {
      inputPath: item.sourcePath,
      outputPath: join(link, 'escaped.mp4'),
    });

    expect(result).toMatchObject({ status: 'error' });
    await expect(stat(join(outside, 'escaped.mp4'))).rejects.toThrow();
  });

  it('does not accept a candidate file produced outside the item working directory', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'automatic' });
    const outsider = join(directory, 'outsider.mp4');
    const toolCallId = nextCallId();
    tools.session.append({
      type: 'tool.called', turnId, stepId, toolCallId, name: 'trim_video', input: { outputPath: outsider },
    });
    tools.session.append({
      type: 'tool.result', turnId, stepId, toolCallId,
      result: { status: 'success', output: { outputPath: outsider } },
    });

    const result = await runTool(tools.session, tools.validate, {
      outputItemId: item.outputItemId,
      candidatePath: outsider,
    });

    expect(result).toMatchObject({ status: 'error' });
  });

  it('refuses to validate a path that no successful production call wrote', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'automatic' });
    // 目录里碰巧存在一个同名文件不构成候选：候选必须来自一次成功的写出调用。
    const unwritten = join(item.workingDirectory, 'never-produced.mp4');
    await writeFile(unwritten, 'not produced by any tool');

    const result = await runTool(tools.session, tools.validate, {
      outputItemId: item.outputItemId,
      candidatePath: unwritten,
    });

    expect(result).toMatchObject({ status: 'error' });
  });

  it('ignores a look-alike fact produced by a tool that is not a delivery tool', async () => {
    const session = newSession();
    session.append({
      type: 'tool.called', turnId, stepId, toolCallId: 'call-fake' as ToolCallId, name: 'probe_media', input: {},
    });
    session.append({
      type: 'tool.result', turnId, stepId, toolCallId: 'call-fake' as ToolCallId,
      result: {
        status: 'success',
        output: {
          kind: 'video.outputs.declared',
          items: [{
            id: 'out-fake',
            sourcePaths: ['D:/videos/a.mp4'],
            target: { kind: 'automatic', preferredPath: 'D:/videos/a-edited.mp4' },
            workingDirectory: 'D:/videos/.agent-output-out-fake',
            requirements: [{ id: 'r1', kind: 'decodable-video' }],
          }],
        },
      },
    });

    expect(readVideoDeliveryFacts(session.events()).items).toEqual([]);
  });
});

describe('publishing', () => {
  it.each(['deny', 'target-conflict', 'candidate-change'] as const)('fixes the exact publish action before approval and stops on %s', async scenario => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'automatic' });
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);
    const target = join(await realpath(directory), 'source-edited.mp4');
    const approve = vi.fn(async (action: { candidatePath: string; targetPath: string }) => {
      expect(action).toEqual({ candidatePath: candidate.path, targetPath: target });
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
      if (scenario === 'target-conflict') await writeFile(target, 'someone else');
      if (scenario === 'candidate-change') await writeFile(candidate.path, 'changed after approval began');
      return scenario !== 'deny';
    });
    const publish = new PublishVideoOutputTool(() => tools.session.events(), approve);
    const checkpoint = vi.fn();
    const result = await publish.execute({ validationId: validation.validationId }, { ...toolContext(), checkpoint });
    expect(approve).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'error', failureKind: scenario === 'deny' ? 'denied' : 'permanent' });
    if (scenario === 'target-conflict') expect(await readFile(target, 'utf8')).toBe('someone else');
    else await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(directory, 'source-edited-2.mp4'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (scenario !== 'target-conflict') expect(checkpoint).not.toHaveBeenCalled();
    expect(readVideoDeliveryFacts(tools.session.events()).published).toEqual([]);
  });

  it('publishes only the repaired candidate and keeps the failed one out of the delivery', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(
      tools,
      join(directory, 'source.mp4'),
      { kind: 'explicit', path: join(directory, 'source-result.mp4') },
      [{ kind: 'duration-range', minSeconds: 4.96, maxSeconds: 5.04 }],
    );

    const first = await produceCandidate(tools, item.workingDirectory, 'attempt-a.mp4', item.sourcePath);
    appendCheck(tools.session, 'probe_media', first.path, { inputPath: first.path, duration: 4.5 });
    appendCheck(tools.session, 'decode_video', first.path, decodableEvidence(first.path));
    const firstValidation = await validateCandidate(tools, item.outputItemId, first.path);
    const refused = await runTool(tools.session, tools.publish, { validationId: firstValidation.validationId });
    expect(refused).toMatchObject({ status: 'error' });

    const second = await produceCandidate(tools, item.workingDirectory, 'attempt-b.mp4', item.sourcePath);
    appendCheck(tools.session, 'probe_media', second.path, { inputPath: second.path, duration: 5 });
    appendCheck(tools.session, 'decode_video', second.path, decodableEvidence(second.path));
    const secondValidation = await validateCandidate(tools, item.outputItemId, second.path);
    const published = await runTool(tools.session, tools.publish, { validationId: secondValidation.validationId });

    expect(published).toMatchObject({
      status: 'success',
      artifacts: [expect.objectContaining({ path: await realpath(join(directory, 'source-result.mp4')) })],
    });
    expect(await readFile(join(directory, 'source-result.mp4'), 'utf8')).toBe(`candidate:attempt-b.mp4`);
    // 修复候选成为唯一交付结果，旧候选仍保留在过程记录里。
    expect(resultsOf(tools.session)).toEqual([
      {
        outputItemId: item.outputItemId,
        status: 'published',
        output: {
          outputItemId: item.outputItemId,
          validationId: secondValidation.validationId,
          path: join(directory, 'source-result.mp4'),
        },
      },
    ]);

    // 旧候选的验收不能批准同一输出项，也不能被重新当成当前候选。
    const reuse = await runTool(tools.session, tools.publish, { validationId: firstValidation.validationId });
    expect(reuse).toMatchObject({ status: 'error' });
  });

  it('refuses to overwrite an existing explicit target without renaming it', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'taken.mp4');
    await writeFile(target, 'already here');

    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'explicit', path: target });
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);

    const result = await runTool(tools.session, tools.publish, { validationId: validation.validationId });

    expect(result).toMatchObject({ status: 'error' });
    expect(await readFile(target, 'utf8')).toBe('already here');
    expect(resultsOf(tools.session)[0]).toMatchObject({ status: 'incomplete' });
  });

  it('picks the default name from real disk usage at publish time', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'clip.mp4');
    await writeFile(source, 'source bytes');
    // 首选名已被占用：发布必须继续向后找，而不是覆盖或提前占用序号。
    await writeFile(join(directory, 'clip-edited.mp4'), 'existing output');

    const tools = createDeliveryTools();
    const item = await declareItem(tools, source, { kind: 'automatic' });
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', source);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);

    const result = await runTool(tools.session, tools.publish, { validationId: validation.validationId });

    expect(result).toMatchObject({
      status: 'success',
      artifacts: [expect.objectContaining({ path: await realpath(join(directory, 'clip-edited-2.mp4')) })],
    });
    expect(await readFile(join(directory, 'clip-edited.mp4'), 'utf8')).toBe('existing output');
  });

  it('does not consume a final name while nothing is published', async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, 'clip.mp4');
    await writeFile(source, 'source bytes');

    const tools = createDeliveryTools();
    const item = await declareItem(tools, source, { kind: 'automatic' });
    // 生成了候选但还没有发布：首选名必须仍然是空闲的。
    await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', source);
    await expect(stat(join(directory, 'clip-edited.mp4'))).rejects.toThrow();

    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt-2.mp4', source);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);
    const result = await runTool(tools.session, tools.publish, { validationId: validation.validationId });

    // 未发布不跳号：第一次发布仍然拿到首选名。
    expect(result).toMatchObject({ status: 'success', artifacts: [expect.objectContaining({ path: await realpath(join(directory, 'clip-edited.mp4')) })] });
  });

  it('registers nothing and removes the incomplete target when publishing is cancelled', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'automatic' });
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);

    const controller = new AbortController();
    controller.abort();
    await expect(runTool(
      tools.session,
      tools.publish,
      { validationId: validation.validationId },
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' });

    // 未完成的目标不能留下，也不能被登记为已交付。
    await expect(stat(join(directory, 'source-edited.mp4'))).rejects.toThrow();
    expect(readVideoDeliveryFacts(tools.session.events()).published).toEqual([]);
  });

  it('keeps an already published file when the turn is cancelled afterwards', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(tools, join(directory, 'source.mp4'), { kind: 'automatic' });
    const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    const validation = await validateCandidate(tools, item.outputItemId, candidate.path);
    await runTool(tools.session, tools.publish, { validationId: validation.validationId });

    // 发布完成之后才取消：已交付事实不回滚。
    const controller = new AbortController();
    controller.abort();
    expect(await readFile(join(directory, 'source-edited.mp4'), 'utf8')).toBe('candidate:attempt.mp4');
    expect(resultsOf(tools.session)[0]).toMatchObject({ status: 'published' });
  });

  it('refuses to publish a candidate whose validation is not the latest one', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const item = await declareItem(
      tools,
      join(directory, 'source.mp4'),
      { kind: 'automatic' },
      [{ kind: 'duration-range', minSeconds: 4.96, maxSeconds: 5.04 }],
    );
    const first = await produceCandidate(tools, item.workingDirectory, 'attempt-a.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', first.path, decodableEvidence(first.path));
    appendCheck(tools.session, 'probe_media', first.path, { inputPath: first.path, duration: 5 });
    const passing = await validateCandidate(tools, item.outputItemId, first.path);

    // 之后送验的候选不通过：旧候选的全项通过验收不能继续批准本输出项。
    const second = await produceCandidate(tools, item.workingDirectory, 'attempt-b.mp4', item.sourcePath);
    appendCheck(tools.session, 'decode_video', second.path, decodableEvidence(second.path));
    appendCheck(tools.session, 'probe_media', second.path, { inputPath: second.path, duration: 4.5 });
    const failing = await validateCandidate(tools, item.outputItemId, second.path);

    const result = await runTool(tools.session, tools.publish, { validationId: passing.validationId });

    expect(result).toMatchObject({ status: 'error' });
    expect(failing.checks.map((check) => check.outcome)).toEqual(['passed', 'failed']);
  });
});

describe('batch delivery projection', () => {
  for (const count of [5, 10, 20]) {
    it(`delivers ${count} independent output items with their own sources and targets`, async () => {
      const directory = await temporaryDirectory();
      const tools = createDeliveryTools();
      const sources = await Promise.all(Array.from({ length: count }, async (_, index) => {
        const source = join(directory, `input-${index}.mp4`);
        await writeFile(source, `source ${index}`);
        return source;
      }));

      const declared = await runTool(tools.session, tools.declare, {
        items: sources.map((source) => ({
          sourcePaths: [source],
          target: { kind: 'automatic' },
        })),
      });
      expect(declared).toMatchObject({ status: 'success' });
      const facts = readVideoDeliveryFacts(tools.session.events());
      expect(facts.items).toHaveLength(count);

      // 只交付前 count - 1 项，最后一项保留为未完成。
      for (const item of facts.items.slice(0, count - 1)) {
        const candidate = await produceCandidate(tools, item.workingDirectory, 'attempt.mp4', item.sourcePaths[0]!);
        appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
        const validation = await validateCandidate(tools, item.id, candidate.path);
        const published = await runTool(tools.session, tools.publish, { validationId: validation.validationId });
        expect(published).toMatchObject({ status: 'success' });
      }

      const results = resultsOf(tools.session);
      expect(results).toHaveLength(count);
      expect(results.filter((result) => result.status === 'published')).toHaveLength(count - 1);
      expect(results.at(-1)).toMatchObject({ status: 'incomplete' });

      const publishedPaths = results
        .filter((result): result is Extract<OutputItemResult, { status: 'published' }> => result.status === 'published')
        .map((result) => result.output.path);
      // 每个输出项各自交付到自己的目标：数量与来源一一对应，没有互相覆盖。
      expect(new Set(publishedPaths).size).toBe(count - 1);
      expect(publishedPaths).toEqual(sources.slice(0, count - 1).map((source) => (
        join(directory, `input-${sources.indexOf(source)}-edited.mp4`)
      )));
    });
  }

  it('delivers one item for a merge task with several sources', async () => {
    const directory = await temporaryDirectory();
    const tools = createDeliveryTools();
    const sources = ['a', 'b', 'c'].map((name) => join(directory, `${name}.mp4`));

    await runTool(tools.session, tools.declare, {
      items: [{ sourcePaths: sources, target: { kind: 'explicit', path: join(directory, 'merged.mp4') } }],
    });
    const facts = readVideoDeliveryFacts(tools.session.events());
    expect(facts.items).toHaveLength(1);
    expect(facts.items[0]?.sourcePaths).toEqual(sources);

    const candidate = await produceCandidate(
      tools,
      facts.items[0]!.workingDirectory,
      'merged-attempt.mp4',
      sources,
    );
    appendCheck(tools.session, 'decode_video', candidate.path, decodableEvidence(candidate.path));
    const validation = await validateCandidate(tools, facts.items[0]!.id, candidate.path);
    await runTool(tools.session, tools.publish, { validationId: validation.validationId });

    const results = resultsOf(tools.session);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'published' });
  });

  it('reports no delivery result for a task that never declared an output item', () => {
    expect(resultsOf(newSession())).toEqual([]);
  });
});
