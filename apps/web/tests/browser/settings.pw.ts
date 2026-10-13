import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';

test('automatically saves full-page settings with themes and extension navigation', async ({ page }, info) => {
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '剪辑需求' });
  await input.fill('设置页面往返草稿');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '常规', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '工作区导航' })).toHaveCount(0);
  await page.getByRole('button', { name: '模型与执行', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0);
  await page.getByRole('region', { name: 'DeepSeek供应商' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('模型 1 ID', { exact: true }).fill('保存的模型');
    await page.getByLabel('模型 1 参数').click();
    await page.getByLabel('模型 1 文本输入').selectOption('supported');
    await page.getByLabel('模型 1 文本输出').selectOption('supported');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.model-provider-editor')).toHaveCount(0);
  await page.getByRole('button', { name: '本地工具', exact: true }).click();
  await expect(page.getByLabel('模型文件路径', { exact: true })).toBeHidden();
  await page.getByText('高级路径设置', { exact: true }).click();
  await page.getByLabel('模型文件路径', { exact: true }).fill('D:/models/draft.bin');
  await page.getByRole('button', { name: '模型与执行', exact: true }).click();
  await page.getByRole('region', { name: 'DeepSeek供应商' }).getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('模型 1 ID', { exact: true })).toHaveValue('保存的模型');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '深色', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('settings-dark.png') });
  await page.getByRole('button', { name: '关闭设置' }).click();
  await expect(input).toHaveValue('设置页面往返草稿');
  await page.screenshot({ path: info.outputPath('conversation-dark.png') });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  for (const [width, height] of [[1280, 720], [800, 600], [400, 500]]) {
    await page.setViewportSize({ width: width!, height: height! });
    for (const name of ['常规', '模型与执行', '本地工具', '插件与技能', '外观']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(page.getByRole('heading', { name: name === '模型与执行' ? '模型' : name === '插件与技能' ? '插件' : name, exact: true })).toBeVisible();
      expect(await page.locator('.settings-page').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await page.getByRole('button', { name: '关闭设置' }).click({ trial: true });
      await page.screenshot({ path: info.outputPath(`${name}-${width}.png`) });
    }
  }
  // 系统模式必须跟随实际媒体查询，而不是仅更换按钮选中状态。
  await page.getByRole('button', { name: '跟随系统', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(25, 27, 30)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.getByRole('button', { name: '插件与技能', exact: true }).click();
  await page.getByRole('button', { name: '浏览目录', exact: true }).click();
  await page.getByRole('button', { name: '技能', exact: true }).click();
  await expect(page.getByRole('main', { name: '技能管理' })).toBeVisible();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(input).toHaveValue('设置页面往返草稿');
});


test('edits provider catalogs and validates drafts at desktop and narrow widths', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '模型与执行', exact: true }).click();
  await page.screenshot({ path: info.outputPath('providers-default.png') });
  await page.getByRole('region', { name: 'DeepSeek供应商' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('模型 1 参数', { exact: true }).click();
  await page.getByLabel('模型 1 上下文窗口').fill('128K');
  await page.getByLabel('模型 1 最大输出 token 数').fill('4K');
  for (const width of [1280, 800, 400]) {
    await page.setViewportSize({ width, height: 760 });
    expect(await page.locator('.settings-page').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: '保存', exact: true }).click({ trial: true });
    await page.screenshot({ path: info.outputPath(`provider-expanded-${width}.png`) });
  }
  await page.getByLabel('模型 1 ID', { exact: true }).fill('');
  await expect(page.getByText('模型 1: 模型 ID 不能为空。')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('provider-invalid.png') });
  await page.getByLabel('模型 1 ID', { exact: true }).press('Escape');
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '添加模型提供商' }).click();
  await page.getByLabel('显示名称', { exact: true }).fill('可取消的供应商');
  await page.getByLabel('API 地址', { exact: true }).fill('https://example.test/v1');
  await page.getByLabel('模型 1 ID', { exact: true }).fill('draft-model');
  await page.getByLabel('模型 1 显示名称', { exact: true }).fill('草稿模型');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('region', { name: '可取消的供应商供应商' })).toHaveCount(0);
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '模型与执行', exact: true }).click();
  await page.getByRole('region', { name: 'DeepSeek供应商' }).getByRole('button', { name: '编辑', exact: true }).click();
  await page.screenshot({ path: info.outputPath('provider-dark.png') });
});

