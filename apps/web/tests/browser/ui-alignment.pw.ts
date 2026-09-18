import { expect, test } from '@playwright/test';

// 仅替换开发宿主，使用真实产品组件检查可见状态；这些截图不代表模型或剪辑执行。
test('renders processing, cancellation, completion and failure without losing the composer', async ({ page }, info) => {
  await page.setViewportSize(info.project.name === 'chromium-desktop'
    ? { width: 1100, height: 750 } : { width: 560, height: 600 });
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { createWebClientApi as createHost } from '/webClientApi.ts?alignment-fixture';
      export function createWebClientApi() {
        const listeners = new Set();
        let rejectTask;
        return {
          ...createHost(),
          onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          async runAgentTask(prompt) {
            const item = {id: 'tool-1', kind: 'tool', toolName: 'trim_video', status: 'running'};
            listeners.forEach(fn => fn({type: 'activity', item}));
            if (prompt === '测试处理中') {
              listeners.forEach(fn => fn({type: 'text.delta', delta: '测试状态：正在分析视频中的对白与精彩片段。'}));
              return new Promise((resolve, reject) => { rejectTask = reject; });
            }
            if (prompt === '测试失败') {
              listeners.forEach(fn => fn({type: 'activity', item: {...item, status: 'failed', durationMs: 120}}));
              throw new Error('测试状态：视频文件无法读取，请重新选择文件后重试。');
            }
            listeners.forEach(fn => fn({type: 'activity', item: {...item, status: 'completed', durationMs: 860}}));
            return {responseText: '测试状态：已整理精彩片段，保留人物对白。', traceId: 'alignment-fixture', outputFiles: [{ path: 'E:/videos/精彩片段-测试产物.mp4', fileName: '精彩片段-测试产物.mp4' }]};
          },
          async cancelTask() { rejectTask(new DOMException('任务已停止', 'AbortError')); },
        };
      }
    `,
  }));
  await page.goto('/');
  const input = page.getByRole('textbox', { name: '剪辑需求' });
  await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await expect(page.locator('.sidebar-search')).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('empty.png') });
  await page.getByRole('button', { name: '选择输入文件', exact: true }).click();
  await input.fill('测试处理中');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('attachment.png') });
  const originalInput = await input.elementHandle();
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
  await expect(input).toBeDisabled();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('processing.png') });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('模型名称', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByText('已停止', { exact: true }).first()).toBeVisible();
  await expect(input).toHaveValue('测试处理中');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('cancelled.png') });
  await input.fill('测试成功');
  await input.press('Enter');
  await expect(page.getByRole('region', { name: '结果产物' })).toBeVisible();
  await expect(page.getByRole('button', { name: '预览', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '打开文件', exact: true })).toBeEnabled();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('success.png') });
  await input.fill('测试失败');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('视频文件无法读取');
  await expect(input).toHaveValue('测试失败');
  await expect(input).toBeEditable();
  await page.getByRole('alert').getByRole('button', { name: '展开执行过程，共 1 项' }).click();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('failure.png') });
  expect(await originalInput!.evaluate(element => element.isConnected)).toBe(true);
});

test('shows settings errors and keeps dialog controls reachable with keyboard', async ({ page }, info) => {
  // 暂停宿主响应，先检查真实加载态，再释放为失败结果。
  let releaseSettings!: () => void;
  const settingsReady = new Promise<void>((resolve) => { releaseSettings = resolve; });
  await page.route('**/alignment-settings-ready', async (route) => {
    await settingsReady;
    await route.fulfill({ body: '' });
  });
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { createWebClientApi as createHost } from '/webClientApi.ts?settings-error-fixture';
      export function createWebClientApi() {
        return {...createHost(), loadRuntimeSettings: async () => {
          await fetch('/alignment-settings-ready');
          throw new Error('测试状态：设置文件无法读取。');
        }};
      }
    `,
  }));
  await page.goto('/');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('正在加载设置…');
  await expect(page.getByRole('button', { name: '对话模型', exact: true })).toBeDisabled();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('settings-loading.png') });
  releaseSettings();
  await expect(page.getByRole('alert')).toHaveText('测试状态：设置文件无法读取。');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('settings-error.png') });
  await expect(page.getByRole('button', { name: '关闭设置' })).toBeFocused();
  await page.getByRole('button', { name: '关闭设置' }).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
