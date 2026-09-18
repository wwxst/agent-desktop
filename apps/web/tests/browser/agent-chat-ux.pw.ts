import { expect, test, type Page } from '@playwright/test';

/**
 * 对话体验验收：自动滚动跟随、长内容与窄窗口的容纳、以及 Markdown 正文的真实渲染。
 * 这里只替换开发宿主；回复文本使用与 Desktop 相同的契约，不代表真实模型输出。
 */

async function expectNoHorizontalScroll(page: Page) {
  for (const locator of [page.locator('body'), ...await page.getByRole('main').all()]) {
    expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
}

/** 长历史 + 分多次推送的真实形状增量，用于观察输出过程中用户的滚动位置是否被保留。 */
const SCROLL_FIXTURE = `
  import { createWebClientApi as createHost } from '/webClientApi.ts?chat-scroll-fixture';
  export function createWebClientApi() {
    const listeners = new Set();
    const messages = [];
    for (let index = 0; index < 20; index += 1) {
      messages.push({ id: index * 2 + 1, role: 'user', text: '第 ' + (index + 1) + ' 条任务', attachments: [] });
      messages.push({
        id: index * 2 + 2, role: 'assistant', status: 'completed', activityExpanded: false, activity: [],
        result: { responseText: '第 ' + (index + 1) + ' 条回复', traceId: 'trace-' + index },
      });
    }
    return {
      ...createHost(),
      loadClientState: async () => ({
        activeSessionId: 'web-session-1',
        conversations: [{
          id: 'web-session-1', title: '长历史', titleManuallyRenamed: true, prompt: '', attachments: [],
          messages,
        }],
      }),
      onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async runAgentTask() {
        for (let index = 0; index < 16; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          listeners.forEach((fn) => fn({ type: 'text.delta', delta: '流式片段 ' + index + ' ' }));
        }
        return { responseText: '长回复完成', traceId: 'trace-chat-scroll' };
      },
    };
  }
`;

test('follows the latest output, keeps a scrolled-up position, and returns to the end after switching sessions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 750 });
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: SCROLL_FIXTURE,
  }));
  await page.goto('/');

  // 恢复长历史后停在最新内容，而不是历史开头。
  const latestRestored = page.getByText('第 20 条回复');
  await expect(latestRestored).toBeInViewport();

  const workspace = page.getByRole('main', { name: '对话工作区' });
  const composer = page.getByRole('textbox', { name: '剪辑需求' });
  await composer.fill('继续处理');
  await composer.press('Enter');
  await expect(page.getByText('流式片段 0')).toBeVisible();

  // 输出过程中用户向上阅读：后续增量不得把视图强行拉回底部。
  await workspace.hover();
  await page.mouse.wheel(0, -10000);
  const firstTask = page.getByText('第 1 条任务');
  await expect(firstTask).toBeInViewport();
  await page.waitForTimeout(700);
  await expect(firstTask).toBeInViewport();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('reading-position-kept.png') });

  // 用户回到最新内容后继续跟随，输出结束时最新回复仍然可见。
  await page.mouse.wheel(0, 10000);
  await expect(page.getByText('长回复完成')).toBeInViewport();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('followed-latest.png') });

  // 切换会话再切回来时重新落在这一轮对话的结尾。
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await page.getByRole('button', { name: '长历史', exact: true }).click();
  await expect(page.getByText('长回复完成')).toBeInViewport();
  await expectNoHorizontalScroll(page);
});

/** 超长命令、超长路径和超长链接：都必须留在阅读轴内，代码块自己横向滚动。 */
const LONG_CONTENT_FIXTURE = `
  import { createWebClientApi as createHost } from '/webClientApi.ts?chat-long-fixture';
  export function createWebClientApi() {
    const command = 'ffmpeg -i "E:/videos/这是一个非常长的示例视频文件名-第一版-最终确认版.mp4" -vf "crop=1280:720:0:0,scale=1920:1080" -c:v libx264 -preset slow -crf 18 -movflags +faststart -y E:/videos/输出结果-最终版本-带字幕-确认版.mp4';
    const outputPath = 'E:/videos/一个非常长的目录名称/另一个同样很长的目录名称/最终输出文件-带字幕-确认版本.mp4';
    const reportUrl = 'https://example.com/reports/2026/09/very-long-report-identifier-with-many-segments?session=web-session-1&step=12&format=json';
    const reply = [
      '已完成剪辑，输出到 ' + '\`' + outputPath + '\`' + '。',
      '',
      '\`\`\`',
      command,
      '\`\`\`',
      '',
      '报告见 [在线查看](' + reportUrl + ')。',
    ].join('\\n');
    return {
      ...createHost(),
      runAgentTask: async () => ({ responseText: reply, traceId: 'trace-chat-long' }),
    };
  }
`;

test('keeps long replies, code blocks and links inside the reading axis', async ({ page }, testInfo) => {
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: LONG_CONTENT_FIXTURE,
  }));

  for (const [width, height] of [[1100, 750], [760, 600], [560, 600]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: '剪辑需求' });
    await composer.fill('输出长命令');
    await composer.press('Enter');

    const link = page.getByRole('link', { name: '在线查看' });
    await expect(link).toHaveAttribute('href', /^https:\/\/example\.com\/reports\//);
    await expect(page.getByText(/^ffmpeg -i/).first()).toBeVisible();
    await expect(page.getByText('输出结果-最终版本-带字幕-确认版.mp4')).toBeVisible();

    // 页面和主工作区都不横向溢出，超长命令只在代码块内部滚动。
    await expectNoHorizontalScroll(page);
    const scrollsInside = await page.getByText(/^ffmpeg -i/).first().evaluate((element) => {
      for (let node = element.parentElement; node !== null; node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth) return node.clientWidth < window.innerWidth;
      }
      return false;
    });
    expect(scrollsInside).toBe(true);

    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`long-content-${width}x${height}.png`) });
  }
});
