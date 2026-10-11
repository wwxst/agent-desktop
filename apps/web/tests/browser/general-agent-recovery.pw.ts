import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';

test('recovers a persisted started turn after a forced Windows process exit without replaying it', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop', '异常退出恢复只在真实 Electron 项目验证。');
  test.setTimeout(120_000);
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/general-agent-core-20261012');
  const profile = resolve(evidence, `electron-recovery-${Date.now()}`);
  await mkdir(profile, { recursive: true });

  let requestCount = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requestCount += 1;
    // 第一轮请求保持未完成，模拟模型调用期间应用被强制结束。
    if (requestCount === 1) return;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '恢复后的任务已完成' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolveServer) => server.listen(0, '127.0.0.1', resolveServer));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('恢复验收模型服务未启动。');

  const executablePath = createRequire(resolve(root, 'apps/desktop/package.json'))('electron') as string;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  env.DEEPSEEK_API_KEY = 'recovery-fixture-key';
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${address.port}`;
  const launch = () => _electron.launch({ executablePath, args: ['.', `--user-data-dir=${profile}`], cwd: resolve(root, 'apps/desktop'), env });
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch();
    let page = await app.firstWindow();
    await page.getByRole('button', { name: '新会话', exact: true }).waitFor({ state: 'visible' });
    await page.getByLabel('剪辑需求').fill('执行一个会在应用退出后恢复的任务');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => requestCount).toBe(1);

    const pid = app.process().pid;
    if (pid === undefined) throw new Error('无法取得 Electron 进程号。');
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await app.close().catch(() => undefined);
    app = undefined;

    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: '继续未完成任务', exact: true })).toBeVisible();
    expect(requestCount).toBe(1);

    await page.getByRole('button', { name: '继续未完成任务', exact: true }).click();
    await expect(page.getByText('恢复后的任务已完成', { exact: true })).toBeVisible();
    expect(requestCount).toBeGreaterThanOrEqual(2);
  } finally {
    if (app !== undefined) await app.close().catch(() => undefined);
    server.closeAllConnections();
    await new Promise<void>((resolveServer) => server.close(() => resolveServer()));
    await rm(profile, { recursive: true, force: true });
  }
});
