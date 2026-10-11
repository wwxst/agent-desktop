import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';

test('persists real Desktop extension installation and enabled state across restart', async ({}, testInfo) => {
  // 真实 Electron 往返包含插件安装、重启、文件通知和本地 MCP 进程，默认 30 秒不足以覆盖这条链路。
  test.setTimeout(120_000);
  test.skip(testInfo.project.name !== 'chromium-desktop', '一次真实桌面往返即可，响应式另由共享客户端检查。');
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/plugin-row-menu-20261004');
  const profile = resolve(evidence, `electron-profile-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const executablePath = createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const modelRequests: Array<{ messages: { role: string; content: string }[]; tools: { function: { name: string } }[] }> = [];
  // 用本地确定性 SSE 响应选择工具；Desktop、Provider、Loop、SDK 和 IPC 保持真实实现。
  const modelServer = createServer(async (request, response) => {
    request.setEncoding('utf8');
    let body = '';
    for await (const chunk of request) body += chunk;
    const input = JSON.parse(body) as (typeof modelRequests)[number];
    modelRequests.push(input);
    const count = input.messages.filter(message => message.role === 'tool').length;
    const naming = input.tools.length === 0;
    const delta = naming ? { content: '检查本地文件与插件' } : count === 0 ? { tool_calls: [{ index: 0, id: 'skill-load', function: { name: 'load_skill', arguments: '{"id":"skill:local-file-review"}' } }] }
      : count === 1 ? { tool_calls: [{ index: 0, id: 'plugin-echo', function: { name: 'p_fixture_local_echo', arguments: '{"text":"extension-e2e"}' } }] }
      : { content: '技能和插件实际调用完成' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: !naming && count < 2 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  if (address === null || typeof address === 'string') throw new Error('模型夹具服务未启动。');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('保留的草稿');
    await page.getByRole('button', { name: '插件和技能', exact: true }).click();
    await expect(page.getByRole('tab', { name: '公开', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: '安装 语义视频剪辑' })).toBeVisible();
    const initial = await page.evaluate(() => window.agentDesktop.extensions.list());
    expect(initial.plugins.map(item => item.id)).toEqual(['plugin:video-editing', 'plugin:ffmpeg']);
    expect(initial.marketplaces).toEqual([]);
    await page.screenshot({ path: resolve(evidence, 'desktop-default-plugins.png') });
    await page.getByRole('button', { name: '安装 语义视频剪辑' }).click();
    await expect(page.getByRole('button', { name: '语义视频剪辑操作', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: '个人', exact: true }).click();
    await expect(page.getByRole('main', { name: '插件管理' }).getByRole('button', { name: '查看 语义视频剪辑' })).toHaveCount(0);
    await page.getByRole('tab', { name: '公开', exact: true }).click();
    await page.getByRole('button', { name: '语义视频剪辑操作', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: '立即试用' })).toBeEnabled();
    await page.screenshot({ path: resolve(evidence, 'desktop-plugin-row-menu.png') });
    await page.getByRole('menuitem', { name: '管理', exact: true }).click();
    await expect(page.getByRole('switch', { name: '启用 语义视频剪辑' })).toBeChecked();
    const detail = page.getByRole('region', { name: '语义视频剪辑详情', exact: true });
    await expect(detail.getByRole('region', { name: '信息' })).toContainText('Agent Desktop');
    await expect(detail.getByRole('region', { name: '建议指令' })).toContainText('$short-drama-editing');
    await expect(detail).not.toContainText('事件钩子');
    await page.screenshot({ path: resolve(evidence, 'desktop-plugin-detail-top.png') });
    await detail.getByRole('button', { name: '插件操作' }).click();
    await page.screenshot({ path: resolve(evidence, 'desktop-plugin-detail-menu.png') });
    await detail.getByRole('menuitem', { name: '卸载' }).click();
    await expect(detail.getByRole('button', { name: '确认卸载' })).toBeVisible();
    await detail.getByRole('button', { name: '取消', exact: true }).click();
    await detail.getByRole('region', { name: '信息' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(evidence, 'desktop-plugin-detail-info.png') });
    const pluginSkills = page.getByRole('region', { name: '附带技能' });
    await expect(pluginSkills.getByRole('button', { name: '查看 short-drama-editing' })).toBeVisible();
    await page.screenshot({ path: resolve(evidence, 'desktop-plugin-skills.png') });
    await pluginSkills.getByRole('button', { name: '查看 short-drama-editing' }).click();
    const skillDialog = page.getByRole('dialog', { name: '短剧剪辑技能详情' });
    await expect(skillDialog.getByLabel('技能正文')).toContainText('开场钩子');
    await expect(skillDialog.getByLabel('技能正文')).not.toContainText('name: short-drama-editing');
    await page.screenshot({ path: resolve(evidence, 'desktop-skill-dialog.png') });
    // 只替换系统文件操作和剪贴板出口，身份解析、正文读取和主进程通信保持真实。
    await app.evaluate(({ clipboard, shell }) => {
      const probe = globalThis as typeof globalThis & { skillFileActions: { action: string; value: string }[] };
      probe.skillFileActions = [];
      clipboard.writeText = async text => { probe.skillFileActions.push({ action: 'copy', value: text }); };
      shell.openPath = async path => { probe.skillFileActions.push({ action: 'open', value: path }); return ''; };
      shell.showItemInFolder = path => { probe.skillFileActions.push({ action: 'reveal', value: path }); };
    });
    await skillDialog.getByRole('button', { name: '技能操作' }).click();
    await page.screenshot({ path: resolve(evidence, 'desktop-skill-menu.png') });
    await skillDialog.getByRole('menuitem', { name: '复制 Markdown' }).click();
    await expect(skillDialog.getByRole('status')).toHaveText('已复制 Markdown');
    for (const label of ['打开', '在文件资源管理器中显示']) {
      await skillDialog.getByRole('button', { name: '技能操作' }).click();
      await skillDialog.getByRole('menuitem', { name: label, exact: true }).click();
      await expect(skillDialog.getByRole('button', { name: '技能操作' })).toBeEnabled();
    }
    const actions = await app.evaluate(() => (globalThis as typeof globalThis & { skillFileActions: { action: string; value: string }[] }).skillFileActions);
    expect(actions.map(action => action.action)).toEqual(['copy', 'open', 'reveal']);
    const rawSkill = await page.evaluate(() => window.agentDesktop.extensions.readSkill('plugin:video-editing/short-drama-editing'));
    expect(actions[0]?.value).toBe(rawSkill);
    expect(actions[1]?.value).toContain('short-drama-editing');
    expect(actions[1]?.value).toMatch(/SKILL\.md$/);
    expect(actions[2]?.value).toBe(actions[1]?.value);
    await expect(page.evaluate(() => window.agentDesktop.extensions.manage({ action: 'reveal-skill', id: 'D:/private/SKILL.md' }))).rejects.toThrow('找不到技能');
    await app.evaluate(({ shell }) => { shell.openPath = async () => '没有关联编辑器'; });
    await skillDialog.getByRole('button', { name: '技能操作' }).click();
    await skillDialog.getByRole('menuitem', { name: '打开', exact: true }).click();
    await expect(skillDialog.getByRole('alert')).toHaveText('没有关联编辑器');
    await skillDialog.getByRole('switch', { name: '启用 short-drama-editing' }).click();
    await expect(skillDialog.getByRole('switch', { name: '启用 short-drama-editing' })).not.toBeChecked();
    await expect(skillDialog.getByRole('button', { name: '使用' })).toBeDisabled();
    await skillDialog.getByRole('switch', { name: '启用 short-drama-editing' }).click();
    await expect(skillDialog.getByRole('switch', { name: '启用 short-drama-editing' })).toBeChecked();
    await expect(skillDialog.getByRole('button', { name: '使用' })).toBeEnabled();
    await skillDialog.getByRole('button', { name: '使用' }).click();
    await expect(page.getByRole('textbox', { name: '剪辑需求' })).toHaveValue('$short-drama-editing\n保留的草稿');
    expect(modelRequests).toHaveLength(0);
    await page.getByRole('button', { name: '插件和技能', exact: true }).click();
    await page.getByRole('button', { name: '技能', exact: true }).click();
    await expect(page.getByRole('switch', { name: '启用 semantic-editing' })).toBeChecked();
    await page.getByRole('button', { name: '安装 local-file-review' }).click();
    await page.getByRole('switch', { name: '启用 local-file-review' }).click();
    await expect(page.getByRole('switch', { name: '启用 local-file-review' })).not.toBeChecked();
    await page.screenshot({ path: resolve(evidence, 'desktop-skills.png') });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole('button', { name: '插件和技能', exact: true }).click();
    await page.getByRole('tab', { name: '公开', exact: true }).click();
    await expect(page.getByRole('button', { name: '语义视频剪辑操作', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(evidence, 'desktop-plugins.png') });
    await page.getByRole('button', { name: '技能', exact: true }).click();
    await expect(page.getByRole('switch', { name: '启用 local-file-review' })).not.toBeChecked();
    const metadata = await page.evaluate(() => window.agentDesktop.extensions.listSkills(true));
    expect(metadata.some(item => item.name === 'short-drama-editing')).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain('delegate_tasks');
    const instructions = await page.evaluate(() => window.agentDesktop.extensions.readSkill('skill:local-file-review'));
    expect(instructions).toContain('delegate_tasks');
    // 从独立宿主操作触发失效通知，页面没有依赖按钮返回值更新状态。
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('skill:local-file-review', true));
    await expect(page.getByRole('switch', { name: '启用 local-file-review' })).toBeChecked();
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('skill:local-file-review', false));
    await expect(page.getByRole('switch', { name: '启用 local-file-review' })).not.toBeChecked();
    await page.getByRole('button', { name: '刷新技能' }).click();
    await expect(page.getByRole('button', { name: '刷新技能' })).toBeEnabled();
    await expect(page.getByRole('switch', { name: '启用 local-file-review' })).not.toBeChecked();
    const skillPath = metadata.find(item => item.id === 'skill:local-file-review')!.path!;
    const originalSkill = await readFile(skillPath, 'utf8');
    // 单独观测真实 IPC 通知，避免先前仍在完成的 list 调用顺带读到新文件造成假通过。
    await page.evaluate(() => {
      const probe = window as unknown as Window & { skillFileChangeCount: number; stopSkillFileProbe: () => void };
      probe.skillFileChangeCount = 0;
      probe.stopSkillFileProbe = window.agentDesktop.extensions.onChanged(() => { probe.skillFileChangeCount += 1; });
    });
    await writeFile(skillPath, originalSkill.replace(/^description:.*$/m, 'description: 文件外部修改验收'));
    await expect.poll(() => page.evaluate(() => (window as unknown as Window & { skillFileChangeCount: number }).skillFileChangeCount)).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: '查看 local-file-review' })).toContainText('文件外部修改验收');
    await page.evaluate(() => (window as unknown as Window & { stopSkillFileProbe: () => void }).stopSkillFileProbe());

    const source = resolve(profile, 'test-plugin-source');
    await mkdir(resolve(source, '.codex-plugin'), { recursive: true });
    await writeFile(resolve(source, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'fixture', description: '本地 MCP 验收工具' }));
    await writeFile(resolve(source, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node', args: ['${PLUGIN_ROOT}/server.mjs', '${PLUGIN_ROOT}/waiting'] } } }));
    const esbuild = createRequire(resolve(root, 'apps/desktop/package.json'))('esbuild') as {
      build(options: { entryPoints: string[]; outfile: string; bundle: boolean; platform: string; format: string }): Promise<unknown>;
    };
    await esbuild.build({ entryPoints: [resolve(root, 'apps/desktop/tests/fixtures/extension-server.mjs')], outfile: resolve(source, 'server.mjs'), bundle: true, platform: 'node', format: 'esm' });
    // 只替换原生目录选择返回值，复制、解析、数据库及审批仍经过生产宿主。
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, source);
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await page.getByRole('button', { name: '添加插件' }).click();
    await page.getByRole('menuitem', { name: '从本地文件夹添加' }).click();
    await page.getByRole('tab', { name: '个人', exact: true }).click();
    await page.getByRole('button', { name: 'fixture操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '管理', exact: true }).click();
    await expect(page.getByRole('switch', { name: '启用 fixture' })).toBeChecked();
    await page.getByRole('button', { name: '技能', exact: true }).click();
    await page.getByRole('switch', { name: '启用 local-file-review' }).click();
    await expect(page.getByRole('switch', { name: '启用 local-file-review' })).toBeChecked();
    await page.evaluate(baseUrl => window.agentDesktop.saveRuntimeSettings({ modelProvider: { id: 'deepseek', displayName: 'DeepSeek', apiKey: 'test-fixture-key', baseUrl, protocol: 'chat-completions', models: [{ id: 'deepseek-v4-pro', displayName: 'DeepSeek', images: false }] } }), `http://127.0.0.1:${address.port}`);
    // 本用例只验收 fixture 服务；Probe 的启动、调用和语义交付由真实媒体用例覆盖。
    await page.evaluate(() => window.agentDesktop.extensions.setEnabled('plugin:video-editing', false));
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('$local-file-review 检查项目，调用插件 echo 返回 extension-e2e');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('允许启动这个插件服务吗？')).toBeVisible();
    await page.getByRole('button', { name: '允许', exact: true }).click();
    await expect(page.getByText('允许插件执行这个工具调用吗？')).toBeVisible();
    await page.screenshot({ path: resolve(evidence, 'desktop-plugin-approval.png') });
    await page.getByRole('button', { name: '允许', exact: true }).click();
    await expect(page.getByText('技能和插件实际调用完成', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    expect(modelRequests).toHaveLength(4);
    expect(modelRequests[3]?.tools).toEqual([]);
    await expect(page.locator('section[aria-label="最近"]').getByRole('button', { name: '检查本地文件与插件', exact: true })).toBeVisible();
    expect(modelRequests[0]?.tools.some(tool => tool.function.name === 'p_fixture_local_echo')).toBe(true);
    expect(modelRequests[1]?.messages.some(message => message.role === 'tool' && message.content.includes('delegate_tasks'))).toBe(true);
    const resultMessage = modelRequests[2]!.messages.filter(message => message.role === 'tool')[1]!;
    expect(resultMessage.content).toContain('extension-e2e');
    const result = JSON.parse(resultMessage.content) as { content: { text: string }[] };
    const pid = JSON.parse(result.content[0]!.text).pid as number;
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    await page.screenshot({ path: resolve(evidence, 'desktop-extension-result.png') });
  } finally {
    try { await app?.close(); }
    finally { await new Promise<void>((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve())); }
  }
});
