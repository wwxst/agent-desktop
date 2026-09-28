import { expect, test } from '@playwright/test';

/**
 * 活动轨迹验收：真实渲染的活动顺序、文件引用、定位失败反馈与恢复后的历史语义。
 * 这里只替换开发宿主；活动条目使用与 Desktop 相同的契约，不代表真实模型或剪辑执行。
 */
test('orders real activity, reveals files and reports a real reveal failure', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 750 });
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { createWebClientApi as createHost } from '/webClientApi.ts?activity-fixture';
      export function createWebClientApi() {
        const listeners = new Set();
        const emit = (item) => listeners.forEach(fn => fn({type: 'activity', item}));
        const input = {path: 'E:/videos/web-test-video.mp4', label: 'web-test-video.mp4', role: 'input'};
        const moved = {path: 'E:/videos/moved-away.mp4', label: 'moved-away.mp4', role: 'output'};
        return {
          ...createHost(),
          onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          // 定位失败必须是宿主返回的真实错误，界面只负责展示。
          async revealFile() { throw new Error('文件不存在或已被移动：E:/videos/moved-away.mp4'); },
          async runAgentTask(prompt) {
            emit({id: 'model-1', kind: 'analysis', status: 'running'});
            emit({id: 'model-1', kind: 'analysis', status: 'completed', durationMs: 1500, plannedToolCallCount: 1});
            emit({id: 'tool-1', kind: 'tool', status: 'running', toolName: 'extract_audio', files: [input]});
            emit({id: 'tool-1', kind: 'tool', status: 'completed', toolName: 'extract_audio', files: [input], durationMs: 62000});
            emit({id: 'tool-2', kind: 'tool', status: 'failed', toolName: 'add_subtitles', files: [input, moved], durationMs: 240});
            return {responseText: '对白已提取，字幕写入失败。', traceId: 'activity-fixture'};
          },
        };
      }
    `,
  }));

  await page.goto('/');
  const composer = page.getByRole('textbox', { name: '剪辑需求' });
  await composer.fill('提取对白并加字幕');
  await composer.press('Enter');

  // 完成后默认折叠为真实工具调用次数；模型步骤不伪装成一次工具调用。
  const activity = page.getByRole('region', { name: '执行过程' }).last();
  const toggle = activity.getByRole('button', { name: '展开执行过程，共 2 次工具调用' });
  await expect(toggle).toBeVisible();
  await expect(activity.getByRole('listitem')).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('activity-collapsed.png') });

  await toggle.click();
  const rows = activity.getByRole('listitem');
  await expect(rows).toHaveCount(3);

  // 顺序等于真实执行顺序；模型步骤显示真实计划工具数，耗时按真实时长格式化。
  await expect(rows.nth(0)).toContainText('分析任务');
  await expect(rows.nth(0)).toContainText('计划调用 1 个工具');
  await expect(rows.nth(0)).toContainText('1.5 s');
  await expect(rows.nth(1)).toContainText('提取音频');
  await expect(rows.nth(1)).toContainText('extract_audio');
  await expect(rows.nth(1)).toContainText('1 分 2 秒');
  await expect(rows.nth(2)).toContainText('添加字幕');
  await expect(rows.nth(2)).toContainText('失败');
  await expect(rows.nth(2)).toContainText('240 ms');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('activity-expanded.png') });

  // 文件引用来自真实路径：输入显示文件名，输出带方向前缀。
  await expect(rows.nth(1).getByRole('button', { name: '定位文件：E:/videos/web-test-video.mp4' })).toBeVisible();

  // 定位失败：真实错误只出现在产生它的活动行内。
  await rows.nth(2).getByRole('button', { name: '定位文件：E:/videos/moved-away.mp4' }).click();
  await expect(rows.nth(2).getByRole('status'))
    .toHaveText('文件不存在或已被移动：E:/videos/moved-away.mp4');
  await expect(rows.nth(1).getByRole('status')).toHaveCount(0);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('activity-reveal-failure.png') });

  // 窄窗口：活动行、文件按钮和状态互不遮挡，也不产生横向溢出。
  for (const [width, height] of [[760, 600], [560, 600]] as const) {
    await page.setViewportSize({ width, height });
    await expect(activity).toBeVisible();
    expect(await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.screenshot({ animations: 'disabled', path: info.outputPath(`activity-${width}x${height}.png`) });
  }
});

test('restores persisted activity with its own files and status', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 750 });
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { createWebClientApi as createHost } from '/webClientApi.ts?activity-history-fixture';
      export function createWebClientApi() {
        return {
          ...createHost(),
          loadClientState: async () => ({
            activeSessionId: 'web-session-1',
            conversations: [{
              id: 'web-session-1', title: '历史活动', titleManuallyRenamed: true, prompt: '', attachments: [],
              messages: [
                {id: 1, role: 'user', text: '提取对白并加字幕', attachments: []},
                {id: 2, role: 'assistant', status: 'completed', activityExpanded: false,
                 activity: [
                   {id: 'model:step-1', kind: 'analysis', status: 'completed', durationMs: 900, plannedToolCallCount: 2},
                   {id: 'call-1', kind: 'tool', status: 'completed', toolName: 'extract_audio', durationMs: 1200,
                    files: [{path: 'E:/videos/input.mp4', label: 'input.mp4', role: 'input'},
                            {path: 'E:/videos/audio.wav', label: 'audio.wav', role: 'output'}]},
                 ],
                 result: {responseText: '已提取对白。', traceId: 'trace-restored'}},
              ],
            }],
          }),
        };
      }
    `,
  }));

  await page.goto('/');
  await expect(page.getByText('已提取对白。')).toBeVisible();

  // 恢复的历史活动保持原来的折叠状态、顺序和文件引用。
  const activity = page.getByRole('region', { name: '执行过程' });
  const toggle = activity.getByRole('button', { name: '展开执行过程，共 1 次工具调用' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const rows = activity.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('计划调用 2 个工具');
  await expect(rows.nth(1)).toContainText('audio.wav');
  await expect(rows.nth(1).getByRole('button', { name: '定位文件：E:/videos/audio.wav' })).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: info.outputPath('activity-restored.png') });
});