test('manages installed plugins, MCP and markets from Desktop settings', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop', '真实桌面管理操作验收一次，窗口尺寸在同一场景覆盖。');
  test.setTimeout(60000);
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/plugin-settings-ui-20261004');
  const profile = resolve(evidence, `profile-${Date.now()}`);
  const source = resolve(profile, 'source');
  await mkdir(resolve(source, '.agents/plugins'), { recursive: true });
  await mkdir(resolve(source, 'plugins/code-review/.codex-plugin'), { recursive: true });
  await writeFile(resolve(source, '.agents/plugins/marketplace.json'), JSON.stringify({ name: 'settings-market', interface: { displayName: '本地插件市场' }, plugins: [{ name: 'code-review', source: './plugins/code-review' }] }));
  await writeFile(resolve(source, 'plugins/code-review/.codex-plugin/plugin.json'), JSON.stringify({ name: 'code-review', description: '检查本地代码与项目文件。', interface: { displayName: '代码审查' }, mcpServers: { node_repl: { command: 'node', args: ['--version'], env: { TOKEN: '${REVIEW_TOKEN}' } } } }));
  const executablePath = createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  try {
    const page = await app.firstWindow();
    const settings = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '插件与技能', exact: true }).click(); };
    await settings();
    await expect(page.getByRole('tab', { name: '插件 0' })).toBeVisible();
    await page.getByRole('button', { name: '添加插件', exact: true }).click();
    await page.getByRole('menuitem', { name: '添加插件市场' }).click();
    const dialog = page.getByRole('dialog', { name: '添加插件市场' });
    await dialog.getByLabel('市场来源').fill(source);
    await dialog.getByRole('button', { name: '添加', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: '浏览目录' }).click();
    await expect(page.getByRole('tab', { name: '公开', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '安装 代码审查', exact: true }).click();
    await expect(page.getByRole('button', { name: '代码审查操作', exact: true })).toBeVisible();
    await settings();
    await expect(page.getByRole('tab', { name: '插件 1' })).toBeVisible();
    await page.getByRole('switch', { name: '启用 代码审查' }).click();
    await expect(page.getByRole('switch', { name: '启用 代码审查' })).not.toBeChecked();
    expect((await page.evaluate(() => window.agentDesktop.extensions.list())).plugins.find(item => item.name === '代码审查')?.enabled).toBe(false);
    await page.getByRole('switch', { name: '启用 代码审查' }).click();
    await expect(page.getByRole('switch', { name: '启用 代码审查' })).toBeChecked();
    for (const tab of ['插件 1', 'MCP 1', '市场 1']) {
      await page.getByRole('tab', { name: tab }).click();
      await page.screenshot({ path: resolve(evidence, `desktop-${tab.split(' ')[0]}.png`) });
    }
    await page.getByRole('button', { name: '升级', exact: true }).click();
    await expect(page.getByRole('button', { name: '升级', exact: true })).toBeEnabled();
    await expect(page.locator('.plugin-settings').getByRole('alert')).toHaveCount(0);
    await page.getByRole('tab', { name: 'MCP 1' }).click();
    await page.getByRole('textbox', { name: '搜索 MCP 服务器' }).fill('node_repl');
    await page.getByRole('button', { name: /代码审查.*node_repl/ }).click();
    await page.getByRole('button', { name: '配置', exact: true }).click();
    await page.getByLabel('REVIEW_TOKEN', { exact: true }).fill('settings-test-token');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '返回插件', exact: true }).click();
    for (const width of [800, 400]) {
      await page.setViewportSize({ width, height: 740 });
      for (const tab of ['插件 1', 'MCP 1', '市场 1']) {
        await page.getByRole('tab', { name: tab }).click();
        expect(await page.locator('.settings-page').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        await page.screenshot({ path: resolve(evidence, `${tab.split(' ')[0]}-${width}.png`) });
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: resolve(evidence, 'markets-dark.png') });
    await page.getByRole('button', { name: '移除 本地插件市场' }).click();
    await expect(page.getByRole('tab', { name: '市场 0' })).toBeVisible();
    await page.getByRole('tab', { name: '插件 1' }).click();
    await expect(page.getByRole('switch', { name: '启用 代码审查' })).toBeChecked();
  } finally { await app.close(); }
});

