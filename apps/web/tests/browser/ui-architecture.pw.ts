import { expect, test } from '@playwright/test';

/**
 * 桌面 UI 架构与活动轨迹验收：真实渲染的活动行、状态与输入区关系在多种窗口下保持可用。
 * 这里只替换开发宿主，产品组件与样式均为真实实现；模拟活动使用与 Desktop 相同的活动契约，
 * 不代表真实模型或剪辑执行。
 */
test('keeps the desktop layout across empty, processing, cancelled, success and failure states', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 750 });
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { createWebClientApi as createHost } from '/webClientApi.ts?architecture-fixture';
      export function createWebClientApi() {
        const listeners = new Set();
        let rejectTask;
        const emit = (item) => listeners.forEach(fn => fn({type: 'activity', item}));
        const input = {path: 'E:/videos/web-test-video.mp4', label: 'web-test-video.mp4', role: 'input'};
        const output = {path: 'E:/videos/精彩片段-架构验收.mp4', label: '精彩片段-架构验收.mp4', role: 'output'};
        return {
          ...createHost(),
          onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          async runAgentTask(prompt) {
            emit({id: 'model-1', kind: 'analysis', status: 'running'});
            emit({id: 'model-1', kind: 'analysis', status: 'completed', durationMs: 640, plannedToolCallCount: 1});
            emit({id: 'tool-1', kind: 'tool', status: 'running', toolName: 'probe_media', files: [input]});
            if (prompt === '测试处理中') {
              listeners.forEach(fn => fn({type: 'text.delta', delta: '正在读取视频信息并确认需要保留的片段。'}));
              return new Promise((resolve, reject) => { rejectTask = reject; });
            }
            if (prompt === '测试失败') {
              emit({id: 'tool-1', kind: 'tool', status: 'failed', toolName: 'probe_media', files: [input], durationMs: 120});
              throw new Error('视频文件无法读取，请重新选择文件后重试。');
            }
            emit({id: 'tool-1', kind: 'tool', status: 'completed', toolName: 'probe_media', files: [input], durationMs: 210});
            emit({id: 'tool-2', kind: 'tool', status: 'completed', toolName: 'trim_video', files: [input, output], durationMs: 860});
            return {responseText: '已整理精彩片段并保留人物对白。', traceId: 'architecture-fixture', outputFiles: [{ path: 'E:/videos/精彩片段-架构验收.mp4', fileName: '精彩片段-架构验收.mp4' }]};
          },
          async cancelTask() { rejectTask(new DOMException('任务已停止', 'AbortError')); },
        };
      }
    `,
  }));

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: '剪辑需求' });
  const sidebar = page.getByRole('complementary', { name: '工作区导航' });
  const workspace = page.getByRole('main', { name: '对话工作区' });

  // 空会话：欢迎内容与输入区组成居中整体。
  await expect(sidebar).toBeVisible();
  await expect(page.getByRole('heading', { name: '开始一个视频任务' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeDisabled();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1100x750-empty.png') });

  // 附件与草稿。
  await page.getByRole('button', { name: '选择输入文件', exact: true }).click();
  await expect(page.getByLabel('已选择的输入附件').getByLabel('视频附件：web-test-video.mp4', { exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1100x750-attachment.png') });

  // 处理中：活动按真实顺序展开，发送变停止，输入区回到底部停靠。
  await composer.fill('测试处理中');
  await composer.press('Enter');
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
  await expect(page.getByText('正在读取视频信息并确认需要保留的片段。')).toBeVisible();
  const processingActivity = page.getByRole('region', { name: '执行过程' }).last();
  await expect(processingActivity.getByText('分析任务', { exact: true })).toBeVisible();
  await expect(processingActivity.getByText('计划调用 1 个工具', { exact: true })).toBeVisible();
  await expect(processingActivity.getByText('读取视频信息', { exact: true })).toBeVisible();
  await expect(processingActivity.getByText('执行中', { exact: true })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1100x750-processing.png') });

  // 取消：保留草稿与已完成的工具状态。
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByText('已停止', { exact: true }).first()).toBeVisible();
  await expect(composer).toHaveValue('测试处理中');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1100x750-cancelled.png') });

  // 成功：回复、产物与折叠后的活动摘要；展开后按执行顺序显示模型步骤和两次工具调用。
  await composer.fill('测试成功');
  await composer.press('Enter');
  await expect(page.getByRole('region', { name: '结果产物' })).toContainText('精彩片段-架构验收.mp4');
  const successActivity = page.getByRole('region', { name: '执行过程' }).last();
  await successActivity.getByRole('button', { name: '展开执行过程，共 3 项' }).click();
  await expect(successActivity.getByText('trim_video', { exact: true })).toBeVisible();
  await expect(successActivity.getByRole('button', { name: '定位文件：E:/videos/精彩片段-架构验收.mp4' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1100x750-success.png') });

  // 失败：错误可读、草稿保留、活动仍可展开。
  await composer.fill('测试失败');
  await composer.press('Enter');
  await expect(page.getByRole('alert')).toContainText('视频文件无法读取');
  await expect(composer).toHaveValue('测试失败');
  await page.getByRole('alert').getByRole('button', { name: '展开执行过程，共 2 项' }).click();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('1100x750-failure.png') });

  // 窄窗口：活动行、文件按钮、产物动作和按钮互不遮挡。
  for (const [width, height] of [[760, 600], [560, 600]] as const) {
    await page.setViewportSize({ width, height });
    await expect(workspace).toBeVisible();
    expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ animations: 'disabled', path: info.outputPath(`${width}x${height}-states.png`) });
  }
});
