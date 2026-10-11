import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import type { ApprovalRequest } from '@agent-desktop/client';

interface ModelInput {
  messages: { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] }[];
  tools: { function: { name: string } }[];
  response_format?: unknown;
}
interface Evidence { scenario: string; tools: string[]; results: string[] }

test('real Desktop Probe plugin permissions, lifecycle and semantic delivery', async ({}, testInfo) => {
  test.setTimeout(420_000);
  test.skip(testInfo.project.name !== 'chromium-desktop' || process.platform !== 'win32', 'Windows 真实桌面验收。');
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/probe-media-plugin', `electron-${Date.now()}`);
  const profile = resolve(evidence, 'profile');
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
    const names = input.tools.map(tool => tool.function.name);
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
      } else if (scenario === 'delivery') {
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
  const executablePath = createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const launch = () => _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
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
    await expect(page.getByText(`完成 ${scenario}`, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    return requests.findLast(entry => entry.scenario === scenario)!;
  };
  try {
    app = await launch(); page = await app.firstWindow(); await observeApprovals();
    await page.evaluate(async baseUrl => {
      await window.agentDesktop.extensions.install('plugin:ffmpeg');
      await window.agentDesktop.saveRuntimeSettings({ memoryEnabled: false, whisperModelPath: null,
        modelProvider: { id: 'fixture', displayName: '模型夹具', apiKey: 'fixture-key', baseUrl, protocol: 'chat-completions', models: [{ id: 'fixture', displayName: 'fixture', images: true }] },
        conversationModel: { providerId: 'fixture', modelId: 'fixture' }, visionModel: { providerId: 'fixture', modelId: 'fixture' } });
    }, `http://127.0.0.1:${address.port}`);
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, source);
    await page.getByRole('button', { name: '选择输入文件', exact: true }).click();
    const probed = await run('probe');
    expect(probed.tools.filter(name => name === 'probe_media')).toHaveLength(1);
    expect(JSON.parse(probed.results[0]!)).toEqual({ inputPath: source, duration: 1, width: 160, height: 120, videoCodec: 'h264', audioCodec: null });
    expect((await approvals()).map(request => request.kind)).toEqual(['plugin-start', 'plugin-tool']);
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
    const pids = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*ffmpeg.cjs*' -and $_.CommandLine.Contains('${profile.replaceAll("'", "''")}') } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8', windowsHide: true }).trim();
    const activePids = pids(); expect(activePids).not.toBe('');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await expect.poll(pids).toBe('');
    cancellationProcesses = { before: activePids, after: pids() };
    await page.evaluate(() => { (window as unknown as { decision: string }).decision = 'allow'; });
    const before = (await approvals()).filter(request => request.kind === 'plugin-tool').length;
    const delivered = await run('delivery');
    expect((await approvals()).filter(request => request.kind === 'plugin-tool')).toHaveLength(before + 5);
    expect(JSON.parse(delivered.results[4]!), delivered.results[4]).toMatchObject({ coverage: 'all-frames-and-transcript', frameCount: 3, checks: [{ outcome: 'passed' }] });
    const validation = JSON.parse(delivered.results[5]!) as { validation: { checks: { outcome: string; evidenceToolCallIds: string[] }[] } };
    expect(validation.validation.checks.every(check => check.outcome === 'passed')).toBe(true);
    expect(validation.validation.checks[1]?.evidenceToolCallIds).toEqual(['delivery-3']);
    const published = JSON.parse(delivered.results[6]!) as { output: { path: string } };
    const media = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', published.output.path], { encoding: 'utf8' })) as { format: { duration: string }; streams: { width: number }[] };
    expect(Number(media.format.duration)).toBeCloseTo(0.6); expect(media.streams[0]?.width).toBe(160); expect(imageCount).toBe(3);
    const pixels = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', published.output.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    expect(pixels[0]).toBeGreaterThan(240); expect(pixels[1]).toBeLessThan(10); expect(pixels[2]).toBeLessThan(10);
    await page.screenshot({ path: resolve(evidence, 'published.png') });
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:ffmpeg', false));
    const disabled = await run('disabled'); expect(disabled.tools).not.toContain('probe_media'); expect(disabled.tools).not.toContain('trim_video');
    const blocked = await run('blocked');
    expect(JSON.parse(blocked.results[0]!)).toMatchObject({ checks: [{ outcome: 'blocked', detail: expect.stringContaining('probe_media') }] });
    expect(JSON.parse(blocked.results[1]!).validation.checks[2]).toMatchObject({ outcome: 'blocked', detail: expect.stringContaining('probe_media') });
    expect(blocked.results[2]).toContain('不能发布');
    allApprovals.push(...await approvals());
    await app.close(); app = await launch(); page = await app.firstWindow(); await observeApprovals();
    expect((await run('restart-disabled')).tools).not.toContain('probe_media');
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:ffmpeg', true));
    expect((await run('enabled')).tools).toContain('probe_media');
    await page.evaluate(() => window.agentDesktop.extensions.uninstall('plugin:ffmpeg'));
    expect((await run('uninstalled')).tools).not.toContain('probe_media');
    await page.evaluate(() => window.agentDesktop.extensions.install('plugin:ffmpeg'));
    expect((await run('reinstalled')).tools).toContain('probe_media');
    allApprovals.push(...await approvals());
    await app.close(); app = await launch(); page = await app.firstWindow(); await observeApprovals();
    expect((await run('restart-enabled')).results[0]).toContain('h264');
    await writeFile(resolve(evidence, 'evidence.json'), JSON.stringify({ ffprobe, source, published, requests,
      approvals: [...allApprovals, ...await approvals()], cancellationProcesses, imageCount }, null, 2));
    expect((await readFile(published.output.path)).length).toBeGreaterThan(0);
  } finally {
    await writeFile(resolve(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
    try { await app?.close(); }
    finally { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
  }
});
