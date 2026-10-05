import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';

test('keeps running indicators round in chat rows and collapsed projects until cancellation', async ({ page }, info) => {
  // 只控制宿主任务结束时机，使用真实客户端布局与侧栏运行状态。
  await page.route('**/webClientApi.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    import { createWebClientApi as createHost } from '/webClientApi.ts?running-fixture';
    export function createWebClientApi() {
      const host = createHost();
      let cancel;
      return { ...host,
        runAgentTask: () => new Promise((resolve, reject) => { cancel = () => reject(new DOMException('任务已停止', 'AbortError')); }),
        cancelTask: async () => cancel(),
      };
    }
  ` }));
  await page.goto('/');
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  if (info.project.name === 'chromium-800x600') {
    await page.getByRole('button', { name: '项目操作：web-project' }).click();
    await page.getByRole('button', { name: '在项目中新建会话', exact: true }).click();
  } else await page.getByRole('button', { name: '在 web-project 中新建会话' }).click();
  await page.getByLabel('剪辑需求').fill('检查项目配置和依赖关系，保留运行中标记');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const marks = page.getByRole('status', { name: '进行中', exact: true });
  await expect(marks).toHaveCount(2);
  const expectRound = async () => {
    for (const mark of await marks.all()) {
      await expect(mark).toBeVisible();
      expect(await mark.evaluate(element => {
        const style = getComputedStyle(element);
        return { width: style.width, height: style.height, grow: style.flexGrow, shrink: style.flexShrink };
      })).toEqual({ width: '10px', height: '10px', grow: '0', shrink: '0' });
      const bounds = (await mark.boundingBox())!;
      const button = (await mark.locator('..').boundingBox())!;
      // 旋转后的包围盒含圆环外透明角，留出像素取整后的三像素空间。
      expect(bounds.x).toBeGreaterThanOrEqual(button.x - 3);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(button.x + button.width + 3);
    }
  };
  await expectRound();
  await page.screenshot({ path: info.outputPath('running-rows.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '项目：web-project', exact: true }).click();
  await expect(marks).toHaveCount(2);
  await expectRound();
  await page.screenshot({ path: info.outputPath('running-collapsed-project.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '折叠项目', exact: true }).click();
  await expect(marks).toHaveCount(2);
  await expectRound();
  await page.screenshot({ path: info.outputPath('running-collapsed-section.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(marks).toHaveCount(0);
  await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
});

test('manages projects, context menus, archives and collapse in the shared sidebar', async ({ page }, info) => {
  await page.goto('/');
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  if (info.project.name === 'chromium-800x600') {
    await page.getByRole('button', { name: '项目操作：web-project' }).click();
    await page.getByRole('button', { name: '在项目中新建会话', exact: true }).click();
  } else await page.getByRole('button', { name: '在 web-project 中新建会话' }).click();
  await expect(page.getByRole('button', { name: '项目目录：web-project', exact: true })).toHaveAttribute('title', 'D:/projects/web-project');
  await page.getByLabel('剪辑需求').fill('项目内的工作');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
  const recent = page.locator('section[aria-label="最近"]');
  const chat = recent.getByRole('button', { name: '项目内的工作', exact: true });
  await chat.click({ button: 'right' });
  await page.getByRole('button', { name: '重命名', exact: true }).click();
  await page.getByLabel('会话标题').fill('项目内的工作');
  await page.getByLabel('会话标题').press('Enter');
  await recent.getByRole('button', { name: '会话操作：项目内的工作' }).click();
  await page.getByRole('button', { name: '置顶', exact: true }).click();
  await expect(recent.locator('.sidebar-session').first()).toHaveAttribute('aria-label', '项目内的工作');
  await page.getByRole('button', { name: '项目操作：web-project' }).click();
  await page.screenshot({ path: info.outputPath('project-menu.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '项目：web-project' }).click();
  await expect(page.locator('.sidebar-project-chats')).toHaveCount(0);
  await page.getByRole('button', { name: '项目：web-project' }).click();
  await recent.getByRole('button', { name: '会话操作：项目内的工作' }).click();
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(recent.getByRole('button', { name: '项目内的工作', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '已归档的对话', exact: true }).click();
  await page.getByRole('list', { name: '已归档对话列表' }).getByRole('button', { name: '项目内的工作', exact: true }).click();
  await expect(page.getByLabel('剪辑需求')).toBeDisabled();
  await page.getByRole('button', { name: '恢复会话', exact: true }).click();
  await expect(page.getByLabel('剪辑需求')).toBeEnabled();
  await page.getByRole('button', { name: '折叠项目', exact: true }).click();
  await page.getByRole('button', { name: '展开项目', exact: true }).click();
  await page.getByRole('button', { name: '最近侧栏选项' }).click();
  await page.getByRole('button', { name: '合并显示', exact: true }).click();
  await expect(page.getByRole('button', { name: '项目：web-project' })).toHaveCount(0);
  await page.getByRole('button', { name: '最近侧栏选项' }).click();
  await page.getByRole('button', { name: '分项目显示', exact: true }).click();
  await page.getByRole('button', { name: '项目操作：web-project' }).click();
  await page.getByRole('button', { name: '在项目中新建会话', exact: true }).click();
  await page.getByLabel('剪辑需求').fill('另一项项目任务');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '项目操作：web-project' }).click();
  await page.getByRole('button', { name: '归档聊天', exact: true }).click();
  await page.getByRole('button', { name: '归档全部', exact: true }).click();
  await expect(page.locator('.sidebar-project-chats .sidebar-session')).toHaveCount(0);
  await page.getByRole('button', { name: '折叠最近会话', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '已归档的对话', exact: true }).click();
  await expect(page.getByRole('list', { name: '已归档对话列表' }).locator('li')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('archive-settings.png') });
  await page.getByRole('button', { name: '恢复对话：项目内的工作', exact: true }).click();
  await expect(page.getByRole('list', { name: '已归档对话列表' }).locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: '删除对话：另一项项目任务', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('list', { name: '已归档对话列表' }).locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: '删除对话：另一项项目任务', exact: true }).click();
  await page.getByRole('button', { name: '删除会话', exact: true }).click();
  await expect(page.getByText('没有已归档的对话。')).toBeVisible();
  await page.screenshot({ path: info.outputPath('archive-empty.png') });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '展开最近会话', exact: true }).click();
  await page.screenshot({ path: info.outputPath('sidebar.png') });
  expect(await page.locator('.app-sidebar').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
});

test('restores project navigation and archived history through Desktop IPC and SQLite', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop', '真实桌面重启只验收一次。');
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/archive-settings-20261002');
  const directory = resolve(evidence, 'project-folder');
  const profile = resolve(evidence, `electron-profile-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  await mkdir(profile, { recursive: true });
  const executablePath = createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL; delete env.ELECTRON_RUN_AS_NODE;
  delete env.DEEPSEEK_API_KEY;
  const launch = () => _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => { Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }) }); }, directory);
    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    await page.getByRole('button', { name: '在 project-folder 中新建会话' }).click();
    await expect(page.getByRole('button', { name: '项目目录：project-folder', exact: true })).toHaveAttribute('title', directory);
    const recent = page.locator('section[aria-label="最近"]');
    // 无模型凭据的入口也保留真实提交和失败历史，供归档与恢复验收。
    await page.getByLabel('剪辑需求').fill('持久化项目会话');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('button', { name: '新会话', exact: true })).toBeEnabled();
    await page.getByLabel('剪辑需求').fill('重启后保留的草稿');
    await recent.getByRole('button', { name: '会话操作：持久化项目会话' }).click();
    await page.getByRole('button', { name: '重命名', exact: true }).click();
    await page.getByLabel('会话标题').fill('持久化项目会话');
    await page.getByLabel('会话标题').press('Enter');
    await recent.getByRole('button', { name: '会话操作：持久化项目会话' }).click();
    await page.getByRole('button', { name: '置顶', exact: true }).click();
    await recent.getByRole('button', { name: '会话操作：持久化项目会话' }).click();
    await page.getByRole('button', { name: '归档', exact: true }).click();
    await page.getByRole('button', { name: '项目：project-folder' }).click();
    await app.close();
    app = await launch(); page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '项目：project-folder' })).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '已归档的对话', exact: true }).click();
    await page.screenshot({ path: resolve(evidence, 'desktop-archive-settings.png') });
    await page.getByRole('list', { name: '已归档对话列表' }).getByRole('button', { name: '持久化项目会话', exact: true }).click();
    await expect(page.getByLabel('剪辑需求')).toHaveValue('重启后保留的草稿');
    await expect(page.getByLabel('剪辑需求')).toBeDisabled();
    await expect(page.getByRole('button', { name: '项目目录：project-folder', exact: true })).toHaveAttribute('title', directory);
    const restored = await page.evaluate(() => window.agentDesktop.loadClientState());
    expect(restored?.conversations.find(item => item.title === '持久化项目会话')).toMatchObject({ archived: true, pinned: true, workingDirectory: directory });
    await page.screenshot({ path: resolve(evidence, 'desktop-archived-restored.png') });
    await page.getByRole('button', { name: '恢复会话', exact: true }).click();
      await page.getByRole('button', { name: '项目：project-folder' }).click();
    await page.screenshot({ path: resolve(evidence, 'desktop-sidebar.png') });
    await page.setViewportSize({ width: 800, height: 600 });
    await page.getByRole('button', { name: '项目操作：project-folder' }).click();
    await expect(page.getByRole('button', { name: '在项目中新建会话', exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(evidence, 'desktop-sidebar-narrow-menu.png') });
    expect(await page.locator('.app-sidebar').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  } finally { if (app !== undefined) await app.close(); }
});
