import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import type { ApprovalRequest } from '@agent-desktop/client';

interface Part { type: string; text?: string; image_url?: string | { url: string } }
interface ModelInput {
  model: string;
  messages?: { role: string; content: string | Part[] | null; tool_calls?: { function: { name: string } }[] }[];
  input?: { role: string; content: Part[] }[];
  tools?: { function: { name: string } }[];
  max_tokens?: number;
  max_output_tokens?: number;
}
interface Record { scenario: string; tools: string[]; invokedTools: string[]; results: string[] }

// 仅模型协议响应和原生文件选择器使用夹具；安装、MCP 子进程、目录授权和交付事实保持真实。
test('real Windows Vision installation, local protocols, approvals and lifecycle', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32' || testInfo.project.name !== 'chromium-desktop', 'Windows x64 真实桌面验收。');
  test.setTimeout(600_000);
  const root = resolve('../..');
  const executable = process.env.DESKTOP_ACCEPTANCE_EXECUTABLE;
  const evidence = resolve(root, 'logs/vision-plugin', `${executable ? 'installed' : 'electron'}-${Date.now()}`);
  const profile = process.env.DESKTOP_ACCEPTANCE_PROFILE ?? resolve(evidence, '用户 数据');
  if (profile === '') throw new Error('DESKTOP_ACCEPTANCE_PROFILE 不能为空；请移除该变量以使用隔离验收目录。');
  const workspace = resolve(evidence, '已授权 图片');
  await mkdir(workspace, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=', 'base64');
  const image = resolve(workspace, '中文 图片.png');
  const unselected = resolve(evidence, '未授权 图片.png');
  await writeFile(image, png); await writeFile(unselected, png);
  const records: Record[] = [];
  const uploads: { protocol: string; model: string; timestamps: number[]; maxOutputTokens?: number }[] = [];
  const fixtureErrors: string[] = [];
  const allApprovals: ApprovalRequest[] = [];
  const chainStatus: { scenario: string; status: 'PASS' | 'SKIP'; reason?: string }[] = [];
  let networkMode: 'normal' | 'malformed' | 'hold' = 'normal';
  let uploadCancelled = false;
  let selectedVideo = '';
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += String(chunk);
      const input = JSON.parse(body) as ModelInput;
      if (request.url?.startsWith('/vision/')) {
        const chat = request.url === '/vision/chat/completions';
        expect(chat || request.url === '/vision/responses').toBe(true);
        const parts = chat ? input.messages![0]!.content as Part[] : input.input![0]!.content;
        const timestamps = parts.filter(part => part.text?.startsWith('Image ')).map(part => Number(/corresponds to ([\d.]+) seconds/.exec(part.text!)![1]));
        const pictures = parts.filter(part => ['image_url', 'input_image'].includes(part.type));
        expect(pictures).toHaveLength(timestamps.length);
        for (const picture of pictures) {
          const url = typeof picture.image_url === 'string' ? picture.image_url : picture.image_url!.url;
          expect(url).toMatch(/^data:image\/(png|jpeg);base64,/);
          if (url.startsWith('data:image/png;')) expect(Buffer.from(url.split(',')[1]!, 'base64')).toEqual(png);
        }
        expect(input.model).toBe('vision-fixture');
        expect(chat ? input.max_tokens : input.max_output_tokens).toBe(2048);
        expect(request.headers.authorization).toBe('Bearer offline-vision-secret');
        uploads.push({ protocol: chat ? 'chat-completions' : 'responses', model: input.model, timestamps,
          maxOutputTokens: chat ? input.max_tokens! : input.max_output_tokens! });
        if (networkMode === 'hold') { response.once('close', () => { uploadCancelled = true; }); return; }
        const frames = timestamps.map(timestamp => ({ timestamp, description: '参考图片或红色视频帧', subjects: [], actions: [], scene: '离线协议夹具', visibleText: [] }));
        const analysis = networkMode === 'malformed' ? { summary: '不完整观察', frames: [] } : { summary: '离线视觉观察', frames };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(chat ? { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analysis) } }] }
          : { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(analysis) }] }] }));
        return;
      }
      const messages = input.messages!;
      const tools = input.tools!.map(tool => tool.function.name);
      const userIndex = messages.findLastIndex(message => message.role === 'user');
      const user = messages[userIndex]?.content;
      const scenario = typeof user === 'string' ? /CASE:([\w-]+)/.exec(user)?.[1] : undefined;
      const results = messages.slice(userIndex + 1).filter(message => message.role === 'tool').map(message => message.content as string);
      const invokedTools = messages.slice(userIndex + 1).filter(message => message.role === 'assistant').flatMap(message => message.tool_calls?.map(call => call.function.name) ?? []);
      let next: { name: string; input: object } | undefined;
      if (tools.includes('report_semantic_checks')) {
        const facts = JSON.parse(user as string) as { requirements: { id: string }[]; frames: { timestamp: number }[]; transcript: { text?: string; hasAudio?: boolean } };
        expect(facts.frames.length).toBeGreaterThan(0);
        if (facts.transcript.hasAudio !== false) expect(facts.transcript.text?.trim()).toBeTruthy();
        await writeFile(resolve(evidence, `judge-${Date.now()}.json`), JSON.stringify(facts, null, 2));
        next = { name: 'report_semantic_checks', input: { checks: facts.requirements.map(item => ({ requirementId: item.id, outcome: 'passed', detail: '本地协议夹具按完整帧观察返回结构化判定。' })) } };
      } else if (scenario !== undefined && tools.length > 0) {
        records.push({ scenario, tools, invokedTools, results });
        const disabled = ['missing', 'missing-model', 'missing-key', 'disabled', 'uninstalled', 'restart-disabled'].includes(scenario);
        if (!disabled) {
          const sequence: { name: string; input: object }[] = [{ name: 'set_working_directory', input: { path: workspace } },
            { name: 'analyze_images', input: { images: [{ path: scenario === 'unauthorized' ? unselected : image, timestamp: 1.25 }] } }];
          if (scenario.startsWith('semantic') || scenario === 'full-chain') {
            const full = scenario === 'full-chain';
            const declarationIndex = full ? 1 : 0;
            const item = results[declarationIndex] === undefined ? undefined
              : (JSON.parse(results[declarationIndex]!) as { items: { id: string; workingDirectory: string }[] }).items[0]!;
            const candidatePath = item === undefined ? '' : resolve(item.workingDirectory, 'candidate.mp4');
            const identity = { outputItemId: item?.id, candidatePath };
            sequence.splice(0, sequence.length,
              ...(full ? [{ name: 'load_skill', input: { id: 'plugin:video-editing/semantic-editing' } }] : []),
              { name: 'declare_video_outputs', input: { items: [{ sourcePaths: [selectedVideo], target: { kind: 'automatic' }, requirements: [{ kind: 'semantic', description: '画面为红色' }] }] } },
              { name: 'trim_video', input: { inputPath: selectedVideo, outputPath: candidatePath, start: 0, duration: full ? 3 : 0.6 } },
              { name: 'decode_video', input: { inputPath: candidatePath } },
              { name: 'check_video_semantics', input: identity }, { name: 'validate_video_candidate', input: identity },
              { name: 'publish_video_output', input: { validationId: results[declarationIndex + 4] === undefined ? ''
                : (JSON.parse(results[declarationIndex + 4]!) as { validation: { id: string } }).validation.id } });
          }
          next = sequence[results.length];
        }
      }
      const delta = next === undefined ? { content: scenario === undefined ? '离线视觉验收' : `完成 ${scenario}` }
        : { tool_calls: [{ index: 0, id: `call-${scenario ?? 'judge'}-${results.length}`, function: { name: next.name, arguments: JSON.stringify(next.input) } }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { fixtureErrors.push(String(error)); response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('本地模型夹具未启动。');
  const origin = `http://127.0.0.1:${address.port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DESKTOP_RENDERER_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'FFMPEG_PATH', 'FFPROBE_PATH', 'WHISPER_CLI_PATH', 'WHISPER_MODEL_PATH']) delete env[key];
  env.PATH = `${process.env.SystemRoot}/System32;${process.env.SystemRoot}`;
  const executablePath = executable ?? createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const launch = () => _electron.launch({ executablePath, args: [...(executable ? [] : ['.']), `--user-data-dir=${profile}`, '--proxy-server=http://127.0.0.1:9'], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof app>['firstWindow']>>;
  const observeApprovals = () => page.evaluate(() => {
    const state = window as unknown as { approvals: ApprovalRequest[]; decision: 'allow' | 'deny' | 'hold' | 'deny-start'; held?: ApprovalRequest };
    state.approvals = []; state.decision = 'allow'; delete state.held;
    window.agentDesktop.onAgentEvent(event => {
      if (event.type !== 'approval.requested') return;
      state.approvals.push(event.request);
      if (event.request.kind === 'plugin-tool' && event.request.serverName === 'vision' && state.decision === 'hold') { state.held = event.request; return; }
      const denied = event.request.kind === 'plugin-start' && event.request.serverName === 'vision' && state.decision === 'deny-start'
        || event.request.kind === 'plugin-tool' && event.request.serverName === 'vision' && state.decision === 'deny';
      void window.agentDesktop.decideApproval(event.request.requestId, !denied);
    });
  });
  const approvals = () => page.evaluate(() => (window as unknown as { approvals: ApprovalRequest[] }).approvals);
  const configureVision = (protocol: 'chat-completions' | 'responses') => page.evaluate(async ({ origin, protocol }) => {
    await window.agentDesktop.saveRuntimeSettings({ modelProvider: { id: 'offline-vision', displayName: '离线 Vision', apiKey: 'offline-vision-secret', baseUrl: `${origin}/vision`, protocol,
      models: [{ id: 'vision-fixture', displayName: '离线图片模型', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' }, maxOutputTokens: 2048 }] }, fallbackVisionModel: { providerId: 'offline-vision', modelId: 'vision-fixture' }, fallbackVisionEnabled: true });
  }, { origin, protocol });
  const start = async (scenario: string, video?: string) => {
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await page.getByRole('button', { name: '新会话', exact: true }).click();
    if (video !== undefined) {
      selectedVideo = video;
      await app!.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, video);
      await page.getByRole('button', { name: '选择输入文件', exact: true }).click();
    }
    await page.getByRole('textbox', { name: '剪辑需求' }).fill(`CASE:${scenario}`);
    await expect(page.getByRole('textbox', { name: '剪辑需求' })).toHaveValue(`CASE:${scenario}`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.user-message-content p')).toHaveText(`CASE:${scenario}`);
  };
  const finish = async (scenario: string) => {
    const reply = page.locator('.agent-response').filter({ hasText: `完成 ${scenario}` });
    await expect(reply).toBeVisible({ timeout: 120_000 });
    // 场景身份必须完全一致；子串匹配曾误认末尾多出字符的另一场景。
    await expect(reply).toHaveText(`完成 ${scenario}`);
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    const record = records.findLast(entry => entry.scenario === scenario)!;
    expect(record).toBeDefined();
    await writeFile(resolve(evidence, `${scenario}.json`), JSON.stringify(record, null, 2));
    return record;
  };
  const run = async (scenario: string, video?: string) => { await start(scenario, video); return finish(scenario); };
  const expectObservation = (record: Record) => {
    expect(record.tools.filter(name => name === 'analyze_images')).toHaveLength(1);
    expect(JSON.parse(record.results[1]!)).toMatchObject({ summary: '离线视觉观察', frames: [{ timestamp: 1.25, description: '参考图片或红色视频帧' }] });
  };
  try {
    app = await launch(); page = await app.firstWindow(); await page.waitForLoadState(); await observeApprovals();
    await page.evaluate(async origin => {
      await window.agentDesktop.saveRuntimeSettings({ memoryEnabled: false, modelProvider: { id: 'offline-text', displayName: '离线对话', apiKey: 'offline-text-secret', baseUrl: `${origin}/conversation`, protocol: 'chat-completions',
        models: [{ id: 'text-fixture', displayName: '离线对话模型', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' } }] }, conversationModel: { providerId: 'offline-text', modelId: 'text-fixture' }, fallbackVisionModel: null, fallbackVisionEnabled: false });
      for (const plugin of (await window.agentDesktop.extensions.list()).plugins) if (plugin.installed && plugin.enabled) await window.agentDesktop.extensions.setEnabled(plugin.id, false);
    }, origin);
    expect((await run('missing')).tools).not.toContain('analyze_images');
    const existing = (await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(plugin => plugin.id === 'plugin:vision');
    if (existing?.installed) await page.evaluate(() => window.agentDesktop.extensions.uninstall('plugin:vision'));
    await page.getByRole('button', { name: '插件和技能', exact: true }).click();
    await page.getByRole('button', { name: '安装 Vision', exact: true }).click();
    await expect(page.locator('.extension-toast')).toContainText('Vision 插件已安装', { timeout: 60_000 });
    expect((await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(plugin => plugin.id === 'plugin:vision')).toMatchObject({ installed: true, enabled: true });
    expect((await run('missing-model')).tools).not.toContain('analyze_images');
    await page.evaluate(async origin => window.agentDesktop.saveRuntimeSettings({ modelProvider: { id: 'offline-no-key', displayName: '未配置密钥', baseUrl: `${origin}/vision`, protocol: 'chat-completions',
      models: [{ id: 'vision-fixture', displayName: '离线图片模型', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' } }] }, fallbackVisionModel: { providerId: 'offline-no-key', modelId: 'vision-fixture' }, fallbackVisionEnabled: false }), origin);
    expect((await run('missing-key')).tools).not.toContain('analyze_images');
    expect(uploads).toHaveLength(0);
    await configureVision('chat-completions');
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'hold'; });
    await start('chat');
    const approval = page.getByRole('region', { name: '操作审批' });
    await expect(approval).toContainText(origin);
    await expect(approval).toContainText('analyze_images');
    await expect(approval).toContainText(JSON.stringify(image).slice(1, -1));
    expect(await approval.innerText()).not.toContain('offline-vision-secret');
    expect(uploads).toHaveLength(0);
    await page.screenshot({ path: resolve(evidence, 'upload-approval.png') });
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'allow'; });
    await approval.getByRole('button', { name: '允许', exact: true }).click();
    const chat = await finish('chat'); expectObservation(chat);
    expect(chat.tools).not.toContain('probe_media'); expect(chat.tools).not.toContain('transcribe_audio');
    expect(uploads[0]).toMatchObject({ protocol: 'chat-completions', model: 'vision-fixture', timestamps: [1.25], maxOutputTokens: 2048 });
    await configureVision('responses'); expectObservation(await run('responses'));
    expect(uploads.at(-1)).toMatchObject({ protocol: 'responses', timestamps: [1.25], maxOutputTokens: 2048 });
    const uploadCount = uploads.length;
    expect((await run('unauthorized')).results[1]).toContain('授权'); expect(uploads).toHaveLength(uploadCount);
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'deny'; });
    expect((await run('denied')).results[1]).toContain('用户拒绝'); expect(uploads).toHaveLength(uploadCount);
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'deny-start'; });
    expect((await run('denied-start')).results[1]).toContain('用户拒绝了插件服务启动'); expect(uploads).toHaveLength(uploadCount);
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'allow'; });
    networkMode = 'malformed'; expect((await run('malformed')).results[1]).toContain('逐图片 frames'); networkMode = 'normal';
    networkMode = 'hold'; await start('cancel');
    await expect.poll(() => uploads.length).toBe(uploadCount + 2);
    const processName = basename(executablePath).replaceAll("'", "''");
    const pids = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='${processName}'" | Where-Object { $_.CommandLine -like '*vision.cjs*' -and $_.CommandLine.Contains('${profile.replaceAll("'", "''")}') } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8', windowsHide: true }).trim();
    const activePids = pids(); expect(activePids).not.toBe('');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await expect.poll(pids).toBe(''); await expect.poll(() => uploadCancelled).toBe(true); networkMode = 'normal';
    await writeFile(resolve(evidence, 'cancel.json'), JSON.stringify({ before: activePids, after: pids(), uploadCancelled }, null, 2));
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:vision', false));
    expect((await run('disabled')).tools).not.toContain('analyze_images');
    allApprovals.push(...await approvals());
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForLoadState(); await observeApprovals();
    expect((await run('restart-disabled')).tools).not.toContain('analyze_images');
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:vision', true));
    expectObservation(await run('restart-enabled'));

    const ffmpeg = process.env.DESKTOP_ACCEPTANCE_FFMPEG;
    if (ffmpeg === undefined) chainStatus.push({ scenario: 'FFmpeg + Vision', status: 'SKIP', reason: '未设置 DESKTOP_ACCEPTANCE_FFMPEG，未生成真实视频。' });
    else {
      const video = resolve(evidence, '红色 无音轨.mp4');
      execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5:d=1', '-c:v', 'libx264', video], { windowsHide: true });
      const existingFfmpeg = (await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(plugin => plugin.id === 'plugin:ffmpeg');
      await page.evaluate(async installed => { if (installed) await window.agentDesktop.extensions.setEnabled('plugin:ffmpeg', true); else await window.agentDesktop.extensions.install('plugin:ffmpeg'); }, existingFfmpeg?.installed === true);
      const semantic = await run('semantic', video);
      expect(JSON.parse(semantic.results[3]!)).toMatchObject({ coverage: 'all-frames-and-transcript', frameCount: 3, checks: [{ outcome: 'passed' }] });
      expect(JSON.parse(semantic.results[4]!).validation.checks.every((check: { outcome: string }) => check.outcome === 'passed')).toBe(true);
      const published = (JSON.parse(semantic.results[5]!) as { output: { path: string } }).output.path;
      expect((await stat(published)).size).toBeGreaterThan(0);
      const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', published, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
      expect(pixels[0]).toBeGreaterThan(240); expect(pixels[1]).toBeLessThan(10); expect(pixels[2]).toBeLessThan(10);
      const working = (JSON.parse(semantic.results[0]!) as { items: { workingDirectory: string }[] }).items[0]!.workingDirectory;
      expect((await readdir(working)).some(name => name.startsWith('.semantic-'))).toBe(false);
      chainStatus.push({ scenario: 'FFmpeg + Vision', status: 'PASS' });
      await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:vision', false));
      const blocked = await run('semantic-vision-disabled', video);
      expect(JSON.parse(blocked.results[3]!)).toMatchObject({ coverage: 'incomplete', checks: [{ outcome: 'blocked', detail: expect.stringContaining('视觉') }] });
      expect(JSON.parse(blocked.results[4]!).validation.checks.some((check: { outcome: string }) => check.outcome === 'blocked')).toBe(true);
      expect(blocked.results[5]).toContain('不能发布');
      await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:vision', true));
      const audio = process.env.DESKTOP_ACCEPTANCE_AUDIO;
      const model = (await page.evaluate(() => window.agentDesktop.extensions.list())).whisperModel;
      if (audio === undefined || model?.status !== 'ready') chainStatus.push({ scenario: 'Skill + FFmpeg + Vision + Whisper', status: 'SKIP', reason: '需要 DESKTOP_ACCEPTANCE_AUDIO 语音素材及隔离配置中已就绪的 Whisper 模型。' });
      else {
        const spoken = resolve(evidence, '红色 有对白.mp4');
        execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5:d=3', '-i', audio, '-c:v', 'libx264', '-c:a', 'aac', '-t', '3', '-shortest', spoken], { windowsHide: true });
        await page.evaluate(async () => { for (const id of ['plugin:whisper', 'plugin:video-editing']) {
          const plugin = (await window.agentDesktop.extensions.list()).plugins.find(item => item.id === id);
          if (plugin?.installed) await window.agentDesktop.extensions.setEnabled(id, true); else await window.agentDesktop.extensions.install(id);
        } });
        const full = await run('full-chain', spoken);
        expect(full.invokedTools).toContain('load_skill');
        expect(JSON.parse(full.results[4]!)).toMatchObject({ coverage: 'all-frames-and-transcript', checks: [{ outcome: 'passed' }] });
        expect(JSON.parse(full.results[4]!).evidence.transcript.text.trim()).toBeTruthy();
        expect(JSON.parse(full.results[5]!).validation.checks.every((check: { outcome: string }) => check.outcome === 'passed')).toBe(true);
        expect((await stat((JSON.parse(full.results[6]!) as { output: { path: string } }).output.path)).size).toBeGreaterThan(0);
        expect((await approvals()).some(request => request.kind === 'plugin-tool' && request.serverName === 'whisper')).toBe(true);
        chainStatus.push({ scenario: 'Skill + FFmpeg + Vision + Whisper', status: 'PASS' });
      }
    }
    await page.evaluate(() => window.agentDesktop.extensions.uninstall('plugin:vision'));
    expect((await run('uninstalled')).tools).not.toContain('analyze_images');
    await page.evaluate(() => window.agentDesktop.extensions.install('plugin:vision')); expectObservation(await run('reinstalled'));
    if (executable !== undefined) {
      const appPath = await app.evaluate(({ app }) => app.getAppPath());
      const manifest = resolve(appPath, 'resources/plugins/vision/.codex-plugin/plugin.json');
      const mcp = resolve(appPath, 'resources/plugins/vision/.mcp.json');
      const originalManifest = await readFile(manifest, 'utf8'); const originalMcp = await readFile(mcp, 'utf8');
      const oldVersion = (JSON.parse(originalManifest) as { version: string }).version;
      try {
        // 隔离安装的元数据升级验证原子替换及历史恢复，不假设已经有线上新版。
        await writeFile(manifest, JSON.stringify({ ...JSON.parse(originalManifest), version: '1.0.1' }));
        await writeFile(mcp, '{ invalid JSON');
        const failure = await page.evaluate(async () => { try { await window.agentDesktop.extensions.manage({ action: 'update', id: 'plugin:vision' }); return ''; } catch (error) { return (error as Error).message; } });
        expect(failure).not.toBe('');
        // 先直接核对已安装副本未被失败来源覆盖；目录列表还会读取损坏的可用来源。
        expect(JSON.parse(await readFile(resolve(profile, 'extensions/plugins/vision/.codex-plugin/plugin.json'), 'utf8')).version).toBe(oldVersion);
        await writeFile(mcp, originalMcp);
        expect((await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(plugin => plugin.id === 'plugin:vision')?.version).toBe(oldVersion);
        expectObservation(await run('failed-update-preserved'));
        const updated = await page.evaluate(() => window.agentDesktop.extensions.manage({ action: 'update', id: 'plugin:vision' }));
        const plugin = updated!.plugins.find(item => item.id === 'plugin:vision')!;
        expect(plugin.version).toBe('1.0.1'); expectObservation(await run('updated'));
        const versionId = plugin.versions!.find(version => version.version === oldVersion)!.id;
        const restored = await page.evaluate(versionId => window.agentDesktop.extensions.manage({ action: 'rollback', id: 'plugin:vision', versionId }), versionId);
        expect(restored!.plugins.find(item => item.id === 'plugin:vision')?.version).toBe(oldVersion); expectObservation(await run('rolled-back'));
        await writeFile(resolve(evidence, 'version-lifecycle.json'), JSON.stringify({ failedUpdate: failure, oldVersion, updated: plugin.version, restored: oldVersion }, null, 2));
      } finally { await writeFile(manifest, originalManifest); await writeFile(mcp, originalMcp); }
    }
    allApprovals.push(...await approvals());
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForLoadState(); await observeApprovals();
    expectObservation(await run('restart'));
    expect(fixtureErrors).toEqual([]);
    await page.screenshot({ path: resolve(evidence, 'restart.png') });
    await writeFile(resolve(evidence, 'summary.json'), JSON.stringify({ profile, executable: executable ?? null, records, uploads, chainStatus,
      approvals: [...allApprovals, ...await approvals()], remoteApiSpend: false }, null, 2));
  } finally {
    await writeFile(resolve(evidence, 'requests.json'), JSON.stringify({ records, uploads, fixtureErrors, chainStatus }, null, 2));
    try { await app?.close(); } finally { await new Promise<void>(done => server.close(() => done())); }
  }
});
