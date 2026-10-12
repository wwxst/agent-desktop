import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron, expect, test } from '@playwright/test';
import type { PersistedDesktopState } from '../../../desktop/src/main/session-persistence.js';

interface ModelInput {
  readonly messages: readonly { readonly role: string; readonly content: string; readonly tool_call_id?: string }[];
  readonly tools: readonly { readonly function: { readonly name: string } }[];
}

// 从真实数据库读取宿主写入的原始文档，不用 Renderer 的内存状态代替落盘事实。
function readState(databasePath: string): PersistedDesktopState {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT value FROM desktop_documents WHERE name = ?').get('session-state');
    if (row === undefined) throw new Error('真实恢复验收缺少 session-state 记录。');
    return JSON.parse(row.value as string) as PersistedDesktopState;
  } finally { database.close(); }
}

test('keeps the first draft turn and its binding across a forced exit and two restarts without replaying tools', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop' || process.platform !== 'win32', '强杀连续恢复只在 Windows 真实 Electron 项目验证。');
  test.setTimeout(150_000);
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/general-agent-core-20261012', `electron-recovery-${Date.now()}`);
  const profile = resolve(evidence, 'profile');
  const workspace = resolve(evidence, 'workspace');
  const source = resolve(workspace, 'recovery.txt');
  const audio = resolve(workspace, 'input.wav');
  const prompt = '读取 recovery.txt，然后继续完成这个会在应用退出后恢复的任务';
  const sparePrompt = '另一条尚未提交的草稿';
  await mkdir(profile, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(source, '真实文件读取已经完成，恢复不得重放旧工具。\n');
  // 此附件只验证任务起点保存，不执行媒体处理。
  await writeFile(audio, 'attachment-persistence-fixture');

  const requests: ModelInput[] = [];
  const taskRequests: ModelInput[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as ModelInput;
    requests.push(input);
    if (input.tools.length > 0) taskRequests.push(input);
    // 首轮真实完成 read_file 后，第二次模型请求保持未完成，供进程强杀。
    if (input.tools.length > 0 && taskRequests.length === 2) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '未完成的流式文本不得写入磁盘' }, finish_reason: null }] })}\n\n`);
      return;
    }
    const firstTaskRequest = input.tools.length > 0 && taskRequests.length === 1;
    const delta = firstTaskRequest
      ? { tool_calls: [{ index: 0, id: 'read-before-exit', function: { name: 'read_file', arguments: JSON.stringify({ filePath: source }) } }] }
      : { content: input.tools.length === 0 ? '恢复验收任务' : '恢复后的任务已完成' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: firstTaskRequest ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('恢复验收模型服务未启动。');

  const executablePath = createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  env.DEEPSEEK_API_KEY = 'recovery-fixture-key';
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;
  const launch = () => _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  let databasePath = resolve(profile, 'agent-desktop.sqlite');
  let killedProcessId: number | undefined;
  let completed = false;
  const snapshots: { phase: string; file: string }[] = [];
  const saveSnapshot = async (phase: string) => {
    const state = readState(databasePath);
    const file = resolve(evidence, `${phase}.json`);
    await writeFile(file, JSON.stringify(state, null, 2));
    snapshots.push({ phase, file });
    return state;
  };
  try {
    app = await launch();
    let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    databasePath = await app.evaluate(({ app }) => `${app.getPath('userData')}/agent-desktop.sqlite`);
    expect(resolve(databasePath)).toBe(resolve(profile, 'agent-desktop.sqlite'));
    // 模型密钥沿用原恢复测试的进程配置，只验收会话恢复，不覆盖系统密钥存储。
    await page.evaluate(() => window.agentDesktop.saveRuntimeSettings({ memoryEnabled: false }));

    // 保留普通入口的未提交草稿；首次正式消息来自项目里的另一份输入草稿。
    await page.getByLabel('剪辑需求').fill(sparePrompt);
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, workspace);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: '在 workspace 中新建会话', exact: true }).click();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, audio);
    await page.getByRole('button', { name: '选择输入文件', exact: true }).click();
    await expect(page.getByLabel('音轨附件：input.wav', { exact: true })).toBeVisible();
    await page.getByLabel('剪辑需求').fill(prompt);
    const sessionId = await page.evaluate(() => window.agentDesktop.getActiveSessionId());
    // 初始草稿保存有防抖；数据库记录尚未创建时也等待真实写入完成。
    await expect(() => expect(readState(databasePath).clientState.drafts?.find(item => item.id === sessionId)?.prompt).toBe(prompt)).toPass({ timeout: 5_000 });
    const draft = await saveSnapshot('01-before-first-send');
    expect(draft.clientState.conversations).toEqual([]);
    expect(draft.clientState.drafts).toHaveLength(2);
    const submittedDraft = draft.clientState.drafts!.find(item => item.id === sessionId)!;
    const spareDraft = draft.clientState.drafts!.find(item => item.id !== sessionId)!;
    expect(submittedDraft.messages).toEqual([]);
    expect(submittedDraft.workingDirectory).toBe(workspace);
    expect(spareDraft.prompt).toBe(sparePrompt);

    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => taskRequests.length).toBe(2);
    await expect(page.getByText('未完成的流式文本不得写入磁盘', { exact: true })).toBeVisible();
    expect(taskRequests[0]!.tools.some(tool => tool.function.name === 'read_file')).toBe(true);
    expect(taskRequests[1]!.messages.find(message => message.role === 'tool')?.content).toContain('真实文件读取已经完成');
    const started = await saveSnapshot('02-started-before-kill');
    const session = started.sessions.find(item => item.id === sessionId)!;
    const binding = session.turnMessageBindings![0]!;
    const conversation = started.clientState.conversations.find(item => item.id === sessionId)!;
    expect(session.turnMessageBindings).toHaveLength(1);
    expect(binding.executionVersion).toBe(1);
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({ id: binding.userMessageId, role: 'user', text: prompt, attachments: ['input.wav'], attachmentRoles: ['audio'] });
    expect(conversation.messages[1]).toMatchObject({ id: binding.assistantMessageId, role: 'assistant', status: 'processing' });
    expect(conversation.messages[1]).toHaveProperty('streamedText', '');
    expect(conversation.attachments).toEqual(submittedDraft.attachments);
    expect(conversation.workingDirectory).toBe(workspace);
    expect(started.clientState.drafts).toEqual([spareDraft]);
    expect(started.clientState.sidebar).toEqual(draft.clientState.sidebar);
    expect(session.events.filter(event => event.type === 'tool.called')).toHaveLength(1);
    expect(session.events.find(event => event.type === 'tool.called')).toMatchObject({ name: 'read_file', boundary: 'read-only', toolCallId: 'read-before-exit' });
    expect(session.events.find(event => event.type === 'tool.result')).toMatchObject({ toolCallId: 'read-before-exit', result: { status: 'success' } });
    await page.screenshot({ path: resolve(evidence, '02-started-before-kill.png') });

    killedProcessId = app.process().pid;
    if (killedProcessId === undefined) throw new Error('无法取得 Electron 进程号。');
    execFileSync('taskkill.exe', ['/PID', String(killedProcessId), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await app.close().catch(() => undefined);
    app = undefined;
    const killed = await saveSnapshot('03-after-forced-exit');
    expect(killed.sessions.find(item => item.id === sessionId)!.events).toEqual(session.events);
    await copyFile(databasePath, resolve(evidence, '03-after-forced-exit.sqlite'));

    // 第一次启动写下 process-exit；第二次启动仍保留正式历史与同一绑定，不产生新中断或模型调用。
    for (const restart of [1, 2] as const) {
      app = await launch();
      page = await app.firstWindow();
      await expect(page.getByRole('button', { name: '继续未完成任务', exact: true })).toBeVisible();
      await expect(page.getByRole('article', { name: '你的任务', exact: true }).getByText(prompt, { exact: true })).toBeVisible();
      await expect(page.getByText('未完成的流式文本不得写入磁盘', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: '项目目录：workspace', exact: true })).toHaveAttribute('title', workspace);
      expect(taskRequests).toHaveLength(2);
      const restored = await saveSnapshot(`0${restart + 3}-restart-${restart}-before-continue`);
      const restoredSession = restored.sessions.find(item => item.id === sessionId)!;
      const restoredConversation = restored.clientState.conversations.find(item => item.id === sessionId)!;
      expect(restoredSession.turnMessageBindings).toEqual([binding]);
      expect(restoredSession.events.filter(event => event.type === 'turn.interrupted')).toEqual([{ type: 'turn.interrupted', turnId: binding.turnId, reason: 'process-exit' }]);
      expect(restoredSession.events.filter(event => event.type === 'turn.started')).toHaveLength(1);
      expect(restoredSession.events.filter(event => event.type === 'tool.called')).toHaveLength(1);
      expect(restoredConversation.messages.map(message => message.id)).toEqual([binding.userMessageId, binding.assistantMessageId]);
      expect(restoredConversation.messages[1]).toMatchObject({ role: 'assistant', status: 'failed', taskState: { status: 'interrupted', rootTurnId: binding.turnId, latestTurnId: binding.turnId } });
      expect(restoredConversation.attachments).toEqual(submittedDraft.attachments);
      expect(restored.clientState.drafts).toEqual([spareDraft]);
      expect(restored.clientState.sidebar).toEqual(draft.clientState.sidebar);
      await page.screenshot({ path: resolve(evidence, `0${restart + 3}-restart-${restart}-before-continue.png`) });
      if (restart === 1) { await app.close(); app = undefined; }
    }

    const beforeContinue = readState(databasePath).sessions.find(item => item.id === sessionId)!;
    await page.getByRole('button', { name: '继续未完成任务', exact: true }).click();
    await expect(page.getByText('恢复后的任务已完成', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '继续未完成任务', exact: true })).toHaveCount(0);
    await expect.poll(() => {
      const last = readState(databasePath).clientState.conversations.find(item => item.id === sessionId)?.messages.at(-1);
      return last?.role === 'assistant' ? last.status : undefined;
    }).toBe('completed');
    expect(taskRequests).toHaveLength(3);
    expect(taskRequests[2]!.messages.findLast(message => message.role === 'user')?.content).toContain('继续未完成任务');
    const continued = await saveSnapshot('06-after-user-continue');
    const continuedSession = continued.sessions.find(item => item.id === sessionId)!;
    const continuedConversation = continued.clientState.conversations.find(item => item.id === sessionId)!;
    expect(continuedSession.events.slice(0, beforeContinue.events.length)).toEqual(beforeContinue.events);
    expect(continuedSession.events.filter(event => event.type === 'tool.called')).toHaveLength(1);
    expect(continuedSession.events.filter(event => event.type === 'tool.result')).toHaveLength(1);
    expect(continuedSession.turnMessageBindings).toHaveLength(2);
    const continuedBinding = continuedSession.turnMessageBindings![1]!;
    expect(continuedBinding.executionVersion).toBe(1);
    expect(continuedBinding.turnId).not.toBe(binding.turnId);
    expect(continuedSession.events.find(event => event.type === 'turn.recovery.started')).toEqual({ type: 'turn.recovery.started', turnId: continuedBinding.turnId, sourceTurnId: binding.turnId, mode: 'continue' });
    expect(continuedConversation.messages.map(message => message.id)).toEqual([binding.userMessageId, binding.assistantMessageId, continuedBinding.userMessageId, continuedBinding.assistantMessageId]);
    expect(continuedConversation.messages[2]).toMatchObject({ role: 'user', text: '继续未完成任务', attachments: [] });
    expect(continuedConversation.messages[1]).toMatchObject({ id: binding.assistantMessageId, status: 'failed', errorMessage: '应用退出时任务被中断。',
      taskState: { rootTurnId: binding.turnId, latestTurnId: continuedBinding.turnId, status: 'completed' } });
    expect(continued.clientState.drafts).toEqual([spareDraft]);
    await page.screenshot({ path: resolve(evidence, '06-after-user-continue.png') });
    completed = true;
  } finally {
    if (app !== undefined) await app.close().catch(() => undefined);
    if (completed) await copyFile(databasePath, resolve(evidence, '06-after-user-continue.sqlite'));
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    // Profile 和原始 SQLite 留在 logs，失败现场也不会被清理掉。
    const manifest = resolve(evidence, 'evidence.json');
    await writeFile(manifest, JSON.stringify({ completed, profile, databasePath, killedProcessId, snapshots, taskRequestCount: taskRequests.length, requests }, null, 2));
    await info.attach('真实 Electron 强杀连续恢复证据', { path: manifest, contentType: 'application/json' });
  }
});