test('discloses persisted file, directory, search, and failure details', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 750 });
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { createWebClientApi as createHost } from '/webClientApi.ts?activity-detail-fixture';
      export function createWebClientApi() {
        return {
          ...createHost(),
          loadClientState: async () => ({
            activeSessionId: 'web-session-1',
            conversations: [{
              id: 'web-session-1', title: '检查项目文件', titleManuallyRenamed: true, prompt: '', attachments: [],
              messages: [
                {id: 1, role: 'user', text: '检查项目说明和源码', attachments: []},
                {id: 2, role: 'assistant', status: 'completed', activityExpanded: true,
                 activity: [
                   {id: 'read-1', kind: 'tool', status: 'completed', toolName: 'read_file', durationMs: 8,
                    detail: {kind: 'file-content', filePath: 'D:/work/README.md', startLine: 1, endLine: 3,
                     totalLines: 3, lines: ['# Agent Desktop', '', '通用智能体桌面客户端。']}},
                   {id: 'list-1', kind: 'tool', status: 'completed', toolName: 'list_directory', durationMs: 12,
                    detail: {kind: 'directory', directory: 'D:/work', total: 3,
                     entries: [{name: 'apps', path: 'D:/work/apps', type: 'directory'},
                               {name: 'packages', path: 'D:/work/packages', type: 'directory'},
                               {name: 'package.json', path: 'D:/work/package.json', type: 'file'}]}},
                   {id: 'search-1', kind: 'tool', status: 'completed', toolName: 'search_text', durationMs: 34,
                    detail: {kind: 'search', directory: 'D:/work', pattern: 'AgentActivity', total: 2,
                     matches: [{filePath: 'packages/client/src/App.tsx', lineNumber: 4, line: 'import type { AgentActivityItem }'},
                               {filePath: 'packages/client/src/api.ts', lineNumber: 88, line: 'export interface AgentActivityItem {'}]}},
                   {id: 'failed-1', kind: 'tool', status: 'failed', toolName: 'read_file', durationMs: 5,
                    detail: {kind: 'error', message: '文件不存在：D:/work/missing.txt'}},
                 ],
                 result: {responseText: '已检查项目说明和相关源码。', traceId: 'trace-details'}},
              ],
            }],
          }),
        };
      }
    `,
  }));

  await page.goto('/');
  const activity = page.getByRole('region', { name: '执行过程' });
  await expect(activity.getByRole('button', { name: '收起执行过程，共 4 次工具调用' })).toBeVisible();

  await activity.getByRole('button', { name: '展开 读取文件 结果' }).first().click();
  await activity.getByRole('button', { name: '展开 列出目录 结果' }).click();
  await activity.getByRole('button', { name: '展开 搜索内容 结果' }).click();
  await activity.getByRole('button', { name: '展开 读取文件 结果' }).last().click();

  await expect(activity.getByText('第 1-3 行，共 3 行')).toBeVisible();
  await expect(activity.getByText('package.json', { exact: true })).toBeVisible();
  await expect(activity.getByText('packages/client/src/api.ts:88', { exact: true })).toBeVisible();
  await expect(activity.getByRole('status')).toHaveText('文件不存在：D:/work/missing.txt');
  await page.screenshot({ animations: 'disabled', path: info.outputPath('activity-details-1100x750.png') });

  await page.setViewportSize({ width: 560, height: 600 });
  expect(await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ) - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('activity-details-560x600.png') });
});
