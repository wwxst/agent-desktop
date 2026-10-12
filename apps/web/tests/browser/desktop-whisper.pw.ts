import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import type { ApprovalRequest } from '@agent-desktop/client';

interface Input { messages: { role: string; content: string | null; tool_calls?: { function: { name: string } }[] }[]; tools: { function: { name: string } }[] }

test('real Windows Whisper installation, model download, recognition and lifecycle', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32' || testInfo.project.name !== 'chromium-desktop', 'Windows x64 原生验收。');
  test.setTimeout(1_800_000);
  const root = resolve('../..');
  const executable = process.env.DESKTOP_ACCEPTANCE_EXECUTABLE;
  const evidence = resolve(root, 'logs/whisper-plugin', `${executable ? 'installed' : 'electron'}-${Date.now()}`);
  const profile = process.env.DESKTOP_ACCEPTANCE_PROFILE ?? resolve(evidence, '用户 数据');
  await mkdir(evidence, { recursive: true });
  const chinese = resolve(evidence, '中文 普通话.wav');
  const english = resolve(evidence, 'English speech.wav');
  const mixed = resolve(evidence, '中英 mixed.wav');
  const longAudio = resolve(evidence, '长音频 70 秒.wav');
  const ffmpeg = resolve(root, 'logs/ffmpeg-plugin/vendor-runtime/ffmpeg-8.1.2-essentials_build/bin/ffmpeg.exe');
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const synthesize = (path: string, voice: string, text: string) => execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice(${literal(voice)}); $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile(${literal(path)}, $f); $s.Speak(${literal(text)}); $s.Dispose()`], { windowsHide: true });
  synthesize(chinese, 'Microsoft Huihui Desktop', '今天天气很好。我们准备出发去公园。请带上水和相机。');
  synthesize(english, 'Microsoft Zira Desktop', 'Today is a beautiful day. We are going to the park. Please bring water and a camera.');
  synthesize(mixed, 'Microsoft Huihui Desktop', '今天我们学习 English。请打开 camera，然后开始 recording。');
  synthesize(longAudio, 'Microsoft Zira Desktop', Array.from({ length: 60 }, () => 'Today is a beautiful day. We are going to the park. Please bring water and a camera.').join(' '));
  const silent = resolve(evidence, '静音.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', silent]);
  const video = resolve(evidence, '中文 视频.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5:d=8', '-i', english, '-c:v', 'libx264', '-c:a', 'aac', '-shortest', video]);
  const empty = resolve(evidence, 'empty.wav'); const invalid = resolve(evidence, 'invalid.wav');
  await writeFile(empty, ''); await writeFile(invalid, 'invalid RIFF data');
  const records: { scenario: string; tools: string[]; invokedTools: string[]; results: string[] }[] = [];
  let selectedPath = chinese;
  const server = createServer(async (request, response) => {
    try {
    let body = ''; for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { response_format?: unknown; messages: { content: { type: string; text?: string }[] }[] };
    if (payload.response_format !== undefined) {
      const frames = payload.messages[0]!.content.filter(part => part.type === 'text' && part.text?.startsWith('Image ')).map(part => ({
        timestamp: Number(part.text!.match(/corresponds to ([\d.]+) seconds/)![1]), description: '红色画面', subjects: [], actions: [], scene: '红色', visibleText: [],
      }));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: '红色画面', frames }) } }] }));
      return;
    }
    const input = JSON.parse(body) as Input;
    const names = input.tools.map(tool => tool.function.name);
    if (names.includes('report_semantic_checks')) {
      const data = JSON.parse(input.messages.find(message => message.role === 'user')!.content!) as { requirements: { id: string }[]; transcript: { text: string } };
      expect(data.transcript.text.toLowerCase()).toContain('camera');
      await writeFile(resolve(evidence, 'semantic-judge-input.json'), JSON.stringify(data, null, 2));
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'judge', function: { name: 'report_semantic_checks', arguments: JSON.stringify({ checks: data.requirements.map(requirement => ({ requirementId: requirement.id, outcome: 'passed', detail: '0 至 5.84 秒英文语音明确提到 camera。' })) }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const lastUser = input.messages.filter(message => message.role === 'user').at(-1)?.content;
    const scenario = typeof lastUser === 'string' ? lastUser.match(/CASE:([\w-]+)/)?.[1] ?? 'ordinary' : 'ordinary';
    const userIndex = input.messages.findLastIndex(message => message.role === 'user');
    const results = input.messages.slice(userIndex + 1).filter(message => message.role === 'tool').map(message => message.content);
    const invokedTools = input.messages.slice(userIndex + 1).filter(message => message.role === 'assistant').flatMap(message => message.tool_calls?.map(call => call.function.name) ?? []);
    if (names.length > 0) records.push({ scenario, tools: names, invokedTools, results: results.filter((result): result is string => result !== null) });
    const combined = scenario === 'combined';
    const calls = names.length === 0 ? [] : combined ? [{ name: 'set_working_directory', input: { path: evidence } }, { name: 'extract_audio', input: { videoPath: video, outputPath: resolve(evidence, 'derived.wav') } }, { name: 'transcribe_audio', input: { audioPath: resolve(evidence, 'derived.wav') } }]
      : scenario === 'skills' ? [{ name: 'load_skill', input: { id: 'plugin:video-editing/semantic-editing' } }, { name: 'transcribe_audio', input: { audioPath: selectedPath } }]
      : scenario === 'ordinary' || scenario === 'missing' ? [] : [{ name: 'transcribe_audio', input: { audioPath: selectedPath } }];
    let next: { name: string; input: unknown } | undefined = calls[results.length];
    if (scenario.startsWith('semantic')) {
      const item = results[0] === undefined ? undefined : (JSON.parse(results[0]!) as { items: { id: string; workingDirectory: string }[] }).items[0]!;
      const candidatePath = item === undefined ? '' : resolve(item.workingDirectory, 'candidate.mp4');
      const sequence: { name: string; input: unknown }[] = [{ name: 'declare_video_outputs', input: { items: [{ sourcePaths: [video], target: { kind: 'automatic' }, requirements: [{ kind: 'semantic', description: '对白中提到 camera' }] }] } },
        { name: 'trim_video', input: { inputPath: video, outputPath: candidatePath, start: 0, duration: 5.84 } },
        { name: 'decode_video', input: { inputPath: candidatePath } },
        { name: 'check_video_semantics', input: { outputItemId: item?.id, candidatePath } },
        { name: 'validate_video_candidate', input: { outputItemId: item?.id, candidatePath } }];
      if (scenario === 'semantic' && results.length >= 5) sequence.push({ name: 'publish_video_output', input: { validationId: (JSON.parse(results[4]!) as { validation: { id: string } }).validation.id } });
      next = sequence[results.length];
    }
    const delta = next === undefined ? { content: `完成 ${scenario}` } : { tool_calls: [{ index: 0, id: `call-${scenario}-${results.length}`, function: { name: next.name, arguments: JSON.stringify(next.input) } }] };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500); response.end(String(error));
    }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DESKTOP_RENDERER_URL', 'WHISPER_CLI_PATH', 'WHISPER_MODEL_PATH', 'FFMPEG_PATH', 'FFPROBE_PATH']) delete env[key];
  env.PATH = `${process.env.SystemRoot}/System32;${process.env.SystemRoot}`;
  const launch = async () => {
    const launched = await _electron.launch({ executablePath: executable ?? createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string,
      args: [...(executable ? [] : ['.']), `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
    await launched.evaluate(({ dialog }, evidence) => {
      dialog.showErrorBox = (title, message) => { require('node:fs').appendFileSync(require('node:path').join(evidence, 'native-errors.txt'), `${title}\n${message}\n`); };
    }, evidence);
    return launched;
  };
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof app>['firstWindow']>>;
  const connectApprovals = () => page.evaluate(() => {
    const state = window as unknown as { approvals: ApprovalRequest[]; rejectTools: boolean; activities: { id: string; toolName?: string }[] };
    state.approvals = []; state.activities = []; state.rejectTools = false;
    window.agentDesktop.onAgentEvent(event => {
      if (event.type === 'approval.requested') { state.approvals.push(event.request); void window.agentDesktop.decideApproval(event.request.requestId, !(state.rejectTools && event.request.kind === 'plugin-tool')); }
      if (event.type === 'activity' && event.item.toolName === 'transcribe_audio') {
        const index = state.activities.findIndex(item => item.id === event.item.id);
        if (index === -1) state.activities.push(event.item);
        else state.activities[index] = event.item;
      }
    });
  });
  const start = async (scenario: string, path = chinese) => {
    selectedPath = path;
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await page.getByRole('button', { name: '新会话', exact: true }).click();
    await app!.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, path);
    await page.getByRole('button', { name: '选择输入文件', exact: true }).click();
    const started = Date.now();
    await page.getByRole('textbox', { name: '剪辑需求' }).fill(`CASE:${scenario}`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    return async () => {
      await expect(page.locator('.agent-response').filter({ hasText: `完成 ${scenario}` })).toBeVisible({ timeout: 300_000 });
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
      const record = records.findLast(entry => entry.scenario === scenario)!;
      await writeFile(resolve(evidence, `${scenario}.json`), JSON.stringify({ ...record, elapsedMs: Date.now() - started }, null, 2));
      return record;
    };
  };
  const run = async (scenario: string, path = chinese) => (await start(scenario, path))();
  const measuredRun = async (scenario: string, path: string) => {
    const durationSeconds = Number(JSON.parse(execFileSync(resolve(ffmpeg, '../ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path], { encoding: 'utf8' })).format.duration);
    const finish = await start(scenario, path); const started = Date.now(); let pending = true;
    const samples: { cpuSeconds: number; workingSetBytes: number }[] = [];
    const running = finish().finally(() => { pending = false; });
    while (pending) {
      const sample = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter "Name='whisper-cli.exe'" | Where-Object { $_.CommandLine.Contains('${profile.replaceAll("'", "''")}') } | Select-Object -First 1; if ($p) { $cpu = [math]::Round([double]$p.KernelModeTime / 10000000 + [double]$p.UserModeTime / 10000000, 2); "$cpu,$($p.WorkingSetSize)" }`], { encoding: 'utf8', windowsHide: true }).trim();
      if (sample) { const [cpuSeconds, workingSetBytes] = sample.split(',').map(Number); samples.push({ cpuSeconds: cpuSeconds!, workingSetBytes: workingSetBytes! }); }
      if (pending) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const record = await running;
    expect(samples.length).toBeGreaterThan(0);
    await writeFile(resolve(evidence, `${scenario}-performance.json`), JSON.stringify({ durationSeconds, elapsedMs: Date.now() - started,
      samples, peakWorkingSetBytes: Math.max(...samples.map(sample => sample.workingSetBytes)), speechSource: 'Windows System.Speech Huihui/Zira synthetic reference' }, null, 2));
    return record;
  };
  try {
    app = await launch(); page = await app.firstWindow(); await page.waitForLoadState(); await connectApprovals();
    await page.screenshot({ path: resolve(evidence, 'initial.png') });
    await writeFile(resolve(evidence, 'initial.txt'), await page.locator('body').innerText());
    await page.evaluate(baseUrl => window.agentDesktop.saveRuntimeSettings({ memoryEnabled: false, modelProvider: { id: 'fixture', displayName: '模型夹具', apiKey: 'fixture-key', baseUrl, protocol: 'chat-completions', models: [{ id: 'fixture', displayName: 'fixture', images: true }] }, conversationModel: { providerId: 'fixture', modelId: 'fixture' }, visionModel: { providerId: 'fixture', modelId: 'fixture' } }), `http://127.0.0.1:${address.port}`);
    const existingWhisper = (await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(plugin => plugin.id === 'plugin:whisper');
    const existingFfmpeg = (await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(plugin => plugin.id === 'plugin:ffmpeg');
    const existingVision = (await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(plugin => plugin.id === 'plugin:vision');
    if (existingFfmpeg?.enabled === true) await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:ffmpeg', false));
    if (existingWhisper?.enabled === true) await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:whisper', false));
    if (existingVision?.enabled === true) await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:vision', false));
    expect((await run('ordinary')).tools).not.toContain('transcribe_audio');
    if (existingWhisper?.installed !== true) {
      await page.getByRole('button', { name: '插件和技能', exact: true }).click();
      await page.getByRole('button', { name: '安装 Whisper', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.extension-toast-installed, .extension-toast-error') !== null, undefined, { timeout: 300_000 });
      expect(await page.locator('.extension-toast').innerText()).not.toContain('失败');
      await expect(page.locator('.extension-toast')).toContainText('Whisper 插件已安装', { timeout: 300_000 });
    }
    expect((await run('missing')).tools).not.toContain('transcribe_audio');
    if (existingWhisper?.installed === true) await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:whisper', true));
    await page.getByRole('button', { name: '插件和技能', exact: true }).click();
    await page.getByRole('button', { name: '查看 Whisper', exact: true }).click();
    if ((await page.evaluate(() => window.agentDesktop.extensions.list())).whisperModel?.status !== 'ready') {
      await page.getByRole('button', { name: '安装模型', exact: true }).click();
      await expect(page.getByRole('progressbar', { name: 'Whisper 模型下载进度' })).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: resolve(evidence, 'model-download.png') });
      await expect(page.locator('.extension-toast')).toContainText('Whisper Small 模型已安装', { timeout: 1_500_000 });
    }
    expect((await page.evaluate(() => window.agentDesktop.extensions.list())).whisperModel?.diskBytes).toBe(487601967);
    await page.screenshot({ path: resolve(evidence, 'model-ready.png') });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(800, 600));
    await page.screenshot({ path: resolve(evidence, 'model-ready-narrow.png') });
    for (const [scenario, path, reference] of [['chinese', chinese, '公园'], ['english', english, 'camera'], ['mixed', mixed, 'English']] as const) {
      const record = await measuredRun(scenario, path);
      expect(record.invokedTools).toContain('transcribe_audio'); expect(record.invokedTools).not.toContain('extract_audio');
      const result = JSON.parse(record.results[0]!) as { text: string; segments: { start: number; end: number; text: string }[] };
      if (scenario === 'chinese') expect(result.text).toMatch(/公[园園]/);
      else expect(result.text.toLowerCase()).toContain(reference.toLowerCase());
      expect(result.segments.length).toBeGreaterThan(0);
      const duration = Number(JSON.parse(execFileSync(resolve(ffmpeg, '../ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', path], { encoding: 'utf8' })).format.duration);
      for (let index = 0; index < result.segments.length; index++) { const segment = result.segments[index]!; expect(segment.start).toBeGreaterThanOrEqual(index ? result.segments[index - 1]!.end : 0); expect(segment.end).toBeGreaterThanOrEqual(segment.start); }
      expect(result.segments.at(-1)!.end).toBeLessThanOrEqual(duration + 0.1);
    }
    for (const [scenario, path] of [['empty', empty], ['invalid', invalid]] as const) expect((await run(scenario, path)).results[0]).toMatch(/failed|ENOENT|empty transcript/);
    expect((await run('silent', silent)).results[0]).toContain('静音');
    const ffmpegInstalled = (await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.some(plugin => plugin.id === 'plugin:ffmpeg' && plugin.installed === true);
    if (!ffmpegInstalled) await page.evaluate(() => window.agentDesktop.extensions.install('plugin:ffmpeg'));
    else await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:ffmpeg', true));
    const extracted = resolve(evidence, 'derived.wav');
    // 授权目录只覆盖隔离验收素材；插件仍不能读取该目录以外的任意文件。
    const combined = await run('combined', video);
    expect(combined.results).toHaveLength(3); expect(JSON.parse(combined.results[2]!)).toMatchObject({ text: expect.stringMatching(/camera/i) });
    expect((await stat(extracted)).size).toBeGreaterThan(0);
    await page.evaluate(() => window.agentDesktop.extensions.install('plugin:video-editing'));
    const withSkills = await run('skills', english);
    expect(withSkills.tools.filter(name => name === 'transcribe_audio')).toHaveLength(1);
    expect(withSkills.tools.filter(name => name === 'extract_audio')).toHaveLength(1);
    expect(withSkills.invokedTools).toEqual(['load_skill', 'transcribe_audio']);
    expect(JSON.parse(withSkills.results[0]!).content).toContain('transcribe_audio');
    expect(JSON.parse(withSkills.results[1]!)).toMatchObject({ text: expect.stringMatching(/camera/i) });
    const longDirectory = resolve(evidence, ...Array.from({ length: 5 }, (_, index) => `中文 空格 ${index}-${'path'.repeat(7)}`));
    await mkdir(longDirectory, { recursive: true });
    const longPath = resolve(longDirectory, 'English speech.wav'); await copyFile(english, longPath);
    expect(longPath.length).toBeGreaterThan(260);
    expect(JSON.parse((await run('long-path', longPath)).results[0]!)).toMatchObject({ text: expect.stringMatching(/camera/i) });
    const modelFile = await open(resolve(profile, 'extensions/models/whisper/ggml-small.bin'), 'r+');
    const originalByte = Buffer.alloc(1); await modelFile.read(originalByte, 0, 1, 0);
    try {
      await modelFile.write(Buffer.from([originalByte[0]! ^ 255]), 0, 1, 0);
      const corrupted = await run('missing');
      expect(corrupted.tools).not.toContain('transcribe_audio');
      expect((await page.evaluate(() => window.agentDesktop.extensions.list())).whisperModel).toMatchObject({ status: 'error', message: expect.stringContaining('SHA-256') });
    } finally { await modelFile.write(originalByte, 0, 1, 0); await modelFile.close(); }
    expect(JSON.parse((await run('model-restored', english)).results[0]!)).toMatchObject({ text: expect.stringMatching(/camera/i) });
    // 语音独立验收完成后才启用视觉；语义验收显式拥有所需的独立插件。
    if (existingVision?.installed === true) await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:vision', true));
    else await page.evaluate(() => window.agentDesktop.extensions.install('plugin:vision'));
    const semantic = await run('semantic', video);
    expect(semantic.tools.filter(name => name === 'analyze_images')).toHaveLength(1);
    expect(JSON.parse(semantic.results[3]!)).toMatchObject({ coverage: 'all-frames-and-transcript', evidence: { transcript: { text: expect.stringMatching(/camera/i) } }, checks: [{ outcome: 'passed' }] });
    expect(JSON.parse(semantic.results[4]!)).toMatchObject({ validation: { checks: [{ outcome: 'passed' }, { outcome: 'passed' }] } });
    expect((await stat((JSON.parse(semantic.results[5]!) as { output: { path: string } }).output.path)).size).toBeGreaterThan(0);
    const semanticDirectory = (JSON.parse(semantic.results[0]!) as { items: { workingDirectory: string }[] }).items[0]!.workingDirectory;
    expect((await readdir(semanticDirectory)).some(name => name.startsWith('.semantic-'))).toBe(false);
    const duration = Number(JSON.parse(execFileSync(resolve(ffmpeg, '../ffprobe.exe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', longAudio], { encoding: 'utf8' })).format.duration);
    expect(duration).toBeGreaterThan(60);
    const longRecord = await measuredRun('long', longAudio); const longTranscript = JSON.parse(longRecord.results[0]!) as { text: string; segments: { end: number }[] };
    expect(longTranscript.text.toLowerCase()).toContain('camera'); expect(longTranscript.segments.at(-1)!.end).toBeLessThanOrEqual(duration + 0.1);
    await start('cancel', longAudio);
    const findProcess = () => Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process -Filter "Name='whisper-cli.exe'" | Where-Object { $_.CommandLine.Contains('${profile.replaceAll("'", "''")}') } | Select-Object -First 1 -ExpandProperty ProcessId; $p`], { encoding: 'utf8', windowsHide: true }).trim());
    let processId = 0;
    await expect.poll(() => { processId = findProcess(); return processId; }, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(processId).toBeGreaterThan(0);
    for (const action of ['delete-whisper-model', 'update'] as const) {
      expect(await page.evaluate(async action => {
        try { await window.agentDesktop.extensions.manage(action === 'update' ? { action, id: 'plugin:whisper' } : { action }); return 'unexpected success'; }
        catch (error) { return (error as Error).message; }
      }, action)).toContain('任务执行期间');
    }
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(() => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${processId}").ProcessId`], { encoding: 'utf8', windowsHide: true }).trim()).toBe('');
    await expect(page.locator('.agent-message').filter({ hasText: '已停止' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as unknown as { activities: { status: string }[] }).activities.at(-1)?.status)).toBe('cancelled');
    const cancellation = { activities: await page.evaluate(() => (window as unknown as { activities: { status: string }[] }).activities), processId };
    await writeFile(resolve(evidence, 'cancel.json'), JSON.stringify(cancellation, null, 2));
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:whisper', false));
    expect((await run('missing')).tools).not.toContain('transcribe_audio');
    const blocked = await run('semantic-missing', video);
    expect(JSON.parse(blocked.results[3]!)).toMatchObject({ coverage: 'incomplete', checks: [{ outcome: 'blocked', detail: expect.stringContaining('语音识别') }] });
    expect(JSON.parse(blocked.results[4]!)).toMatchObject({ validation: { checks: [{ outcome: 'passed' }, { outcome: 'blocked' }] } });
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:whisper', true));
    await page.evaluate(() => { (window as unknown as { rejectTools: boolean }).rejectTools = true; });
    expect((await run('denied', english)).results[0]).toContain('拒绝');
    await page.evaluate(() => { (window as unknown as { rejectTools: boolean }).rejectTools = false; });
    await page.evaluate(() => window.agentDesktop.extensions.uninstall('plugin:whisper'));
    expect((await page.evaluate(() => window.agentDesktop.extensions.list())).whisperModel?.status).toBe('ready');
    const without = await run('missing'); expect(without.tools).not.toContain('transcribe_audio'); expect(without.tools).toContain('extract_audio');
    await page.evaluate(() => window.agentDesktop.extensions.install('plugin:whisper'));
    if (executable !== undefined) {
      const appPath = await app.evaluate(({ app }) => app.getAppPath());
      const manifest = resolve(appPath, 'resources/plugins/whisper/.codex-plugin/plugin.json');
      const lockPath = resolve(appPath, 'resources/plugins/whisper/runtime.lock.json');
      const originalManifest = await readFile(manifest, 'utf8'); const originalLock = await readFile(lockPath, 'utf8');
      try {
        // 隔离安装构造元数据升级与损坏来源；实际程序/模型仍使用锁定官方版本。
        await writeFile(manifest, JSON.stringify({ ...JSON.parse(originalManifest), version: '1.0.1' }));
        await writeFile(lockPath, JSON.stringify({ ...JSON.parse(originalLock), url: 'https://unverified.test/whisper.zip' }));
        const failure = await page.evaluate(async () => {
          try { await window.agentDesktop.extensions.manage({ action: 'update', id: 'plugin:whisper' }); return 'unexpected success'; }
          catch (error) { return (error as Error).message; }
        });
        expect(failure).toContain('锁定');
        expect((await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(plugin => plugin.id === 'plugin:whisper')?.version).toBe('1.0.0');
        await writeFile(lockPath, originalLock);
        const updated = await page.evaluate(() => window.agentDesktop.extensions.manage({ action: 'update', id: 'plugin:whisper' }));
        const plugin = updated!.plugins.find(plugin => plugin.id === 'plugin:whisper')!;
        expect(plugin.version).toBe('1.0.1'); expect(updated!.whisperModel?.diskBytes).toBe(487601967);
        expect(JSON.parse((await run('updated', english)).results[0]!)).toMatchObject({ text: expect.stringMatching(/camera/i) });
        const versionId = plugin.versions!.find(version => version.version === '1.0.0')!.id;
        const restored = await page.evaluate(versionId => window.agentDesktop.extensions.manage({ action: 'rollback', id: 'plugin:whisper', versionId }), versionId);
        expect(restored!.plugins.find(plugin => plugin.id === 'plugin:whisper')?.version).toBe('1.0.0');
        expect(restored!.whisperModel?.diskBytes).toBe(487601967);
        expect(JSON.parse((await run('rolled-back', english)).results[0]!)).toMatchObject({ text: expect.stringMatching(/camera/i) });
        await writeFile(resolve(evidence, 'version-lifecycle.json'), JSON.stringify({ failedUpdate: failure, updated: plugin.version, restored: '1.0.0', modelBytes: restored!.whisperModel!.diskBytes }, null, 2));
      } finally { await writeFile(manifest, originalManifest); await writeFile(lockPath, originalLock); }
    }
    await app.close(); app = await launch(); page = await app.firstWindow(); await page.waitForLoadState(); await connectApprovals();
    expect(JSON.parse((await run('restart', english)).results[0]!)).toMatchObject({ text: expect.stringMatching(/camera/i) });
    await writeFile(resolve(evidence, 'summary.json'), JSON.stringify({ records, approvals: await page.evaluate(() => (window as unknown as { approvals: ApprovalRequest[] }).approvals), profile, installedExecutable: executable ?? null, speechSource: 'Windows System.Speech Huihui/Zira synthetic reference', modelBytes: 487601967 }, null, 2));
  } finally { await app?.close(); await new Promise<void>(done => server.close(() => done())); }
});
