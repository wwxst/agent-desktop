import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';
import type { RuntimeModelDefinition, RuntimeSettings } from '@agent-desktop/client';
import { DEFAULT_MODEL_PROVIDERS } from '@agent-desktop/client/model-defaults';

const textCapabilities: RuntimeModelDefinition['capabilities'] = { textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported' };
test('keeps composer model selection synchronized, focused and contained across themes, widths and zoom', async ({ page }, info) => {
  await page.goto('/');
  const providers = structuredClone(DEFAULT_MODEL_PROVIDERS);
  const fixture: RuntimeSettings = {
    modelProviders: providers.map(provider => provider.id !== 'deepseek' ? provider : { ...provider, apiKey: { configured: true, source: 'saved' }, models: [
      ...provider.models, { id: 'long-model', displayName: 'Long Model Name With Many Words And A Very Long Configuration Name', capabilities: textCapabilities },
      ...Array.from({ length: 12 }, (_, index) => ({ id: `extra-${index}`, displayName: `目录模型 ${index}`, capabilities: textCapabilities })),
    ] }),
    conversationModel: { providerId: 'deepseek', modelId: 'deepseek-v4-pro' }, fallbackVisionModel: null, fallbackVisionEnabled: false,
    whisper: { modelPath: '', cliPath: '' }, memoryEnabled: true, memoryFromToolChatsEnabled: true,
  };
  await page.evaluate(settings => { localStorage.setItem('agent-desktop:web-runtime-settings', JSON.stringify(settings)); }, fixture);
  // 网页宿主通过真实脱敏配置边界加载夹具；无需额外暴露 Desktop API。
  await page.reload();
  const input = page.getByRole('textbox', { name: '剪辑需求' });
  await input.fill('模型切换不丢失草稿');
  await page.getByRole('button', { name: '选择输入文件' }).click();
  await expect(page.getByLabel('视频附件：web-test-video.mp4')).toBeVisible();
  let trigger = page.getByRole('button', { name: '选择对话模型：DeepSeek V4 Pro' });
  await trigger.click();
  const menu = page.getByRole('menu', { name: '对话模型列表' });
  await expect(menu).toBeVisible();
  const bounds = await Promise.all([trigger.boundingBox(), menu.boundingBox(), page.getByRole('button', { name: '发送' }).boundingBox()]);
  expect(bounds[0]!.x + bounds[0]!.width).toBeLessThan(bounds[2]!.x);
  expect(Math.abs(bounds[0]!.y + bounds[0]!.height / 2 - bounds[2]!.y - bounds[2]!.height / 2)).toBeLessThan(2);
  expect(bounds[1]!.y + bounds[1]!.height).toBeLessThanOrEqual(bounds[0]!.y);
  await expect(menu.getByRole('menuitemradio', { name: /DeepSeek V4 Pro/ })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: /GPT-5.6 Luna/ })).toBeDisabled();
  expect(await page.locator('.composer-model-list').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await menu.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ }).click();
  trigger = page.getByRole('button', { name: '选择对话模型：DeepSeek V4.1 Flash' });
  await expect(trigger).toBeVisible();
  await expect(menu).not.toBeVisible();
  await expect(input).toHaveValue('模型切换不丢失草稿');
  await expect(page.getByLabel('视频附件：web-test-video.mp4')).toBeVisible();
  await trigger.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: /DeepSeek V4.1 Flash/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: /Long Model Name/ })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitemradio', { name: /DeepSeek V4 Pro/ })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: '配置自定义模型' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(menu).not.toBeVisible();
  await expect(page.getByRole('button', { name: '发送' })).toBeFocused();
  await trigger.focus();
  await trigger.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await trigger.click();
  await expect(menu).not.toBeVisible();
  await trigger.click();
  // 长列表会覆盖输入区，点击页面左上空白作为实际菜单外部点击。
  await page.mouse.click(10, 10);
  await expect(menu).not.toBeVisible();
  await trigger.click();
  await menu.getByRole('menuitem', { name: '配置自定义模型' }).click();
  await expect(page.getByRole('heading', { name: '模型', exact: true })).toBeVisible();
  await expect(page.getByLabel('当前视觉模型')).toHaveCount(0);
  await expect(page.getByLabel('当前对话模型')).toHaveValue(JSON.stringify({ providerId: 'deepseek', modelId: 'deepseek-flash' }));
  await page.getByLabel('当前对话模型').selectOption(JSON.stringify({ providerId: 'deepseek', modelId: 'long-model' }));
  await page.getByRole('button', { name: '关闭设置' }).click();
  trigger = page.getByRole('button', { name: /选择对话模型：Long Model Name/ });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    for (const [width, height, zoom] of [[1280, 720, 1], [800, 600, 1], [400, 500, 1], [800, 600, 1.5]]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.evaluate(zoom => { document.documentElement.style.zoom = String(zoom); }, zoom);
      await page.getByRole('button', { name: '发送' }).click({ trial: true });
      await trigger.click();
      await expect(menu).toBeVisible();
      const menuBounds = await menu.boundingBox();
      expect(menuBounds!.x).toBeGreaterThanOrEqual(0);
      expect(menuBounds!.y).toBeGreaterThanOrEqual(0);
      expect(menuBounds!.x + menuBounds!.width).toBeLessThanOrEqual(width!);
      expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(height!);
      expect(await page.locator('.composer').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      // 浮层打开时发送按钮仍在顶层命中范围内，长名称与缩放不会遮挡。
      expect(await page.getByRole('button', { name: '发送' }).evaluate(button => {
        const bounds = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
      })).toBe(true);
      await expect(menu).toBeVisible();
      await page.screenshot({ path: info.outputPath(`model-menu-${theme}-${width}-${zoom}.png`) });
      await page.keyboard.press('Escape');
    }
  }
  await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
  await page.reload();
  await expect(page.getByRole('button', { name: /选择对话模型：Long Model Name/ })).toBeVisible();
});

