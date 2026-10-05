import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { _electron, expect, test } from '@playwright/test';

test('downloads with the real update SDK and flushes SQLite before the direct install call', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop', '桌面更新握手只验收一次。');
  const root = resolve('../..');
  const evidence = resolve(root, 'logs/app-update-20261002', `desktop-${Date.now()}`);
  await mkdir(evidence, { recursive: true });
  // 使用无可执行内容的更新载荷，真实 SDK 验证 SHA512；只拦截最后的安装器边界。
  const payload = Buffer.from('offline update transport fixture\n'.repeat(1024));
  const checksum = createHash('sha512').update(payload).digest('base64');
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/latest.yml')) {
      response.end(`version: 0.0.3\nfiles:\n  - url: fixture.exe\n    sha512: ${checksum}\n    size: ${payload.length}\npath: fixture.exe\nsha512: ${checksum}\n`);
    } else if (request.url?.startsWith('/fixture.exe')) {
      response.setHeader('Content-Length', payload.length);
      response.end(payload);
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  const hostRequire = createRequire(resolve(root, 'apps/desktop/package.json'));
  const bootstrap = resolve(evidence, 'bootstrap.cjs');
  const receipt = resolve(evidence, 'installation.json');
  const config = resolve(evidence, 'app-update.yml');
  await writeFile(config, `provider: generic\nurl: http://127.0.0.1:${address.port}\nupdaterCacheDirName: desktop-update-fixture-${Date.now()}\n`);
  await writeFile(bootstrap, `
    const electron = require('electron');
    const { createRequire } = require('node:module');
    const from = createRequire(${JSON.stringify(resolve(root, 'apps/desktop/package.json'))});
    electron.app.setAppPath(${JSON.stringify(resolve(root, 'apps/desktop'))});
    electron.app.getVersion = () => '0.0.2';
    Object.defineProperty(electron.app, 'isPackaged', { get: () => true });
    const id = from.resolve('electron-updater');
    const sdk = from('electron-updater');
    class FixtureUpdater extends sdk.NsisUpdater {
      constructor() {
        super({ provider: 'generic', url: 'http://127.0.0.1:${address.port}' });
        this.updateConfigPath = ${JSON.stringify(config)};
        this.disableDifferentialDownload = true;
      }
      quitAndInstall(...args) {
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(require('node:path').join(electron.app.getPath('userData'), 'agent-desktop.sqlite'));
        const row = db.prepare('SELECT value FROM desktop_documents WHERE name = ?').get('session-state');
        db.close();
        require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, saved: JSON.parse(row.value) }));
      }
    }
    require.cache[id].exports = { ...sdk, NsisUpdater: FixtureUpdater };
    from(${JSON.stringify(resolve(root, 'apps/desktop/dist/main/index.cjs'))});
  `);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  try {
    app = await _electron.launch({ executablePath: hostRequire('electron') as string, args: [bootstrap, `--user-data-dir=${resolve(evidence, 'profile')}`], env });
    const page = await app.firstWindow();
    const update = page.getByRole('button', { name: '安装更新', exact: true });
    await expect(update).toBeEnabled();
    const state = await page.evaluate(() => window.agentDesktop.appUpdates!.getState());
    expect(state).toEqual({ status: 'ready' });
    expect(existsSync(receipt)).toBe(false);
    await page.getByLabel('剪辑需求').fill('安装更新前保存这条草稿');
    await page.screenshot({ path: resolve(root, 'logs/app-update-20261002/desktop-ready.png') });
    await update.click();
    await expect(page.getByRole('button', { name: '正在安装更新' })).toBeDisabled();
    await expect.poll(() => existsSync(receipt)).toBe(true);
    const installed = JSON.parse(await readFile(receipt, 'utf8')) as { args: boolean[]; saved: { clientState: { drafts: { prompt: string }[] } } };
    expect(installed.args).toEqual([true, true]);
    expect(installed.saved.clientState.drafts[0]?.prompt).toBe('安装更新前保存这条草稿');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    if (app !== undefined) await app.close();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  }
});

test('starts the packaged application with bundled search, terminal and update bridge', async ({}, info) => {
  test.skip(info.project.name !== 'chromium-desktop', '安装包资源只验收一次。');
  const root = resolve('../..');
  const executablePath = resolve(root, 'apps/desktop/dist/installer/win-unpacked/Agent Desktop.exe');
  test.skip(!existsSync(executablePath), '需要先运行 desktop:package:win 生成安装包。');
  const profile = resolve(root, 'logs/app-update-20261002', `packaged-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.DESKTOP_RENDERER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByLabel('剪辑需求')).toBeVisible();
    const resources = await app.evaluate(async ({ app }) => {
      const from = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`);
      const search = process.getBuiltinModule('node:child_process').spawnSync(from('@vscode/ripgrep').rgPath, ['--version'], { encoding: 'utf8', windowsHide: true });
      const output = await new Promise<string>((done) => {
        let text = '';
        const terminal = from('node-pty').spawn('cmd.exe', ['/c', 'echo packaged-terminal'], { env: process.env });
        terminal.onData((data: string) => { text += data; });
        terminal.onExit(() => done(text));
      });
      return { packaged: app.isPackaged, name: app.getName(), version: app.getVersion(), searchCode: search.status, searchOutput: search.stdout, output };
    });
    expect(resources).toMatchObject({ packaged: true, name: '@agent-desktop/desktop', version: '0.0.2', searchCode: 0 });
    expect(resources.searchOutput).toContain('ripgrep');
    expect(resources.output).toContain('packaged-terminal');
    expect(await page.evaluate(() => window.agentDesktop.appUpdates!.getState())).toHaveProperty('status');
    await writeFile(resolve(root, 'logs/app-update-20261002/packaged-resources.json'), JSON.stringify(resources, null, 2));
    await page.screenshot({ path: resolve(root, 'logs/app-update-20261002/packaged-desktop.png') });
  } finally { await app.close(); }
});
