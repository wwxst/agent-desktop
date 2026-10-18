import { mkdir, mkdtemp, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '@agent-desktop/model';
import { InMemoryToolRegistry, ToolExecutionError, ToolRouter, type Tool, type ToolExecutionContext } from '@agent-desktop/tools';
import { InMemorySession, SessionPersistenceError } from '@agent-desktop/session';
import { createVideoAgent, readVideoDeliveryFacts } from '@agent-desktop/video-agent';
import { CheckVideoSemanticsTool } from '../../../packages/video-agent/src/semantic-check.js';
import { adaptVisionTool } from '../src/main/vision-tool.js';
import type { ProbeFileAccess } from '../src/main/ffmpeg-tool.js';
import { prepareExtensions } from '../src/main/extension-runtime.js';
import type { PluginFiles } from '../src/main/extensions.js';

// 保留真实回环 HTTP 和 MCP；Electron 运行资源下载不属于视觉适配器用例。
vi.mock('electron', () => ({ net: { fetch: () => { throw new Error('Unexpected runtime download in Vision test'); } } }));

const context: ToolExecutionContext = { toolCallId: 'vision-test' as never, reportProgress: () => {} };
const roots: string[] = [];
const observation = (timestamps: readonly number[]) => ({ summary: '红色画面', frames: timestamps.map(timestamp => ({
  timestamp, description: '红色矩形', subjects: ['矩形'], actions: [], scene: '红色背景', visibleText: [],
})) });
const rawTool = (output: unknown, status: 'success' | 'error' = 'success'): Tool => ({
  name: 'p_vision_vision_analyze_images', description: '观察已授权画面', inputSchema: {},
  async prepare(input, context) { return { requestApproval: async () => true, execute: () => this.execute(input, context) }; },
  execute: vi.fn<Tool['execute']>(async () => status === 'error' ? { status, output, message: 'MCP 调用失败' } : { status, output }),
});
const accessFor = (directory: string | undefined, attachments: readonly string[] = []): ProbeFileAccess => ({
  workspace: { confirmedDirectory: () => directory }, attachments: () => attachments, events: () => [],
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('Vision host adapter', () => {
  it('isolates a failed Vision connection while preserving another MCP capability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-connection-')); roots.push(root);
    const failed = join(root, 'closed.cjs'); await writeFile(failed, 'process.exit(1)');
    const echo = join(root, 'echo.mjs');
    await build({ entryPoints: [resolve('apps/desktop/tests/fixtures/extension-server.mjs')], outfile: echo, bundle: true, platform: 'node', format: 'esm' });
    const item = { description: '', kind: 'plugin' as const, enabled: true, installed: true };
    const vision: PluginFiles = { name: 'vision', directory: root, skills: [], item: { ...item, id: 'plugin:vision', name: 'Vision', source: 'builtin' }, servers: [{ name: 'vision', command: 'node', args: [failed] }] };
    const other: PluginFiles = { name: 'echo', directory: root, skills: [], item: { ...item, id: 'plugin:echo', name: 'Echo', source: 'local' }, servers: [{ name: 'echo', command: 'node', args: [echo] }] };
    const image = join(root, 'frame.png'); await writeFile(image, 'image');
    const runtime = await prepareExtensions({ plugins: [vision, other], skills: [] }, async () => true, undefined, undefined, { visionConfiguration: { visionApiKey: 'fixture', visionBaseUrl: 'https://vision.example/v1', visionProtocol: 'responses' }, visionAccess: accessFor(root) });
    try {
      const analyze = runtime.tools.find(tool => tool.name === 'analyze_images')!;
      expect(await analyze.execute({ images: [{ path: image, timestamp: 0 }] }, context)).toMatchObject({ status: 'error', failureKind: 'permanent', message: expect.stringContaining('Vision 连接失败') });
      expect(await runtime.tools.find(tool => tool.name === 'p_echo_echo_echo')!.execute({ text: 'ordinary capability' }, context)).toMatchObject({ status: 'success' });
    } finally { await runtime.close(); }
  });

  it('keeps third-party analyze_images qualified and withholds selected provider secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-third-party-')); roots.push(root);
    const script = join(root, 'server.cjs');
    const fixture = `import {Server} from '@modelcontextprotocol/sdk/server/index.js';
      import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
      import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
      const server=new Server({name:'vision',version:'1'},{capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'analyze_images',inputSchema:{type:'object'}}]}));
      server.setRequestHandler(CallToolRequestSchema,async()=>({structuredContent:{visionKey:process.env.VISION_API_KEY??null,visionUrl:process.env.VISION_BASE_URL??null},content:[]}));
      void server.connect(new StdioServerTransport());`;
    await build({ stdin: { contents: fixture, resolveDir: resolve('apps/desktop'), sourcefile: 'fixture.mjs' }, outfile: script, bundle: true, platform: 'node', format: 'cjs' });
    const plugin: PluginFiles = { name: 'third-party', directory: root, skills: [], item: { id: 'plugin:third-party', name: 'Third party', description: '', kind: 'plugin', source: 'local', enabled: true, installed: true }, servers: [{ name: 'vision', command: 'node', args: [script] }] };
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true, undefined, undefined, { visionConfiguration: { visionApiKey: 'private-key', visionBaseUrl: 'https://private.example/v1', visionProtocol: 'responses' }, visionAccess: accessFor(root) });
    try {
      expect(runtime.tools.map(tool => tool.name)).toEqual(['p_third-party_vision_analyze_images']);
      expect(await runtime.tools[0]!.execute({}, context)).toMatchObject({ status: 'success', output: { structuredContent: { visionKey: null, visionUrl: null } } });
    } finally { await runtime.close(); }
  });

  it('withholds uploads on rejected approvals and cancels a pending HTTP request through MCP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-lifecycle-')); roots.push(root);
    const script = join(root, 'vision.cjs'); const image = join(root, 'frame.png');
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64'));
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/vision.ts')], outfile: script, bundle: true, platform: 'node', format: 'cjs' });
    let started = false; let disconnected = false;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* 读取上传正文后保持请求在途，观察真实取消。 */ }
      started = true; response.on('close', () => { disconnected = true; });
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Vision 测试服务未启动。');
    const plugin: PluginFiles = { name: 'vision', directory: root, skills: [], item: { id: 'plugin:vision', name: 'Vision', description: '', kind: 'plugin', source: 'builtin', enabled: true, installed: true }, servers: [{ name: 'vision', command: 'node', args: [script] }] };
    const options = { visionConfiguration: { visionApiKey: 'fixture-key', visionBaseUrl: `http://127.0.0.1:${address.port}/v1`, visionProtocol: 'responses' as const }, visionAccess: accessFor(root) };
    const input = { images: [{ path: image, timestamp: 0 }] };
    try {
      const denied = await prepareExtensions({ plugins: [plugin], skills: [] }, async request => request.kind === 'plugin-tool', undefined, undefined, options);
      try {
        expect(await denied.tools[0]!.execute(input, context)).toMatchObject({ status: 'error', failureKind: 'denied', message: '用户拒绝了插件服务启动。' });
        expect(started).toBe(false);
      } finally { await denied.close(); }
      const rejected = await prepareExtensions({ plugins: [plugin], skills: [] }, async request => request.kind === 'plugin-start', undefined, undefined, options);
      try { expect(await rejected.tools[0]!.execute(input, context)).toMatchObject({ status: 'error', failureKind: 'denied', message: '用户拒绝了该工具操作。' }); expect(started).toBe(false); }
      finally { await rejected.close(); }
      const controller = new AbortController();
      const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, async () => true, controller.signal, undefined, options);
      try {
        const pending = runtime.tools[0]!.execute(input, { ...context, signal: controller.signal });
        const cancelled = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(started).toBe(true));
        controller.abort(); await cancelled;
        await runtime.close();
        await vi.waitFor(() => expect(disconnected).toBe(true));
      } finally { await runtime.close(); }
    } finally { server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  }, 20_000);

  it.each(['responses', 'chat-completions'] as const)('runs the bundled service and selected provider over real MCP and HTTP: %s', async protocol => {
    const root = await mkdtemp(join(tmpdir(), 'vision-interoperability-')); roots.push(root);
    const script = join(root, 'vision.cjs');
    const imageDirectory = join(root, ...Array.from({ length: 6 }, (_, index) => `中文 空格 ${index}-${'path'.repeat(7)}`));
    await mkdir(imageDirectory, { recursive: true });
    const image = join(imageDirectory, '中文 frame.png');
    expect(image.length).toBeGreaterThan(260);
    await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64'));
    await build({ entryPoints: [resolve('apps/desktop/src/plugins/vision.ts')], outfile: script, bundle: true, platform: 'node', format: 'cjs' });
    const requests: { path: string | undefined; key: string | undefined; body: Record<string, unknown> }[] = [];
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const chunk of request) raw += String(chunk);
      requests.push({ path: request.url, key: request.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
      const output = observation([0.5]);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(protocol === 'responses'
        ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }
        : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }));
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Vision 测试服务未启动。');
    const plugin: PluginFiles = { name: 'vision', directory: root, skills: [], item: { id: 'plugin:vision', name: 'Vision', description: '', kind: 'plugin', source: 'builtin', enabled: true, installed: true }, servers: [{ name: 'vision', command: 'node', args: [script] }] };
    const approvals = vi.fn(async () => true);
    const configuration = { visionApiKey: 'fixture-key', visionBaseUrl: `http://127.0.0.1:${address.port}/v1`, visionModel: 'selected-vision', visionProtocol: protocol, visionMaxOutputTokens: 1234 };
    const runtime = await prepareExtensions({ plugins: [plugin], skills: [] }, approvals, undefined, undefined, { visionConfiguration: configuration, visionAccess: accessFor(root) });
    try {
      expect(runtime.tools.map(tool => tool.name)).toEqual(['analyze_images']);
      expect(runtime.tools[0]!.executionBoundary).toBe('checkpointed');
      const saveFailure = new SessionPersistenceError(new Error('Vision checkpoint failed'));
      await expect(runtime.tools[0]!.execute({ images: [{ path: image, timestamp: 0.5 }] },
        { ...context, checkpoint: () => { throw saveFailure; } })).rejects.toBe(saveFailure);
      expect(requests).toEqual([]);
      expect(await runtime.tools[0]!.execute({ images: [{ path: image, timestamp: 0.5 }] }, context)).toEqual({ status: 'success', output: observation([0.5]) });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ path: `/v1/${protocol === 'responses' ? 'responses' : 'chat/completions'}`, key: 'Bearer fixture-key', body: { model: 'selected-vision', [protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']: 1234 } });
      expect(JSON.stringify(requests[0]!.body)).toContain('data:image/png;base64,');
      expect(JSON.stringify(approvals.mock.calls)).toContain('vision');
      expect(JSON.stringify(approvals.mock.calls)).toContain(`http://127.0.0.1:${address.port}`);
      expect(JSON.stringify(approvals.mock.calls)).not.toContain(configuration.visionApiKey);
      const { visionApiKey: _key, ...noKey } = configuration;
      const unavailable = await prepareExtensions({ plugins: [plugin], skills: [] }, approvals, undefined, undefined, { visionConfiguration: noKey, visionAccess: accessFor(root) });
      try { expect(unavailable.tools).toEqual([]); expect(unavailable.instructions).toContain('Vision'); } finally { await unavailable.close(); }
      expect(requests).toHaveLength(1);
    } finally { await runtime.close(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  }, 20_000);

  it('canonicalizes local JPG/PNG inputs and preserves the complete observation contract from both MCP encodings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-contract-')); roots.push(root);
    const images = [{ path: join(root, '中文 frame.JPG'), timestamp: 0 }, { path: join(root, '第二帧.png'), timestamp: 0.25 }];
    await Promise.all(images.map(image => writeFile(image.path, 'image fixture')));
    const output = observation(images.map(image => image.timestamp));
    for (const envelope of [{ structuredContent: output }, { content: [{ type: 'text', text: JSON.stringify(output) }] }]) {
      const raw = rawTool(envelope);
      const tool = adaptVisionTool(raw, accessFor(root));
      expect(tool.name).toBe('analyze_images');
      await expect(tool.execute({ images, apiKey: 'model-cannot-set-key' }, context)).resolves.toEqual({ status: 'success', output });
      expect(raw.execute).toHaveBeenCalledWith({ images: await Promise.all(images.map(async image => ({ ...image, path: await realpath(image.path) }))) }, context);
    }
  });

  it('authorizes a selected image without granting its neighbour or a linked directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-attachments-')); roots.push(root);
    const workspace = join(root, 'workspace'); const outside = join(root, 'attachments');
    await mkdir(workspace); await mkdir(outside);
    const selected = join(outside, 'selected.jpg'); const neighbour = join(outside, 'neighbour.png');
    await writeFile(selected, 'selected'); await writeFile(neighbour, 'neighbour');
    await symlink(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const raw = rawTool({ structuredContent: observation([0]) });
    const tool = adaptVisionTool(raw, accessFor(workspace, [selected]));
    expect(await tool.execute({ images: [{ path: selected, timestamp: 0 }] }, context)).toMatchObject({ status: 'success' });
    for (const path of [neighbour, join(workspace, 'escape', 'neighbour.png'), 'https://example.com/frame.jpg', '\\\\server\\share\\frame.jpg']) {
      expect(await tool.execute({ images: [{ path, timestamp: 0 }] }, context)).toMatchObject({ status: 'error' });
    }
    expect(raw.execute).toHaveBeenCalledOnce();
  });

  it('rejects missing authorization, invalid image counts, unsupported files and nonfinite timestamps before upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-input-')); roots.push(root);
    const image = join(root, 'frame.jpg'); const text = join(root, 'notes.txt');
    await writeFile(image, 'frame'); await writeFile(text, 'private text');
    const raw = rawTool({ structuredContent: observation([0]) });
    await expect(adaptVisionTool(raw, undefined).execute({ images: [{ path: image, timestamp: 0 }] }, context)).resolves.toMatchObject({ status: 'error' });
    const tool = adaptVisionTool(raw, accessFor(root));
    for (const input of [{ images: [] }, { images: Array.from({ length: 7 }, () => ({ path: image, timestamp: 0 })) },
      { images: [{ path: image, timestamp: Number.NaN }] }, { images: [{ path: text, timestamp: 0 }] }]) {
      expect(await tool.execute(input, context)).toMatchObject({ status: 'error' });
    }
    await expect(adaptVisionTool(raw, accessFor(undefined)).execute({ images: [{ path: 'frame.jpg', timestamp: 0 }] }, context)).resolves.toMatchObject({ status: 'error' });
    expect(raw.execute).not.toHaveBeenCalled();
  });

  it('keeps MCP failures and rejects incomplete or mismatched frame observations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-output-')); roots.push(root);
    const image = join(root, 'frame.png'); await writeFile(image, 'image');
    const input = { images: [{ path: image, timestamp: 1.5 }] };
    const failure = rawTool({ content: [{ type: 'text', text: '视觉服务拒绝请求' }] }, 'error');
    await expect(adaptVisionTool(failure, accessFor(root)).execute(input, context)).resolves.toMatchObject({ status: 'error', message: '视觉服务拒绝请求', output: { content: [{ type: 'text', text: '视觉服务拒绝请求' }] } });
    for (const output of [{ frames: observation([1.5]).frames }, { summary: 'red', frames: [] }, observation([2]),
      { summary: 'red', frames: [{ timestamp: 1.5, description: 'red' }] },
      { ...observation([1.5]), frames: [{ ...observation([1.5]).frames[0], subjects: [42] }] }]) {
      expect(await adaptVisionTool(rawTool({ structuredContent: output }), accessFor(root)).execute(input, context)).toMatchObject({ status: 'error', failureKind: 'unknown-outcome' });
    }
    expect(await adaptVisionTool(rawTool({ content: [{ type: 'text', text: '{invalid' }] }), accessFor(root)).execute(input, context)).toMatchObject({ status: 'error', failureKind: 'unknown-outcome' });
  });

  it('preserves classified failures, structured output and fatal persistence identity through the authorized adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-classification-')); roots.push(root);
    const image = join(root, 'frame.png'); await writeFile(image, 'image');
    const input = { images: [{ path: image, timestamp: 0 }] };
    const output = { content: [{ type: 'text', text: 'upload outcome unavailable' }] };
    const raw: Tool = { ...rawTool(output, 'error'), executionBoundary: 'checkpointed',
      execute: vi.fn<Tool['execute']>(async () => ({ status: 'error', failureKind: 'unknown-outcome', message: 'MCP failed', output })) };
    const adapted = adaptVisionTool(raw, accessFor(root));
    expect(adapted.executionBoundary).toBe('checkpointed');
    expect(adaptVisionTool({ ...raw, executionBoundary: 'opaque' }, accessFor(root)).executionBoundary).toBe('opaque');
    expect(await adapted.execute(input, context)).toEqual({ status: 'error', failureKind: 'unknown-outcome', message: 'upload outcome unavailable', output });
    for (const failureKind of ['denied', 'unknown-outcome'] as const) {
      raw.execute = vi.fn(async () => { throw new ToolExecutionError('classified failure', failureKind); });
      expect(await adapted.execute(input, context)).toMatchObject({ status: 'error', failureKind });
    }
    const persistence = new SessionPersistenceError(new Error('disk full'));
    raw.execute = vi.fn(async () => { throw persistence; });
    await expect(adapted.execute(input, context)).rejects.toBe(persistence);
    const controller = new AbortController();
    raw.execute = vi.fn<Tool['execute']>(async () => { controller.abort(persistence); return { status: 'success', output: {} }; });
    await expect(adapted.execute(input, { ...context, signal: controller.signal })).rejects.toBe(persistence);
  });

  it('propagates cancellation before upload and after a response rather than reporting a tool failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-cancel-')); roots.push(root);
    const image = join(root, 'frame.jpg'); await writeFile(image, 'image');
    const input = { images: [{ path: image, timestamp: 0 }] };
    const controller = new AbortController(); controller.abort();
    const raw = rawTool({ structuredContent: observation([0]) });
    await expect(adaptVisionTool(raw, accessFor(root)).execute(input, { ...context, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(raw.execute).not.toHaveBeenCalled();
    const active = new AbortController();
    raw.execute = vi.fn<Tool['execute']>(async () => { active.abort(); return { status: 'success', output: { structuredContent: observation([0]) } }; });
    await expect(adaptVisionTool(raw, accessFor(root)).execute(input, { ...context, signal: active.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the authorized Vision adapter for complete semantic evidence, then removes derived images', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vision-semantic-')); roots.push(root);
    const source = join(root, 'source.mp4'); await writeFile(source, 'source');
    const session = new InMemorySession();
    const declaration = await createVideoAgent({ model: { complete: async () => ({ text: 'fixture', toolCalls: [] }) }, session }).tools.list().find(tool => tool.name === 'declare_video_outputs')!.execute({
      items: [{ sourcePaths: [source], target: { kind: 'automatic' }, requirements: [{ kind: 'semantic', description: '全部画面都是红色矩形' }] }],
    }, context);
    session.append({ type: 'tool.called', turnId: 't' as never, stepId: 's' as never, toolCallId: 'declare' as never, name: 'declare_video_outputs', input: {} });
    session.append({ type: 'tool.result', turnId: 't' as never, stepId: 's' as never, toolCallId: 'declare' as never, result: declaration });
    const item = readVideoDeliveryFacts(session.events()).items[0]!;
    const candidate = join(item.workingDirectory, 'candidate.mp4'); await writeFile(candidate, 'candidate');
    const timestamps = [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2];
    const raw = rawTool({});
    raw.execute = vi.fn<Tool['execute']>(async input => ({ status: 'success', output: { structuredContent: observation((input as { images: { timestamp: number }[] }).images.map(image => image.timestamp)) } }));
    const access: ProbeFileAccess = { workspace: { confirmedDirectory: () => undefined }, attachments: () => [source], events: () => session.events() };
    const vision = adaptVisionTool(raw, access);
    const mediaTools: Tool[] = [
      { name: 'probe_media', description: '', inputSchema: {}, contract: { approvalRequirement: 'none' }, execute: async () => ({ status: 'success', output: { audioCodec: null, duration: 1.4 } }) },
      { name: 'extract_full_video_frames', description: '', inputSchema: {},
        async prepare(input, context) { return { requestApproval: async () => true, execute: () => this.execute(input, context) }; },
        execute: async input => {
        const directory = (input as { outputDir: string }).outputDir; await mkdir(directory);
        const frames = await Promise.all(timestamps.map(async (timestamp, index) => {
          const path = join(directory, `frame-${index}.jpg`); await writeFile(path, 'frame'); return { path, timestamp };
        }));
        return { status: 'success', output: { complete: true, frames } };
      } },
    ];
    const complete = vi.fn<Model['complete']>(async request => {
      const evidence = JSON.parse(request.messages[0]!.content as string) as { frames: unknown[]; requirements: { id: string }[] };
      expect(evidence.frames).toEqual(observation(timestamps).frames);
      return { toolCalls: [{ id: 'judgment' as never, name: 'report_semantic_checks', input: { checks: evidence.requirements.map(requirement => ({ requirementId: requirement.id, outcome: 'passed', detail: '0 至 1.2 秒逐帧均为红色矩形。' })) } }] };
    });
    const check = new CheckVideoSemanticsTool(() => session.events(), { model: { complete }, mediaTools, vision });
    const registry = new InMemoryToolRegistry();
    registry.register(check);
    for (const tool of [...mediaTools, vision]) registry.register(tool);
    const router = new ToolRouter(registry);
    const checkInput = { outputItemId: item.id, candidatePath: candidate };
    const result = await router.execute({ id: context.toolCallId, name: check.name, input: checkInput }, context);
    expect(result).toMatchObject({ status: 'success', output: { coverage: 'all-frames-and-transcript', frameCount: 7, candidateSha256: expect.any(String), checks: [{ outcome: 'passed' }], evidence: { frames: observation(timestamps).frames } } });
    expect(raw.execute).toHaveBeenCalledTimes(2);
    expect((raw.execute as ReturnType<typeof vi.fn>).mock.calls.map(call => (call[0] as { images: unknown[] }).images.length)).toEqual([6, 1]);
    expect(complete).toHaveBeenCalledOnce();
    expect((await readdir(item.workingDirectory)).some(name => name.startsWith('.semantic-'))).toBe(false);
    // 内部观察归入 check_video_semantics 证据；不伪造独立公开调用事件。
    expect(session.events().filter(event => event.type === 'tool.called' && event.name === 'analyze_images')).toEqual([]);
    const missingCheck = new CheckVideoSemanticsTool(() => session.events(), { model: { complete }, mediaTools });
    const missingRegistry = new InMemoryToolRegistry();
    missingRegistry.register(missingCheck);
    for (const tool of mediaTools) missingRegistry.register(tool);
    const missing = await new ToolRouter(missingRegistry).execute({ id: context.toolCallId, name: missingCheck.name, input: checkInput }, context);
    expect(missing).toMatchObject({ status: 'success', output: { coverage: 'incomplete', checks: [{ outcome: 'blocked' }] } });
    expect(complete).toHaveBeenCalledOnce();
  });
});
