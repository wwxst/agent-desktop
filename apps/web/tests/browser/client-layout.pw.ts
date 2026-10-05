import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ClientStateSnapshot } from '@agent-desktop/client';

async function expectContained(locator: Locator, container: Locator) {
  const inner = (await locator.boundingBox())!;
  const outer = (await container.boundingBox())!;
  expect(inner.x).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
  expect(inner.y + inner.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
}

async function expectNoHorizontalScroll(page: Page) {
  for (const locator of [page.locator('body'), ...await page.getByRole('navigation', { name: '会话列表' }).all(), ...await page.getByRole('main').all()]) {
    expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
}

test('keeps session actions reachable at the end of a long list', async ({ page }, testInfo) => {
  const snapshot: ClientStateSnapshot = {
    activeSessionId: 'web-session-40',
    conversations: Array.from({ length: 40 }, (_, index) => ({ id: `web-session-${index + 1}`, title: `历史任务 ${index + 1}`, titleManuallyRenamed: false,
      prompt: '', attachments: [], messages: [{ id: index + 1, role: 'user' as const, text: `历史任务 ${index + 1}`, attachments: [] }] })),
  };
  await page.route('**/webClientApi.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    import { createWebClientApi as createHost } from '/webClientApi.ts?history-fixture';
    export function createWebClientApi() {
      const host = createHost();
      for (let i = 1; i < 40; i++) void host.newSession();
      return { ...host, loadClientState: async () => (${JSON.stringify(snapshot)}) };
    }
  ` }));
  await page.goto('/');
  const sessions = page.getByRole('navigation', { name: '会话列表' });
  const settings = page.getByRole('button', { name: '设置', exact: true });
  const navigation = page.getByRole('navigation', { name: '主导航', exact: true });
  const railBounds = (await navigation.boundingBox())!;
  const sidebarBounds = (await page.getByRole('complementary', { name: '工作区导航' }).boundingBox())!;
  expect(railBounds.x).toBe(0);
  expect(railBounds.width).toBe(52);
  expect(sidebarBounds.x).toBe(52);
  await expectContained(settings, navigation);
  await expect(page.getByRole('button', { name: '对话', exact: true })).toHaveAttribute('aria-current', 'page');
  const originalSettings = (await settings.boundingBox())!;
  expect(originalSettings.y + originalSettings.height).toBe((page.viewportSize()?.height ?? 0) - 14);
  await expect(sessions.locator('.sidebar-session')).toHaveCount(40);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('many-sessions.png') });
  expect.soft((await settings.boundingBox())!.y).toBe(originalSettings.y);
  await expectNoHorizontalScroll(page);
  const lastSession = sessions.getByRole('button', { name: '历史任务 40', exact: true });
  await expectContained(lastSession, sessions);
  const lastActions = page.getByRole('button', { name: '会话操作：历史任务 40', exact: true });
  const actionBounds = (await lastActions.boundingBox())!;
  const scrollbarStart = await sessions.evaluate((element) => element.getBoundingClientRect().left + element.clientWidth);
  // 窄侧栏隐藏滚动条，按钮可贴齐内容边界；有滚动条时仍不能进入它的占用区域。
  expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(scrollbarStart);
  await lastActions.click();
  const rename = page.getByRole('button', { name: '重命名', exact: true });
  // trial 检查命中区域，避免“存在且可见”漏掉被滚动容器裁切的按钮。
  await rename.click({ trial: true, timeout: 2000 });
  await rename.click();
  const title = page.getByRole('textbox', { name: '会话标题' });
  const longTitle = '一个需要保持菜单可用的长会话名称'.repeat(8);
  await title.fill(longTitle);
  await title.press('Enter');
  await expect(sessions.getByRole('button', { name: longTitle, exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: `会话操作：${longTitle}`, exact: true }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除会话确认' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.sidebar-session-menu')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('delete-confirmation.png') });
  await expectContained(dialog, page.locator('body'));
  const dialogBounds = (await dialog.boundingBox())!;
  expect(Math.abs(dialogBounds.x + dialogBounds.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(2);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: `会话操作：${longTitle}`, exact: true })).toBeFocused();
  await expect(sessions.locator('.sidebar-session')).toHaveCount(40);
  await page.getByRole('button', { name: `会话操作：${longTitle}`, exact: true }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(sessions.locator('.sidebar-session')).toHaveCount(40);
  await expect(page.getByRole('button', { name: '重命名', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `会话操作：${longTitle}`, exact: true }).click();
  await rename.click();
  await title.fill('短');
  await title.press('Enter');
  await expect(sessions.getByRole('button', { name: '短', exact: true })).toBeVisible();
  const actions = page.getByRole('button', { name: '会话操作：短', exact: true });
  await actions.press('Enter');
  await rename.click();
  await title.fill('取消此修改');
  await title.press('Escape');
  await expect(actions).toBeFocused();
  await actions.press('Enter');
  await rename.click();
  await title.fill('失焦保存');
  await page.getByRole('textbox', { name: '剪辑需求' }).click();
  await expect(sessions.getByRole('button', { name: '失焦保存', exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await settings.click();
  await expect(page.getByRole('main', { name: '设置' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '工作区导航' })).toHaveCount(0);
  await expect(settings).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await expect(sessions.getByRole('button', { name: '失焦保存', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('deletes only the confirmed conversation from a modal', async ({ page }, testInfo) => {
  await page.goto('/');
  await page.getByLabel('剪辑需求').fill('检查字幕');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await page.getByLabel('剪辑需求').fill('检查时长');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '会话操作：检查字幕', exact: true }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除会话确认' });
  await expect(dialog).toContainText('确定删除“检查字幕”？');
  await expect(dialog).toContainText('不会删除已经生成的视频文件');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('delete-modal.png') });
  await dialog.getByRole('button', { name: '删除会话', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '检查字幕', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '检查时长', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '检查时长', exact: true })).toBeFocused();
});

test('fits long attachments, expanded activity, failures and settings across window sizes', async ({ page }, testInfo) => {
  const names = Array.from({ length: 8 }, (_, index) => `${index}-${'长视频文件名'.repeat(20)}.mp4`);
  const snapshot: ClientStateSnapshot = {
    activeSessionId: 'web-session-1',
    conversations: [{
      id: 'web-session-1', title: '复杂内容验收', titleManuallyRenamed: true,
      prompt: '多行草稿\n'.repeat(12), attachments: names.map((name) => ({ path: `E:/videos/${name}`, name, role: 'video' })),
      messages: [
        { id: 1, role: 'user', text: '检查长文件名和多工具结果', attachments: names },
        {
          id: 2, role: 'assistant', status: 'completed', activityExpanded: true,
          activity: Array.from({ length: 8 }, (_, index) => ({
            id: `tool-${index}`, kind: 'tool', toolName: 'extract_video_range_frames',
            status: 'completed', durationMs: 12345,
          })),
          result: { responseText: '已完成', traceId: 'trace-'.repeat(40), outputFiles: [{ path: `E:/videos/${names[0]!}`, fileName: names[0]! }] },
        },
        { id: 3, role: 'assistant', status: 'failed', activity: [], activityExpanded: false, errorMessage: '失败路径_'.repeat(100) },
      ],
    }],
  };
  // 仅在测试宿主的模块边界提供历史数据，产品代码和真实桌面数据保持不变。
  await page.route(/\/webClientApi\.ts$/, async (route) => {
    await route.fulfill({ contentType: 'text/javascript', body: `
      import { createWebClientApi as createHost } from '/webClientApi.ts?layout-fixture';
      export function createWebClientApi() {
        const host = createHost();
        // 环境密钥状态在加载和自动保存返回中一致，普通字段仍使用真实开发宿主保存。
        const withEnvironmentKeys = settings => ({
          ...settings,
          modelProviders: settings.modelProviders.map(provider => ({...provider, apiKey: {configured: true, source: 'environment'}})),
        });
        return {
          ...host,
          loadClientState: async () => (${JSON.stringify(snapshot)}),
          loadRuntimeSettings: async () => withEnvironmentKeys(await host.loadRuntimeSettings()),
          saveRuntimeSettings: async update => withEnvironmentKeys(await host.saveRuntimeSettings(update)),
        };
      }
    ` });
  });
  await page.goto('/');
  await expect(page.getByRole('article', { name: 'Agent 回复' }).first()).toBeVisible();
  for (const [width, height] of [[1100, 750], [1120, 760], [1280, 720], [800, 600], [760, 600], [560, 600], [400, 500]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expectNoHorizontalScroll(page);
    const pending = page.getByLabel('已选择的输入附件');
    expect(await pending.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await expectContained(page.getByRole('button', { name: '发送', exact: true }), page.locator('body'));
    const attachment = pending.getByLabel(`视频附件：${names[0]}`, { exact: true });
    const name = attachment.locator('strong');
    const before = await name.boundingBox();
    await attachment.hover();
    expect(await name.boundingBox()).toEqual(before);
    await page.getByRole('region', { name: '执行过程' }).scrollIntoViewIfNeeded();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`content-${width}x${height}.png`) });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '模型与执行', exact: true }).click();
    const returnButton = page.getByRole('button', { name: '关闭设置', exact: true });
    await expect(page.getByRole('button', { name: '保存设置' })).toHaveCount(0);
    await expectContained(returnButton, page.locator('.settings-layout'));
    await returnButton.click({ trial: true });
    const returnBounds = (await returnButton.boundingBox())!;
    await expect(page.getByText('通过系统环境变量查找视频处理程序')).toBeAttached();
    await page.getByRole('region', { name: 'DeepSeek供应商' }).getByRole('button', { name: '编辑', exact: true }).click();
    await expect(page.getByLabel('DeepSeek API 密钥')).toHaveValue('*'.repeat(64));
    await expect(page.getByLabel('DeepSeek API 密钥')).toHaveAttribute('type', 'password');
    await page.getByLabel('API 地址', { exact: true }).fill('https://example.test/' + 'a'.repeat(250));
    await expectNoHorizontalScroll(page);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '本地工具', exact: true }).click();
    await page.getByText('通过系统环境变量查找视频处理程序').scrollIntoViewIfNeeded();
    await expect(page.getByText('通过系统环境变量查找视频处理程序')).toBeInViewport();
    expect((await returnButton.boundingBox())!.y).toBe(returnBounds.y);
    await returnButton.click({ trial: true });
    await expectContained(returnButton, page.locator('body'));
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`settings-${width}x${height}.png`) });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '剪辑需求' })).toHaveValue(snapshot.conversations[0]!.prompt);
  }
});

test('keeps a tall empty composer reachable in a short window', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 560, height: 320 });
  await page.goto('/');
  await page.getByRole('button', { name: '选择输入文件', exact: true }).click();
  await page.getByRole('textbox', { name: '剪辑需求' }).fill('多行草稿\n'.repeat(15));
  const workspace = page.getByRole('main', { name: '对话工作区' });
  await workspace.evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('short-empty.png') });
  expect((await page.getByRole('heading', { name: '开始一个视频任务' }).boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', { name: '发送', exact: true }).click({ trial: true });
  await expectNoHorizontalScroll(page);
});

test('scrolls conversation history independently of the composer', async ({ page }, testInfo) => {
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: '剪辑需求' });
  await composer.fill('长消息_without_spaces_'.repeat(150));
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('region', { name: '结果产物' })).toBeVisible();
  await composer.fill('保留草稿');
  const inputBox = (await composer.boundingBox())!;
  await page.getByRole('main', { name: '对话工作区' }).hover();
  await page.mouse.wheel(0, -10000);
  await expect(page.getByRole('article', { name: '你的任务' })).toBeInViewport();
  expect(Math.abs((await composer.boundingBox())!.y - inputBox.y)).toBeLessThanOrEqual(1);
  await expect(composer).toHaveValue('保留草稿');
  await expectNoHorizontalScroll(page);
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('history-and-composer.png') });
});
