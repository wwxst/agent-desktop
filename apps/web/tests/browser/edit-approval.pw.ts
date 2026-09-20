import { expect, test } from '@playwright/test';

test('shows an exact text edit approval without overflowing desktop or narrow layouts', async ({ page }, info) => {
  await page.route(/\/webClientApi\.ts$/, (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `
      import { createWebClientApi as createHost } from '/webClientApi.ts?edit-approval-fixture';
      export function createWebClientApi() {
        const listeners = new Set();
        let finishTask;
        return {
          ...createHost(),
          onAgentEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
          runAgentTask() {
            setTimeout(() => listeners.forEach(listener => listener({
              type: 'approval.requested',
              request: {
                requestId: 'edit-request',
                kind: 'edit-file',
                target: 'D:/项目 资料/字幕与脚本/需要修改的中文长文件名.srt',
                before: '原内容：' + '这是一段需要核对的长文本。'.repeat(18),
                after: '新内容：' + '这是用户批准后才会写入的长文本。'.repeat(18),
              },
            })), 0);
            return new Promise(resolve => { finishTask = resolve; });
          },
          async decideApproval(requestId, approved) {
            if (requestId !== 'edit-request') throw new Error('该审批请求已失效。');
            finishTask({responseText: approved ? '已批准修改' : '已拒绝修改', traceId: 'edit-approval'});
          },
        };
      }
    `,
  }));

  await page.setViewportSize({ width: 1100, height: 750 });
  await page.goto('/');
  await page.getByRole('textbox', { name: '剪辑需求' }).fill('修改字幕');
  await page.getByRole('button', { name: '发送', exact: true }).click();

  const approval = page.getByRole('region', { name: '操作审批' });
  await expect(approval).toContainText('允许 Agent 修改这个文件吗？');
  await expect(approval).toContainText('原内容');
  await expect(approval).toContainText('新内容');
  expect(await approval.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('edit-approval-1100x750.png') });

  await page.setViewportSize({ width: 560, height: 600 });
  await approval.scrollIntoViewIfNeeded();
  expect(await approval.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ animations: 'disabled', path: info.outputPath('edit-approval-560x600.png') });

  await approval.getByRole('button', { name: '允许', exact: true }).click();
  await expect(page.getByText('已批准修改', { exact: true })).toBeVisible();
});
