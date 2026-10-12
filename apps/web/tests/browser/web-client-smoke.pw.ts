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
  await page.getByRole('button', { name: '模型与执行', exact: true }).click();
  const provider = page.getByRole('region', { name: 'DeepSeek供应商' });
  await provider.getByRole('button', { name: '编辑', exact: true }).click();
  const secretInput = page.getByLabel('DeepSeek API 密钥', { exact: true });
  await secretInput.fill('web-deepseek-secret');
  await page.getByLabel('模型 1 ID', { exact: true }).fill('web-runtime-model');
  await provider.getByRole('button', { name: '保存', exact: true }).click();
  await provider.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(secretInput).toHaveValue('*'.repeat(64));
  await secretInput.focus();
  await expect(secretInput).toHaveValue('');
  await secretInput.fill('pending-secret');
  await page.getByLabel('模型 1 ID', { exact: true }).focus();
  await expect(secretInput).toHaveValue('pending-secret');
  await secretInput.fill('');
  await page.getByLabel('模型 1 ID', { exact: true }).focus();
  await expect(secretInput).toHaveValue('*'.repeat(64));
  await page.getByRole('button', { name: '本地工具', exact: true }).click();
  await expect(page.getByRole('button', { name: 'FFmpeg', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 800, height: 600 });
  await expectNoHorizontalOverflow(page);

  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
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

  const activity = page.getByRole('region', { name: '执行过程' }).last();
  await expect(page.getByText('开发测试宿主已模拟完成：测试 Web Agent')).toBeVisible();
  await activity.getByRole('button', { name: '展开执行过程，共 3 次工具调用' }).click();
  await expect(activity.getByText('已完成', { exact: true }).first()).toBeVisible();
  await expect(activity.getByText('trim_video', { exact: true })).toBeVisible();
  await activity.getByRole('button', { name: '展开 读取文件 结果' }).click();
  await expect(activity.getByText('删除中间停顿', { exact: true })).toBeVisible();
  await expect(activity.getByRole('button', { name: '定位文件：E:/videos/web-dev-artifact.mp4' })).toBeVisible();

  const artifact = page.getByRole('region', { name: '结果产物' });
  await expect(artifact).toContainText('web-dev-artifact.mp4');

  // 逐项交付结果：总数来自声明集合，未交付项保留真实原因，不显示成全部完成。
  const delivery = page.getByRole('region', { name: '交付结果' });
  await expect(delivery).toContainText('交付结果 1/2');
  await expect(delivery).toContainText('web-dev-artifact.mp4');
  await expect(delivery).toContainText('已交付');
  await expect(delivery).toContainText('无法确认');
  await expect(delivery).toContainText('内容要求当前没有可靠的自动判定与覆盖方法，尚不能确认。');

  const sessionList = page.getByRole('navigation', { name: '会话列表' });
  const firstSession = sessionList.getByRole('button', { name: '取消 Web Agent', exact: true });
  await expect(firstSession).toHaveAttribute('aria-current', 'page');
  await newSessionButton.click();

  await expect(sessionList.locator('.sidebar-session')).toHaveCount(1);
  await composer.fill('另一项任务');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(newSessionButton).toBeEnabled();
  await expect(sessionList.locator('.sidebar-session')).toHaveCount(2);
  const secondSession = sessionList.getByRole('button', { name: '另一项任务', exact: true });
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
  await page.getByRole('button', { name: '会话操作：另一项任务' }).click();
  await page.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除会话' }).click();
  await expect(sessionList.locator('.sidebar-session', { hasText: '另一项任务' })).toHaveCount(0);

  await page.getByRole('button', { name: '重命名测试', exact: true }).click();
  await expect(page.getByText('开发测试宿主已模拟完成：测试 Web Agent')).toBeVisible();
  await page.getByRole('button', { name: '会话操作：重命名测试' }).click();
  await page.getByRole('button', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除会话' }).click();
  await expect(sessionList.locator('.sidebar-session')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '开始视频任务' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