test('persists providers and encrypted credentials and executes both protocols through real Desktop IPC', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop', '桌面持久化只验收一次。');
  test.setTimeout(90000);
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/model-providers-ui-20261004');
  const profile = resolve(evidence, `electron-profile-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  let discovery = 0;
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe('Bearer desktop-test-key');
    if (request.method === 'GET') {
      expect(request.url).toBe('/v1/models'); discovery++;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'local-model', name: '本地模型' }, { id: 'extra-model', name: '额外模型' }] }));
      return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    requests.push({ url: request.url!, body });
    const text = request.url === '/v1/responses' ? 'Responses任务完成' : 'Chat任务完成';
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(request.url === '/v1/responses' ? `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] } })}\n\n` : `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing port');
  const executablePath = createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE;
  env.DEEPSEEK_API_KEY = 'desktop-model-choice-fixture-key';
  const launch = () => _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const models = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '模型与执行', exact: true }).click(); };
    await models();
    await page.screenshot({ path: resolve(evidence, 'desktop-models-default.png') });
    await page.getByRole('button', { name: '添加模型提供商' }).click();
    await page.getByLabel('显示名称', { exact: true }).fill('本地测试供应商');
    await page.getByLabel('API 地址', { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel('本地测试供应商 API 密钥', { exact: true }).fill('desktop-test-key');
    await page.getByRole('button', { name: '获取可用模型' }).click();
    await expect(page.getByText('已获取 2 个模型，保存后生效。')).toBeVisible();
    await page.getByLabel('模型 1 参数', { exact: true }).click();
    await page.getByLabel('模型 1 上下文窗口').fill('128K');
    await page.getByLabel('模型 1 最大输出 token 数').fill('4K');
    for (const label of ['文本输入', '文本输出', '图片输入', '视觉理解']) await page.getByLabel(`模型 1 ${label}`).selectOption('supported');
    // 先保存密钥，重新编辑时只显示配置状态，截图不包含新密钥草稿。
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.model-provider-editor')).toHaveCount(0);
    let saved = await page.evaluate(() => window.agentDesktop.loadRuntimeSettings());
    const custom = saved.modelProviders.find(provider => provider.displayName === '本地测试供应商')!;
    expect(custom.models[0]).toMatchObject({ contextWindow: 128000, maxOutputTokens: 4000, capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'supported', imageUnderstanding: 'supported' } });
    expect(JSON.stringify(saved)).not.toContain('desktop-test-key');
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.getByRole('button', { name: /^选择对话模型：/ }).click();
    await page.getByRole('menuitemradio', { name: /本地模型/ }).click();
    await models();
    await expect(page.getByRole('combobox', { name: '当前对话模型' })).toHaveCount(0);
    await expect(page.getByLabel('当前对话模型')).toContainText('本地测试供应商 · 本地模型');
    await expect(page.getByLabel('当前视觉模型', { exact: true })).toHaveCount(0);
    await page.getByRole('region', { name: '本地测试供应商供应商' }).getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('本地测试供应商 API 密钥')).toHaveValue('*'.repeat(64));
    await page.getByRole('region', { name: '本地测试供应商供应商' }).screenshot({ path: resolve(evidence, 'desktop-provider-masked-key.png') });
    await page.getByLabel('模型 1 参数', { exact: true }).click();
    await page.screenshot({ path: resolve(evidence, 'desktop-provider-expanded.png') });
    await page.getByRole('button', { name: '获取可用模型' }).click();
    await expect(page.getByText('已获取 2 个模型，保存后生效。')).toBeVisible();
    expect(discovery).toBe(2);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('回复测试结果');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Agent 回复' }).last()).toContainText('Chat任务完成');
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    expect(requests.some(item => item.url === '/v1/chat/completions' && item.body.model === 'local-model' && item.body.max_tokens === 4000 && !('thinking' in item.body))).toBe(true);
    await models();
    await page.getByRole('region', { name: '本地测试供应商供应商' }).getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByLabel('API 协议', { exact: true }).selectOption('responses');
    await page.getByLabel('模型 1 参数').click();
    for (const label of ['文本输入', '文本输出', '图片输入', '视觉理解']) await page.getByLabel(`模型 1 ${label}`).selectOption('supported');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.locator('.model-provider-editor')).toHaveCount(0);
    await page.getByRole('button', { name: '外观', exact: true }).click();
    await page.getByRole('button', { name: '深色', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await models();
    saved = await page.evaluate(() => window.agentDesktop.loadRuntimeSettings());
    expect(saved.conversationModel).toEqual({ providerId: custom.id, modelId: 'local-model' });
    expect(saved.modelProviders.find(provider => provider.id === custom.id)).toMatchObject({ protocol: 'responses', apiKey: { configured: true, source: 'saved' } });
    await page.screenshot({ path: resolve(evidence, 'desktop-provider-dark-restored.png') });
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('再回复一次');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Agent 回复' }).last()).toContainText('Responses任务完成');
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    expect(requests.some(item => item.url === '/v1/responses' && item.body.model === 'local-model' && item.body.max_output_tokens === 4000)).toBe(true);
    await models();
    await page.getByRole('region', { name: '本地测试供应商供应商' }).getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('切换模型');
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.getByRole('button', { name: '选择对话模型：本地模型' }).click();
    await page.getByRole('menuitemradio', { name: /DeepSeek V4 Pro/ }).click();
    await models();
    await expect(page.getByLabel('当前对话模型')).toContainText('DeepSeek · DeepSeek V4 Pro');
    await page.getByRole('region', { name: '本地测试供应商供应商' }).getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByRole('region', { name: '本地测试供应商供应商' })).toHaveCount(0);
    // 密钥只能存在于系统加密后的数据库值中，文件字节不能包含明文。
    expect((await readFile(resolve(profile, 'agent-desktop.sqlite'))).includes(Buffer.from('desktop-test-key'))).toBe(false);
  } finally { if (app) await app.close(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
});

