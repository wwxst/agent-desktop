import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { _electron, expect, test } from '@playwright/test';
import type { ApprovalRequest } from '@agent-desktop/client';
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
  const packagedExecutable = process.env.DESKTOP_ACCEPTANCE_EXECUTABLE;
  const evidence = resolve(root, 'logs/general-agent-core-20261012', `${packagedExecutable === undefined ? 'electron' : 'installed'}-recovery-${Date.now()}`);
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

  const executablePath = packagedExecutable ?? createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  env.DEEPSEEK_API_KEY = 'recovery-fixture-key';
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;
  // 安装版使用自身应用入口；开发版才传入当前目录，双方都使用本次独立配置。
  const launch = () => _electron.launch({ executablePath, args: [...(packagedExecutable === undefined ? ['.'] : []), `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
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
    await writeFile(manifest, JSON.stringify({ completed, installedExecutable: packagedExecutable ?? null, profile, databasePath, killedProcessId, snapshots, taskRequestCount: taskRequests.length, requests }, null, 2));
    await info.attach('真实 Electron 强杀连续恢复证据', { path: manifest, contentType: 'application/json' });
  }
});

test('runs real file approvals, plans and command outcome verification before releasing a blocked writer', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop' || process.platform !== 'win32', '普通工具链只在 Windows 真实 Electron 项目验证。');
  test.setTimeout(150_000);
  const root = resolve('../..');
  const packagedExecutable = process.env.DESKTOP_ACCEPTANCE_EXECUTABLE;
  const evidence = resolve(root, 'logs/general-agent-core-20261012', `${packagedExecutable === undefined ? 'electron' : 'installed'}-tools-${Date.now()}`);
  const profile = resolve(evidence, 'profile');
  const workspace = resolve(evidence, 'workspace');
  const databasePath = resolve(profile, 'agent-desktop.sqlite');
  const textPath = resolve(workspace, '普通 文件.txt');
  const deniedPath = resolve(workspace, 'denied.txt');
  const markerPath = resolve(workspace, 'command-marker.txt');
  const blockedPath = resolve(workspace, 'after-verification.txt');
  const command = "[System.IO.File]::WriteAllText('command-marker.txt', 'actual-command-effect'); exit 7";
  await mkdir(profile, { recursive: true }); await mkdir(workspace, { recursive: true });
  let sessionId: string;
  const requests: ModelInput[] = [];
  const session = () => readState(databasePath).sessions.find(item => item.id === sessionId)!;
  const savedTaskStatus = () => {
    const last = readState(databasePath).clientState.conversations.find(item => item.id === sessionId)?.messages.at(-1);
    return last?.role === 'assistant' ? last.taskState?.status : undefined;
  };
  const resultIndex = (callId: string) => {
    const index = session().events.findIndex(event => event.type === 'tool.result' && event.toolCallId === callId);
    if (index < 0) throw new Error(`普通工具验收缺少真实结果：${callId}`);
    return index;
  };
  const fileSteps = (completed: boolean) => [
    { id: 'create', description: '创建普通文本', requestedStatus: completed ? 'completed' : 'pending', completionKind: 'tool', evidenceEventIndexes: completed ? [resultIndex('core-create')] : [] },
    { id: 'edit', description: '按真实摘要修改文本', requestedStatus: completed ? 'completed' : 'pending', completionKind: 'tool', evidenceEventIndexes: completed ? [resultIndex('core-edit')] : [] },
  ];
  // 模型只声明步骤；完成引用直接取宿主已经保存的事实，不注入事件或伪造工具成功。
  const plan = (phase: 'initial' | 'files' | 'unknown' | 'verified' | 'released') => {
    const verifiedIndex = phase === 'verified' || phase === 'released'
      ? session().events.findIndex(event => event.type === 'effect.outcome.verified' && event.evidence.source === 'user') : undefined;
    return { explanation: '以实际文件、命令和人工核验事实推进', steps: [
      ...fileSteps(phase !== 'initial'),
      { id: 'command', description: '确认非零命令的实际写入', requestedStatus: phase === 'initial' || phase === 'files' ? 'pending' : phase === 'unknown' ? 'blocked' : 'completed', completionKind: 'tool',
        evidenceEventIndexes: phase === 'unknown' ? [resultIndex('core-command')] : verifiedIndex === undefined ? [] : [verifiedIndex] },
      ...(phase === 'verified' || phase === 'released' ? [{ id: 'released', description: '核验后完成剩余写入', requestedStatus: phase === 'released' ? 'completed' : 'pending',
        completionKind: 'tool', evidenceEventIndexes: phase === 'released' ? [resultIndex('core-released')] : [] }] : []),
    ] };
  };
  const server = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body) as ModelInput; requests.push(input);
      const userIndex = input.messages.findLastIndex(message => message.role === 'user');
      const results = input.messages.slice(userIndex + 1).filter(message => message.role === 'tool');
      const recovery = input.messages[userIndex]?.content.startsWith('继续未完成任务\n') === true;
      let action: { name: string; input: object; id: string } | undefined;
      if (input.tools.length > 0) {
        const step = results.length;
        if (recovery) {
          action = step === 0 ? { name: 'update_plan', input: plan('verified'), id: 'core-plan-verified' }
            : step === 1 ? { name: 'write_text_file', input: { filePath: blockedPath, content: 'written-after-manual-verification' }, id: 'core-released' }
              : step === 2 ? { name: 'update_plan', input: plan('released'), id: 'core-plan-released' } : undefined;
        } else {
          const denied = { filePath: deniedPath, content: 'must-not-exist' };
          if (step === 0) action = { name: 'update_plan', input: plan('initial'), id: 'core-plan-initial' };
          else if (step === 1 || step === 2) action = { name: 'write_text_file', input: denied, id: `core-denied-${step}` };
          else if (step === 3) action = { name: 'write_text_file', input: { filePath: textPath, content: 'before-edit\n' }, id: 'core-create' };
          else if (step === 4) action = { name: 'read_file', input: { filePath: textPath }, id: 'core-read' };
          else if (step === 5) action = { name: 'edit_text_file', input: { filePath: textPath,
            expectedSha256: (JSON.parse(results[4]!.content) as { sha256: string }).sha256, oldText: 'before-edit', newText: 'after-edit' }, id: 'core-edit' };
          else if (step === 6) action = { name: 'update_plan', input: plan('files'), id: 'core-plan-files' };
          else if (step === 7) action = { name: 'run_command', input: { command, timeoutMs: 10_000 }, id: 'core-command' };
          else if (step === 8) action = { name: 'write_text_file', input: { filePath: blockedPath, content: 'written-after-manual-verification' }, id: 'core-blocked' };
          else if (step === 9) action = { name: 'update_plan', input: plan('unknown'), id: 'core-plan-unknown' };
        }
      }
      const delta = action === undefined ? { content: input.tools.length === 0 ? '普通工具验收' : recovery ? '人工核验后的剩余任务完成' : '普通工具链完成，命令实际效果待人工核验' }
        : { tool_calls: [{ index: 0, id: action.id, function: { name: action.name, arguments: JSON.stringify(action.input) } }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: action === undefined ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('普通工具模型夹具未启动。');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE;
  env.DEEPSEEK_API_KEY = 'ordinary-tools-fixture-key'; env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;
  const executablePath = packagedExecutable ?? createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const launch = () => _electron.launch({ executablePath, args: [...(packagedExecutable === undefined ? ['.'] : []), `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  let approvals: ApprovalRequest[] = [];
  let completed = false;
  try {
    app = await launch(); let page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    expect(resolve(await app.evaluate(({ app }) => app.getPath('userData')))).toBe(profile);
    await page.evaluate(() => {
      (window as unknown as { coreApprovals: ApprovalRequest[] }).coreApprovals = [];
      window.agentDesktop.onAgentEvent(event => { if (event.type === 'approval.requested') (window as unknown as { coreApprovals: ApprovalRequest[] }).coreApprovals.push(event.request); });
      return window.agentDesktop.saveRuntimeSettings({ memoryEnabled: false });
    });
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, workspace);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: '在 workspace 中新建会话', exact: true }).click();
    sessionId = await page.evaluate(() => window.agentDesktop.getActiveSessionId());
    await page.getByLabel('剪辑需求').fill('真实创建和读取普通文本、精确修改、更新计划并核验命令副作用');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const approval = page.getByRole('region', { name: '操作审批' });
    await expect(approval).toContainText(deniedPath);
    await approval.getByRole('button', { name: '拒绝', exact: true }).click();
    // 重复拒绝应直接返回门禁结果，下一个真正的审批已经是新的创建目标。
    await expect(approval).toContainText(textPath);
    await expect(approval).toContainText('允许 Agent 创建这个文件吗？');
    await approval.getByRole('button', { name: '允许', exact: true }).click();
    await expect(approval).toContainText('原内容'); await expect(approval).toContainText('before-edit');
    await expect(approval).toContainText('新内容'); await expect(approval).toContainText('after-edit');
    await approval.getByRole('button', { name: '允许', exact: true }).click();
    await expect(approval).toContainText(command); await expect(approval).toContainText(workspace);
    await approval.getByRole('button', { name: '允许', exact: true }).click();
    await expect(page.getByText('普通工具链完成，命令实际效果待人工核验', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    await page.screenshot({ path: resolve(evidence, '00-final-text-before-snapshot.png') });
    await writeFile(resolve(evidence, '00-final-text-before-snapshot.json'), JSON.stringify(readState(databasePath), null, 2));
    // 页面终态先可见；完整展示快照仍要等待现有异步保存完成再读取数据库。
    await expect.poll(savedTaskStatus).toBe('blocked');
    expect(await readFile(textPath, 'utf8')).toBe('after-edit\n');
    expect(await readFile(markerPath, 'utf8')).toBe('actual-command-effect');
    await expect(stat(deniedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(blockedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const beforeVerification = readState(databasePath); await writeFile(resolve(evidence, '01-before-manual-verification.json'), JSON.stringify(beforeVerification, null, 2));
    const events = session().events;
    expect(events.find(event => event.type === 'tool.result' && event.toolCallId === 'core-denied-1')).toMatchObject({ result: { status: 'error', failureKind: 'denied' } });
    expect(events.find(event => event.type === 'tool.called' && event.toolCallId === 'core-denied-2')).toMatchObject({ boundary: 'not-executed' });
    expect(events.find(event => event.type === 'tool.result' && event.toolCallId === 'core-denied-2')).toMatchObject({ result: { failureKind: 'permanent', message: '用户已拒绝本轮相同调用，不重复请求审批。' } });
    const commandIndex = events.findIndex(event => event.type === 'tool.called' && event.toolCallId === 'core-command');
    expect(events.find(event => event.type === 'tool.effect.prepared' && event.sourceEventIndex === commandIndex)).toMatchObject({ data: { kind: 'command', command, workingDirectory: workspace } });
    expect(events.find(event => event.type === 'tool.result' && event.toolCallId === 'core-command')).toMatchObject({ result: { status: 'error', failureKind: 'unknown-outcome', output: { exitCode: 7, termination: 'exited' } } });
    expect(events.find(event => event.type === 'tool.called' && event.toolCallId === 'core-blocked')).toMatchObject({ boundary: 'not-executed' });
    expect(events.find(event => event.type === 'tool.result' && event.toolCallId === 'core-blocked')).toMatchObject({ result: { output: { sourceEventIndexes: [commandIndex] } } });
    const conversation = beforeVerification.clientState.conversations.find(item => item.id === sessionId)!;
    expect(conversation.messages.at(-1)).toMatchObject({ taskState: { status: 'blocked', unknownEffects: [{ sourceEventIndex: commandIndex, label: 'run_command' }],
      plan: { revision: 3, steps: [{ status: 'completed' }, { status: 'completed' }, { status: 'blocked' }] } } });
    approvals = await page.evaluate(() => (window as unknown as { coreApprovals: ApprovalRequest[] }).coreApprovals);
    expect(approvals.map(request => request.kind)).toEqual(['create-file', 'create-file', 'edit-file', 'command']);
    await expect(page.getByRole('button', { name: '确认已完成', exact: true })).toBeDisabled();
    await page.screenshot({ path: resolve(evidence, '01-before-manual-verification.png') });
    const description = '已读取 command-marker.txt，字节为 actual-command-effect；进程退出码为 7，确认该命令实际写入已完成。';
    await page.getByLabel('run_command核验说明', { exact: true }).fill(description);
    await page.getByRole('button', { name: '确认已完成', exact: true }).click();
    await expect(page.getByLabel('run_command核验说明', { exact: true })).toHaveCount(0);
    const verification = session().events.find(event => event.type === 'effect.outcome.verified' && event.sourceEventIndex === commandIndex);
    expect(verification).toMatchObject({ scope: 'entire-call', outcome: 'completed', evidence: { source: 'user', description } });
    await page.getByRole('button', { name: '继续未完成任务', exact: true }).click();
    await expect(approval).toContainText(blockedPath);
    await approval.getByRole('button', { name: '允许', exact: true }).click();
    await expect(page.getByText('人工核验后的剩余任务完成', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    await expect.poll(savedTaskStatus).toBe('completed');
    expect(await readFile(blockedPath, 'utf8')).toBe('written-after-manual-verification');
    expect(session().events.filter(event => event.type === 'tool.called' && event.name === 'run_command')).toHaveLength(1);
    const finished = readState(databasePath); await writeFile(resolve(evidence, '02-after-manual-continue.json'), JSON.stringify(finished, null, 2));
    expect(finished.clientState.conversations.find(item => item.id === sessionId)!.messages.at(-1)).toMatchObject({ taskState: { status: 'completed', plan: { revision: 5,
      steps: [{ status: 'completed' }, { status: 'completed' }, { status: 'completed' }, { status: 'completed' }] } } });
    await page.screenshot({ path: resolve(evidence, '02-after-manual-continue.png') });
    approvals = await page.evaluate(() => (window as unknown as { coreApprovals: ApprovalRequest[] }).coreApprovals);
    expect(approvals.map(request => request.kind)).toEqual(['create-file', 'create-file', 'edit-file', 'command', 'create-file']);
    await app.close(); app = undefined;
    const requestCount = requests.length;
    app = await launch(); page = await app.firstWindow();
    await expect(page.getByText('人工核验后的剩余任务完成', { exact: true })).toBeVisible();
    expect(session().events).toEqual(finished.sessions.find(item => item.id === sessionId)!.events);
    expect(requests).toHaveLength(requestCount);
    await expect(page.getByLabel('run_command核验说明', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: resolve(evidence, '03-restart-with-plan.png') });
    completed = true;
  } finally {
    const manifest = resolve(evidence, 'evidence.json');
    await writeFile(manifest, JSON.stringify({ completed, installedExecutable: packagedExecutable ?? null, profile, workspace, databasePath, command, approvals, requests }, null, 2));
    await info.attach('真实普通文件、计划与人工核验证据', { path: manifest, contentType: 'application/json' });
    if (app !== undefined) await app.close().catch(() => undefined);
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    if (completed) await copyFile(databasePath, resolve(evidence, '03-restart.sqlite'));
  }
});