test('migrates Desktop visual candidate disabled and preserves active request model across switching and restart', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop', '真实 Electron 宿主验收执行一次。');
  test.setTimeout(60000);
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/model-routing-20261013');
  const profile = resolve(evidence, `desktop-profile-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  let release!: () => void;
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { model: string };
    requests.push(body.model);
    if (requests.length === 1) await new Promise<void>(resolve => { release = resolve; });
    response.setHeader('Content-Type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `完成 ${body.model}` }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing server port');
  const models = [{ id: 'first-model', displayName: '第一模型', images: false }, { id: 'second-model', displayName: '第二模型', images: true }];
  await writeFile(resolve(profile, 'runtime-settings.json'), JSON.stringify({ modelProviders: [
    { id: 'deepseek', displayName: 'DeepSeek', builtin: true, baseUrl: `http://127.0.0.1:${address.port}`, protocol: 'chat-completions', models },
    { id: 'openai', displayName: 'OpenAI', builtin: true, baseUrl: 'https://api.openai.com/v1', protocol: 'responses', models: [{ id: 'gpt-5.6-luna', displayName: 'Luna', images: true }] },
  ], conversationModel: { providerId: 'deepseek', modelId: 'first-model' }, visionModel: { providerId: 'deepseek', modelId: 'second-model' } }));
  const executablePath = createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE;
  env.DEEPSEEK_API_KEY = 'desktop-http-fixture-key';
  const launch = () => _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(); let page = await app.firstWindow();
    const saved = await page.evaluate(() => window.agentDesktop.loadRuntimeSettings());
    expect(saved).toMatchObject({ fallbackVisionEnabled: false, fallbackVisionModel: { providerId: 'deepseek', modelId: 'second-model' } });
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('开始第一任务');
    await page.getByRole('button', { name: '发送' }).click();
    await expect.poll(() => requests.length).toBe(1);
    await page.getByRole('button', { name: '选择对话模型：第一模型' }).click();
    await page.getByRole('menuitemradio', { name: /第二模型/ }).click();
    await expect(page.getByRole('button', { name: '选择对话模型：第二模型' })).toBeVisible();
    await expect(page.getByRole('button', { name: '停止' })).toBeEnabled();
    expect(requests).toEqual(['first-model']);
    await page.screenshot({ path: resolve(evidence, 'desktop-running-model-switch.png') });
    release();
    await expect(page.getByRole('article', { name: 'Agent 回复' }).last()).toContainText('完成 first-model');
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    expect(requests.every(model => model === 'first-model')).toBe(true); // 首轮命名也使用原模型。
    await page.getByRole('textbox', { name: '剪辑需求' }).fill('开始第二任务');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByRole('article', { name: 'Agent 回复' }).last()).toContainText('完成 second-model');
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '选择对话模型：第二模型' }).click();
    await page.screenshot({ path: resolve(evidence, 'desktop-model-menu.png') });
    await page.keyboard.press('Escape');
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '选择对话模型：第二模型' })).toBeVisible();
    expect(await page.evaluate(() => window.agentDesktop.loadRuntimeSettings())).toMatchObject({ conversationModel: { providerId: 'deepseek', modelId: 'second-model' }, fallbackVisionEnabled: false });
    await page.screenshot({ path: resolve(evidence, 'desktop-model-restored.png') });
  } finally { release?.(); if (app) await app.close(); await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
});
