import { expect, test, type Page } from '@playwright/test';

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ) - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('runs the shared client task and preserves session state', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');

  await expect(page).toHaveTitle('Agent Desktop');
  await expect(page.getByRole('complementary', { name: '工作区导航' })).toBeVisible();
  const newSessionButton = page.locator('.sidebar-new-session');
  await expect(newSessionButton).toBeVisible();
  const composer = page.getByRole('textbox', { name: '剪辑需求' });
  await expect(composer).toBeEditable();
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: '设置' }).click();
  await expect(page.getByRole('main', { name: '设置' })).toBeVisible();
  const secretInputs = page.locator('input[type="password"]');
  await expect(secretInputs).toHaveCount(2);
  await secretInputs.first().fill('web-deepseek-secret');
  await page.getByLabel('Model', { exact: true }).fill('web-runtime-model');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('设置已保存，将从下一次任务开始生效。')).toBeVisible();
  await expect(secretInputs.first()).toHaveValue('');
  await expect(page.getByText('来源：本机设置').first()).toBeVisible();
  await expect(page.getByText('使用系统 PATH')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: '会话 1', exact: true }).click();
  await expect(page.getByRole('main', { name: '对话工作区' })).toBeVisible();

  await composer.fill('取消 Web Agent');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible();
  await expect(newSessionButton).toBeDisabled();
  await page.getByRole('button', { name: '停止' }).click();
  await expect(page.getByText('已停止')).toBeVisible();
  await expect(composer).toBeEditable();

  await composer.fill('测试 Web Agent');
  await page.getByRole('button', { name: '发送' }).click();

  const toolActivity = page.getByRole('region', { name: '工具执行过程' }).last();
  await expect(toolActivity.getByText('执行中', { exact: true })).toBeVisible();
  await expect(page.getByText('开发测试宿主已模拟完成：测试 Web Agent')).toBeVisible();
  await toolActivity.getByRole('button', { name: '已执行 1 个工具' }).click();
  await expect(toolActivity.getByText('已完成', { exact: true })).toBeVisible();
  await expect(toolActivity.getByText('trim_video', { exact: true })).toBeVisible();

  const artifact = page.getByRole('region', { name: '结果产物' });
  await expect(artifact).toContainText('web-dev-artifact.mp4');

  const sessionList = page.getByRole('navigation', { name: '会话列表' });
  const firstSession = sessionList.getByRole('button', { name: '取消 Web Agent', exact: true });
  await expect(firstSession).toHaveAttribute('aria-current', 'page');
  await newSessionButton.click();

  await expect(sessionList.locator('.sidebar-session')).toHaveCount(2);
  const secondSession = sessionList.getByRole('button', { name: '会话 2', exact: true });
  await expect(secondSession).toHaveAttribute('aria-current', 'page');

  await firstSession.click();
  await expect(firstSession).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('开发测试宿主已模拟完成：测试 Web Agent')).toBeVisible();
  await expect(page.getByRole('region', { name: '结果产物' })).toContainText(
    'web-dev-artifact.mp4',
  );

  await composer.fill('Session A 未发送草稿');
  await secondSession.click();
  await expect(composer).toHaveValue('');
  await firstSession.click();
  await expect(composer).toHaveValue('Session A 未发送草稿');
  await expectNoHorizontalOverflow(page);

  await firstSession.click();
  await page.getByRole('button', { name: '会话操作：取消 Web Agent' }).click();
  await page.getByRole('button', { name: '重命名' }).click();
  const titleInput = page.getByRole('textbox', { name: '会话标题' });
  await titleInput.fill('重命名测试');
  await titleInput.press('Enter');
  await expect(sessionList.getByRole('button', { name: '重命名测试', exact: true })).toHaveAttribute('aria-current', 'page');

  await secondSession.click();
  await page.getByRole('button', { name: '会话操作：会话 2' }).click();
  await page.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除会话' }).click();
  await expect(sessionList.locator('.sidebar-session', { hasText: '会话 2' })).toHaveCount(0);

  await page.getByRole('button', { name: '重命名测试', exact: true }).click();
  await expect(page.getByText('开发测试宿主已模拟完成：测试 Web Agent')).toBeVisible();
  await page.getByRole('button', { name: '会话操作：重命名测试' }).click();
  await page.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除会话' }).click();
  await expect(sessionList.locator('.sidebar-session')).toHaveCount(1);
  await expect(sessionList.getByRole('button', { name: '会话 3', exact: true })).toHaveAttribute('aria-current', 'page');
  await expectNoHorizontalOverflow(page);
});