test('adds standalone MCP through settings and runs its real tool after restart', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop', '独立 MCP 的真实任务与重启只验收一次。');
  test.setTimeout(90000);
  const root = resolve('../..'); const evidence = resolve(root, 'logs/standalone-mcp-ui-20261004');
  const profile = resolve(evidence, `profile-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const requireDesktop = createRequire(resolve(root, 'apps/desktop/package.json'));
  const esbuild = requireDesktop('esbuild') as { build(options: { entryPoints: string[]; outfile: string; bundle: boolean; platform: string; format: string }): Promise<unknown> };
  await esbuild.build({ entryPoints: [resolve(root, 'apps/desktop/tests/fixtures/extension-server.mjs')], outfile: resolve(profile, 'server.mjs'), bundle: true, platform: 'node', format: 'esm' });
  let serverPid = 0; let toolCalled = false;
  const modelServer = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    const input = JSON.parse(raw) as { tools: { function: { name: string; description: string } }[]; messages: { role: string; content: string }[] };
    const tool = input.tools.find(item => item.function.description.endsWith('Return text and server PID'));
    const result = input.messages.find(message => message.role === 'tool');
    if (result !== undefined) {
      const output = JSON.parse(result.content) as { content: { text: string }[] };
      const value = JSON.parse(output.content[0]!.text) as { text: string; pid: number };
      expect(value.text).toBe('standalone-desktop-result'); serverPid = value.pid; toolCalled = true;
    }
    const delta = tool !== undefined && result === undefined ? { tool_calls: [{ index: 0, id: 'standalone-echo', function: { name: tool.function.name, arguments: '{"text":"standalone-desktop-result"}' } }] } : { content: tool === undefined ? '独立 MCP 验证' : '独立 MCP 调用完成' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address(); if (!address || typeof address === 'string') throw new Error('模型夹具服务未启动。');
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ executablePath: requireDesktop('electron') as string, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const settings = async () => { await page.getByRole('button', { name: '设置', exact: true }).click(); await page.getByRole('button', { name: '插件与技能', exact: true }).click(); };
    await settings();
    await page.getByRole('button', { name: '添加插件' }).click();
    await expect(page.getByRole('menuitem', { name: '创建插件' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: '添加插件市场' })).toBeEnabled();
    await page.screenshot({ path: resolve(evidence, 'desktop-add-menu.png') });
    await page.getByRole('menuitem', { name: '添加 MCP 服务器' }).click();
    let editor = page.getByRole('dialog', { name: '添加 MCP 服务器' });
    await editor.getByLabel('服务器名称').fill('local-tools');
    await editor.getByLabel('启动命令').fill('node');
    await editor.getByLabel('启动参数（每行一个）').fill(`${resolve(profile, 'server.mjs')}\n${resolve(profile, 'waiting')}`);
    await editor.getByRole('button', { name: '添加环境变量' }).click();
    await editor.getByLabel('环境变量 1 名称').fill('TOKEN');
    await editor.getByLabel('环境变量 1 值').fill('standalone-desktop-secret');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'MCP 1' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('switch', { name: '启用 MCP local-tools' }).click();
    await expect(page.getByRole('switch', { name: '启用 MCP local-tools' })).not.toBeChecked();
    await app.close(); app = await launch(); page = await app.firstWindow();
    await settings(); await page.getByRole('tab', { name: 'MCP 1' }).click();
    await expect(page.getByRole('switch', { name: '启用 MCP local-tools' })).not.toBeChecked();
    await page.getByRole('button', { name: '配置 local-tools' }).click();
    editor = page.getByRole('dialog', { name: '配置 MCP 服务器' });
    await expect(editor.getByLabel('环境变量 1 值')).toHaveValue('');
    await editor.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('switch', { name: '启用 MCP local-tools' }).click();
    await expect(page.getByRole('switch', { name: '启用 MCP local-tools' })).toBeChecked();
    await page.screenshot({ path: resolve(evidence, 'desktop-mcp-servers.png') });
    for (const width of [800, 400]) {
      await page.setViewportSize({ width, height: 740 });
      await page.getByRole('button', { name: '添加插件' }).click();
      await page.screenshot({ path: resolve(evidence, `add-menu-${width}.png`) });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '配置 local-tools' }).click();
      expect(await page.getByRole('dialog').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: resolve(evidence, `mcp-editor-${width}.png`) });
      await page.getByRole('button', { name: '关闭', exact: true }).click();
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.getByRole('button', { name: '添加插件' }).click();
    await page.screenshot({ path: resolve(evidence, 'add-menu-dark.png') });
    await page.keyboard.press('Escape');
    await page.evaluate(baseUrl => window.agentDesktop.saveRuntimeSettings({ modelProvider: { id: 'deepseek', displayName: 'DeepSeek', apiKey: 'local-test-key', baseUrl, protocol: 'chat-completions', models: [{ id: 'deepseek-v4-pro', displayName: 'Test', capabilities: { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' } }] } }), `http://127.0.0.1:${address.port}`);
    await page.getByRole('button', { name: '关闭设置' }).click();
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('调用独立 MCP echo 工具');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByText('允许启动这个插件服务吗？')).toBeVisible();
    await page.getByRole('button', { name: '允许', exact: true }).click();
    await expect(page.getByText('允许插件执行这个工具调用吗？')).toBeVisible();
    await page.getByRole('button', { name: '允许', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Agent 回复' }).last()).toContainText('独立 MCP 调用完成');
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    expect(toolCalled).toBe(true);
    await expect.poll(() => { try { process.kill(serverPid, 0); return true; } catch { return false; } }).toBe(false);
    expect(JSON.stringify(await page.evaluate(() => window.agentDesktop.extensions.list()))).not.toContain('standalone-desktop-secret');
    expect((await readFile(resolve(profile, 'agent-desktop.sqlite'))).includes(Buffer.from('standalone-desktop-secret'))).toBe(false);
    await settings(); await page.getByRole('tab', { name: 'MCP 1' }).click();
    await page.getByRole('button', { name: '配置 local-tools' }).click();
    await page.getByRole('button', { name: '删除服务器' }).click();
    await expect(page.getByRole('tab', { name: 'MCP 0' })).toBeVisible();
  } finally {
    await app?.close();
    await new Promise<void>(resolve => { modelServer.closeAllConnections(); modelServer.close(() => resolve()); });
  }
});
