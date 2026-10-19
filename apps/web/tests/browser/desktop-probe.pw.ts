import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import type { ApprovalRequest } from '@agent-desktop/client';
import { UNKNOWN_MODEL_CAPABILITIES } from '@agent-desktop/client/model-capabilities';
import { cleanupDesktopAcceptance } from './desktop-acceptance-cleanup.js';

interface ModelInput {
  messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[];
  tools?: { function: { name: string } }[];
  response_format?: unknown;
}
interface Evidence { scenario: string; tools: string[]; results: string[] }

test('real Desktop Probe plugin permissions, lifecycle and semantic delivery', async ({}, testInfo) => {
  test.setTimeout(420_000);
  test.skip(testInfo.project.name !== 'chromium-desktop' || process.platform !== 'win32', 'Windows 真实桌面验收。');
  const root = resolve('../..');
  const packagedExecutable = process.env.DESKTOP_ACCEPTANCE_EXECUTABLE;
  const evidence = resolve(root, 'logs/ffmpeg-plugin', `${packagedExecutable === undefined ? 'electron' : 'installed'}-${Date.now()}`);
  const profile = resolve(evidence, '用户 数据');
  const workspace = resolve(evidence, 'workspace');
  const outside = resolve(evidence, 'attachments');
  await mkdir(workspace, { recursive: true }); await mkdir(outside, { recursive: true });
  const source = resolve(outside, '中文 video.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5:d=1', '-c:v', 'libx264', source]);
  await copyFile(source, resolve(workspace, 'local.mp4'));
  await copyFile(source, resolve(outside, 'unselected.mp4'));
  await symlink(outside, resolve(workspace, 'escape'), 'junction');
  const ffprobe = execFileSync('where.exe', ['ffprobe'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!;
  const requests: Evidence[] = []; const allApprovals: ApprovalRequest[] = []; let imageCount = 0;
  let lastCandidate: { outputItemId: string; candidatePath: string } | undefined;
  let cancellationProcesses: { before: string; after: string } | undefined;
  // 只替换模型网络响应及原生选择器；Electron、Loop、MCP、媒体进程、审批及磁盘事实都真实运行。
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body) as ModelInput;
    if (input.response_format !== undefined) {
      const parts = input.messages[0]!.content as Exclude<ModelInput['messages'][number]['content'], string>;
      const frames = parts.filter(part => part.type === 'text' && part.text?.startsWith('Image ')).map(part => ({
        timestamp: Number(/corresponds to ([\d.]+) seconds/.exec(part.text!)![1]), description: '红色矩形', subjects: ['矩形'], actions: [], scene: '红色', visibleText: [],
      }));
      for (const part of parts.filter(part => part.type === 'image_url')) expect(part.image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
      imageCount += frames.length;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '红色画面', frames }) } }] })); return;
    }
    const names = input.tools?.map(tool => tool.function.name) ?? [];
    let delta: object; let finish = 'stop';
    const call = (name: string, args: object, id: string) => { finish = 'tool_calls'; return { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }; };
    if (names.includes('report_semantic_checks')) {
      const facts = JSON.parse(input.messages.findLast(message => message.role === 'user')!.content as string) as { requirements: { id: string }[]; frames: unknown[] };
      expect(facts.frames).toHaveLength(3);
      delta = call('report_semantic_checks', { checks: facts.requirements.map(item => ({ requirementId: item.id, outcome: 'passed', detail: '0 至 0.6 秒均为红色矩形' })) }, 'judge');
    } else if (names.length === 0) delta = { content: 'Probe 真实验收' };
    else {
      const userIndex = input.messages.findLastIndex(message => message.role === 'user');
      const scenario = /CASE:([\w-]+)/.exec(input.messages[userIndex]!.content as string)![1]!;
      const results = input.messages.slice(userIndex + 1).filter(message => message.role === 'tool').map(message => message.content as string);
      const step = results.length;
      requests.push({ scenario, tools: names, results });
      if (scenario === 'blocked') {
        if (lastCandidate === undefined) throw new Error('停用验收缺少上一轮真实候选。');
        const actions: [string, object][] = [['check_video_semantics', lastCandidate], ['validate_video_candidate', lastCandidate],
          ['publish_video_output', { validationId: step > 1 ? (JSON.parse(results[1]!) as { validation: { id: string } }).validation.id : '' }]];
        delta = step < actions.length ? call(actions[step]![0], actions[step]![1], `${scenario}-${step}`) : { content: `完成 ${scenario}` };
      } else if (scenario === 'delivery' || scenario === 'delivery-failure') {
        const declared = step === 0 ? undefined : JSON.parse(results[0]!) as { items: { id: string; workingDirectory: string }[] };
        const item = declared?.items[0]; const candidatePath = item === undefined ? '' : resolve(item.workingDirectory, 'candidate.mp4');
        const check = { outputItemId: item?.id, candidatePath };
        if (item !== undefined) lastCandidate = { outputItemId: item.id, candidatePath };
        const actions: [string, object][] = [
          ['declare_video_outputs', { items: [{ sourcePaths: [source], target: { kind: 'automatic' }, requirements: [
            { kind: 'duration-range', minSeconds: 0.5, maxSeconds: 0.7 }, { kind: 'semantic', description: '完整画面是红色矩形' },
          ] }] }],
          ['trim_video', { inputPath: source, outputPath: candidatePath, start: 0, duration: 0.6 }],
          ['decode_video', { inputPath: candidatePath }],
          ['probe_media', { inputPath: candidatePath }],
          ['check_video_semantics', check], ['validate_video_candidate', check],
          ['publish_video_output', { validationId: step > 5 ? (JSON.parse(results[5]!) as { validation: { id: string } }).validation.id : '' }],
        ];
        // 文件已经真正发布后制造模型失败，反证错误过桥不会丢失此前的产物和任务投影。
        if (scenario === 'delivery-failure' && step === actions.length) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: '已交付文件后的模型请求失败。' } }));
          return;
        }
        delta = step < actions.length ? call(actions[step]![0], actions[step]![1], `${scenario}-${step}`) : { content: `完成 ${scenario}` };
      } else if (scenario === 'workspace' && step === 0) delta = call('set_working_directory', { path: workspace }, `${scenario}-${step}`);
      else if (['disabled', 'uninstalled', 'restart-disabled'].includes(scenario)) delta = { content: `完成 ${scenario}` };
      else if (step === (scenario === 'workspace' ? 1 : 0)) {
        const inputPath = scenario === 'workspace' ? 'local.mp4' : scenario === 'unauthorized' ? resolve(outside, 'unselected.mp4')
          : scenario === 'junction' ? resolve(workspace, 'escape/unselected.mp4') : scenario === 'url' ? 'https://example.com/video.mp4' : source;
        delta = call('probe_media', { inputPath }, `${scenario}-${step}`);
      } else delta = { content: `完成 ${scenario}` };
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('模型夹具未启动。');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE; delete env.DESKTOP_RENDERER_URL;
  delete env.FFPROBE_PATH; delete env.FFMPEG_PATH;
  // 应用和插件进程仅获得系统目录，不能通过开发机 PATH 找到 Node 或媒体程序。
  env.PATH = `${process.env.SystemRoot}/System32;${process.env.SystemRoot}`;
  const executablePath = packagedExecutable ?? createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const launch = async () => {
    const launched = await _electron.launch({ executablePath, args: [...(packagedExecutable === undefined ? ['.'] : []), `--user-data-dir=${profile}`, '--proxy-server=http://127.0.0.1:9'], cwd: resolve(root, 'apps/desktop'), env });
    // 手动创建的 Electron 上下文不由 Playwright 的 --trace 自动采集；保留真实页面故障现场。
    try { await launched.context().tracing.start({ screenshots: true, snapshots: true, sources: true }); }
    catch (error) { await launched.close(); throw error; }
    return launched;
  };
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  let traceNumber = 0;
  const close = async () => {
    if (app === undefined) return;
    const closing = app; app = undefined;
    try { await closing.context().tracing.stop({ path: testInfo.outputPath(`electron-${traceNumber++}.zip`) }); }
    finally { await closing.close(); }
  };
  let page: Awaited<ReturnType<NonNullable<typeof app>['firstWindow']>>;
  const observeApprovals = async () => page.evaluate(() => {
    const state = window as unknown as { approvals: ApprovalRequest[]; held?: ApprovalRequest; decision: 'allow' | 'deny' | 'hold' };
    state.approvals = []; state.decision = 'allow'; delete state.held;
    window.agentDesktop.onAgentEvent(event => {
      if (event.type !== 'approval.requested') return;
      state.approvals.push(event.request);
      if (event.request.kind === 'plugin-tool' && state.decision === 'hold') { state.held = event.request; return; }
      void window.agentDesktop.decideApproval(event.request.requestId, event.request.kind !== 'plugin-tool' || state.decision !== 'deny');
    });
  });
  const approvals = () => page.evaluate(() => (window as unknown as { approvals: ApprovalRequest[] }).approvals);
  const run = async (scenario: string) => {
    await page.getByRole('textbox', { name: '剪辑需求' }).fill(`CASE:${scenario}`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText(`完成 ${scenario}`, { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    return requests.findLast(entry => entry.scenario === scenario)!;
  };
  try {
    app = await launch(); page = await app.firstWindow(); await observeApprovals();
    await page.evaluate(async ({ baseUrl, capabilities }) => {
      const defaults = (await window.agentDesktop.extensions.list()).plugins;
      if (!defaults.every(plugin => plugin.installed && plugin.enabled)) throw new Error('基础插件未默认安装并启用。');
      for (const plugin of defaults.filter(plugin => plugin.id !== 'plugin:ffmpeg')) await window.agentDesktop.extensions.setEnabled(plugin.id, false);
      await window.agentDesktop.saveRuntimeSettings({ memoryEnabled: false,
        modelProvider: { id: 'fixture', displayName: '模型夹具', apiKey: 'fixture-key', baseUrl, protocol: 'chat-completions', models: [{ id: 'fixture', displayName: 'fixture', capabilities: { ...capabilities, textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' } }] },
        conversationModel: { providerId: 'fixture', modelId: 'fixture' }, fallbackVisionModel: { providerId: 'fixture', modelId: 'fixture' }, fallbackVisionEnabled: true });
    }, { baseUrl: `http://127.0.0.1:${address.port}`, capabilities: { ...UNKNOWN_MODEL_CAPABILITIES, tools: 'supported' as const, streaming: 'supported' as const, chatCompletions: 'supported' as const } });
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, source);
    await page.getByRole('button', { name: '选择输入文件', exact: true }).click();
    const probed = await run('probe');
    expect(probed.tools.filter(name => name === 'probe_media')).toHaveLength(1);
    expect(JSON.parse(probed.results[0]!)).toEqual({ inputPath: source, duration: 1, width: 160, height: 120, videoCodec: 'h264', audioCodec: null });
    // 准备动作先通过工具审批，再懒启动插件进程，不能在获准前连接外部服务。
    expect((await approvals()).map(request => request.kind)).toEqual(['plugin-tool', 'plugin-start']);
    await run('workspace');
    for (const scenario of ['unauthorized', 'junction', 'url']) {
      const count = (await approvals()).filter(request => request.kind === 'plugin-tool').length;
      expect((await run(scenario)).results[0]).toContain('probe_media');
      expect((await approvals()).filter(request => request.kind === 'plugin-tool')).toHaveLength(count);
    }
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'deny'; });
    expect((await run('deny')).results[0]).toContain('用户拒绝');
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'hold'; });
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('CASE:cancel');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { held?: ApprovalRequest }).held?.kind)).toBe('plugin-tool');
    const processName = basename(executablePath).replaceAll("'", "''");
    const pids = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='${processName}'" | Where-Object { $_.CommandLine -like '*ffmpeg.cjs*' -and $_.CommandLine.Contains('${profile.replaceAll("'", "''")}') } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8', windowsHide: true }).trim();
    // 工具审批尚未通过时不启动插件；取消等待也不能留下随后才启动的进程。
    const activePids = pids(); expect(activePids).toBe('');
    for (const action of ['update', 'uninstall', 'disable']) {
      const error = await page.evaluate(async action => {
        try {
          if (action === 'update') await window.agentDesktop.extensions.manage({ action: 'update', id: 'plugin:ffmpeg' });
          else if (action === 'uninstall') await window.agentDesktop.extensions.uninstall('plugin:ffmpeg');
          else await window.agentDesktop.extensions.setEnabled('plugin:ffmpeg', false);
          return '';
        } catch (error) { return (error as Error).message; }
      }, action);
      expect(error).toContain('任务执行期间');
    }
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await expect.poll(pids).toBe('');
    cancellationProcesses = { before: activePids, after: pids() };
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'allow'; });
    // 语义交付重新启用默认视觉插件；前面的 Probe 审批仍只覆盖 FFmpeg。
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:vision', true));
    const before = (await approvals()).filter(request => request.kind === 'plugin-tool').length;
    const delivered = await run('delivery');
    expect((await approvals()).filter(request => request.kind === 'plugin-tool')).toHaveLength(before + 6);
    expect((await approvals()).filter(request => request.kind === 'plugin-tool' && request.serverName === 'vision')).toHaveLength(1);
    expect(JSON.parse(delivered.results[4]!), delivered.results[4]).toMatchObject({ coverage: 'all-frames-and-transcript', frameCount: 3, checks: [{ outcome: 'passed' }] });
    const validation = JSON.parse(delivered.results[5]!) as { validation: { checks: { outcome: string; evidenceToolCallIds: string[] }[] } };
    expect(validation.validation.checks.every(check => check.outcome === 'passed')).toBe(true);
    expect(validation.validation.checks[1]?.evidenceToolCallIds).toEqual(['delivery-3']);
    const published = (JSON.parse(delivered.results[6]!) as { output: { output: { path: string } } }).output;
    const media = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', published.output.path], { encoding: 'utf8' })) as { format: { duration: string }; streams: { width: number }[] };
    expect(Number(media.format.duration)).toBeCloseTo(0.6); expect(media.streams[0]?.width).toBe(160); expect(imageCount).toBe(3);
    const pixels = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', published.output.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(pixels[0]).toBeGreaterThan(240); expect(pixels[1]).toBeLessThan(10); expect(pixels[2]).toBeLessThan(10);
    await page.screenshot({ path: resolve(evidence, 'published.png') });
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('CASE:delivery-failure');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const failedReply = page.getByRole('alert', { name: 'Agent 回复' }).filter({ hasText: 'Chat Completions API request failed: 400' });
    // 等待实际七工具媒体链及后续模型失败；并行真实模型验收负载下已复现五秒不足。
    await expect(failedReply).toContainText('任务失败', { timeout: 120_000 });
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    const failedDelivery = requests.findLast(entry => entry.scenario === 'delivery-failure')!;
    const failedPublished = (JSON.parse(failedDelivery.results[6]!) as { output: { output: { path: string } } }).output;
    await expect(failedReply.getByText(basename(failedPublished.output.path), { exact: true })).toHaveCount(2);
    await expect(failedReply.getByRole('button', { name: '打开文件' })).toBeVisible();
    await expect(failedReply.getByRole('button', { name: '继续未完成任务' })).toBeVisible();
    expect((await readFile(failedPublished.output.path)).length).toBeGreaterThan(0);
    await page.screenshot({ path: resolve(evidence, 'failure-after-publish.png') });
    await writeFile(resolve(evidence, 'failure-after-publish.json'), JSON.stringify({ published: failedPublished, requests: failedDelivery,
      clientState: await page.evaluate(() => window.agentDesktop.loadClientState()) }, null, 2));
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:ffmpeg', false));
    const disabled = await run('disabled'); expect(disabled.tools).not.toContain('probe_media'); expect(disabled.tools).not.toContain('trim_video');
    const blocked = await run('blocked');
    expect(JSON.parse(blocked.results[0]!)).toMatchObject({ checks: [{ outcome: 'blocked', detail: expect.stringContaining('probe_media') }] });
    expect(JSON.parse(blocked.results[1]!).validation.checks[2]).toMatchObject({ outcome: 'blocked', detail: expect.stringContaining('probe_media') });
    expect(blocked.results[2]).toContain('不能发布');
    allApprovals.push(...await approvals());
    await close(); app = await launch(); page = await app.firstWindow(); await observeApprovals();
    expect((await run('restart-disabled')).tools).not.toContain('probe_media');
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:ffmpeg', true));
    expect((await run('enabled')).tools).toContain('probe_media');
    await page.evaluate(() => window.agentDesktop.extensions.uninstall('plugin:ffmpeg'));
    expect((await run('uninstalled')).tools).not.toContain('probe_media');
    await page.evaluate(() => window.agentDesktop.extensions.install('plugin:ffmpeg'));
    expect((await run('reinstalled')).tools).toContain('probe_media');
    if (packagedExecutable !== undefined) {
      const appPath = await app.evaluate(({ app }) => app.getAppPath());
      const manifest = resolve(appPath, 'resources/plugins/ffmpeg/.codex-plugin/plugin.json');
      const originalManifest = await readFile(manifest, 'utf8');
      try {
        // 尚无线上新版；在隔离安装目录构造元数据升级，媒体二进制及工具契约保持原版。
        await writeFile(manifest, JSON.stringify({ ...JSON.parse(originalManifest), version: '1.0.1' }));
        const updated = await page.evaluate(() => window.agentDesktop.extensions.manage({ action: 'update', id: 'plugin:ffmpeg' }));
        if (updated === null) throw new Error('插件更新不能返回目录选择取消。');
        const plugin = updated.plugins.find(item => item.id === 'plugin:ffmpeg')!;
        expect(plugin.version).toBe('1.0.1');
        expect((await run('updated')).results[0]).toContain('h264');
        const versionId = plugin.versions!.find(item => item.version === '1.0.0')!.id;
        const restored = await page.evaluate(versionId => window.agentDesktop.extensions.manage({ action: 'rollback', id: 'plugin:ffmpeg', versionId }), versionId);
        if (restored === null) throw new Error('插件回滚不能返回目录选择取消。');
        expect(restored.plugins.find(item => item.id === 'plugin:ffmpeg')?.version).toBe('1.0.0');
        expect((await run('rolled-back')).results[0]).toContain('h264');
      } finally { await writeFile(manifest, originalManifest); }
    }
    allApprovals.push(...await approvals());
    await close(); app = await launch(); page = await app.firstWindow(); await observeApprovals();
    expect((await run('restart-enabled')).results[0]).toContain('h264');
    await writeFile(resolve(evidence, 'evidence.json'), JSON.stringify({ ffprobe, source, published, requests,
      approvals: [...allApprovals, ...await approvals()], cancellationProcesses, imageCount }, null, 2));
    expect((await readFile(published.output.path)).length).toBeGreaterThan(0);
  } finally {
    await writeFile(resolve(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
    try { await close(); }
    finally {
      try { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
      finally { await cleanupDesktopAcceptance(evidence, profile, true); }
    }
  }
});

test('installed application preserves plugin and session data after installer overwrite', async ({}, testInfo) => {
  const executablePath = process.env.DESKTOP_ACCEPTANCE_EXECUTABLE;
  const profile = process.env.DESKTOP_UPGRADE_PROFILE;
  if (profile === '') throw new Error('DESKTOP_UPGRADE_PROFILE 不能为空；请指定隔离配置目录或移除该变量。');
  test.skip(testInfo.project.name !== 'chromium-desktop' || process.platform !== 'win32' || executablePath === undefined || profile === undefined, '需要本机安装器覆盖后的隔离配置目录。');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE; delete env.DESKTOP_RENDERER_URL; delete env.FFMPEG_PATH; delete env.FFPROBE_PATH;
  env.PATH = `${process.env.SystemRoot}/System32;${process.env.SystemRoot}`;
  const app = await _electron.launch({ executablePath: executablePath!, args: [`--user-data-dir=${profile!}`], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('完成 restart-enabled', { exact: true })).toBeVisible();
    const restored = await page.evaluate(async () => ({ extensions: await window.agentDesktop.extensions.list(), state: await window.agentDesktop.loadClientState() }));
    expect(restored.extensions.plugins.find(plugin => plugin.id === 'plugin:ffmpeg')).toMatchObject({ installed: true, enabled: true, version: '1.0.0' });
    expect(JSON.stringify(restored.state)).toContain('restart-enabled');
    expect(JSON.stringify(restored.state)).toContain('中文 video.mp4');
    await page.screenshot({ path: resolve(profile!, '../upgrade-restored.png') });
  } finally { await app.close(); }
});

test('installed FFmpeg detail exposes real builtin update and rollback controls', async ({}, testInfo) => {
  test.setTimeout(60_000);
  const executablePath = process.env.DESKTOP_ACCEPTANCE_EXECUTABLE;
  const profile = process.env.DESKTOP_UPGRADE_PROFILE;
  if (profile === '') throw new Error('DESKTOP_UPGRADE_PROFILE 不能为空；请指定隔离配置目录或移除该变量。');
  test.skip(testInfo.project.name !== 'chromium-desktop' || process.platform !== 'win32' || executablePath === undefined || profile === undefined, '需要真实隔离安装目录与已安装插件配置。');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE; delete env.DESKTOP_RENDERER_URL;
  const app = await _electron.launch({ executablePath: executablePath!, args: [`--user-data-dir=${profile!}`], env });
  let manifest: string | undefined; let original: string | undefined;
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const snapshot = await window.agentDesktop.extensions.list();
      const plugin = snapshot.plugins.find(item => item.id === 'plugin:ffmpeg')!;
      if (plugin.version !== '1.0.0') {
        const versionId = plugin.versions!.find(item => item.version === '1.0.0')!.id;
        await window.agentDesktop.extensions.manage({ action: 'rollback', id: plugin.id, versionId });
      }
    });
    await page.getByRole('button', { name: '插件和技能', exact: true }).click();
    await page.getByRole('button', { name: '查看 FFmpeg', exact: true }).click();
    await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeVisible();
    const appPath = await app.evaluate(({ app }) => app.getAppPath());
    manifest = resolve(appPath, 'resources/plugins/ffmpeg/.codex-plugin/plugin.json');
    original = await readFile(manifest, 'utf8');
    await writeFile(manifest, JSON.stringify({ ...JSON.parse(original), version: '1.0.1' }));
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(page.getByRole('region', { name: '信息' })).toContainText('1.0.1');
    const evidence = resolve(profile!, '../builtin-update.png');
    await page.screenshot({ path: evidence });
    await page.getByText(/^1\.0\.0 ·/).first().locator('..').getByRole('button', { name: '回滚', exact: true }).click();
    await expect(page.getByRole('region', { name: '信息' })).toContainText('1.0.0');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600));
    await page.getByRole('button', { name: '更新至 1.0.1', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: '更新至 1.0.1', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(profile!, '../builtin-update-narrow.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    if (manifest !== undefined && original !== undefined) await writeFile(manifest, original);
    await app.close();
  }
});
