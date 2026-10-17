import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('puts the ready update above Settings and installs directly in desktop and narrow layouts', async ({ page }, info) => {
  // 仅替换桌面更新宿主边界；真实 App、导航布局和按钮事件保持不变。
  await page.route('**/webClientApi.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    import { createWebClientApi as createHost } from '/webClientApi.ts?update-fixture';
    export function createWebClientApi() {
      return { ...createHost(), appUpdates: {
        getState: async () => ({ status: 'ready' }),
        onStateChanged(listener) {
          const receive = event => listener(event.detail);
          window.addEventListener('fixture:update', receive);
          return () => window.removeEventListener('fixture:update', receive);
        },
        install: async () => {
          document.documentElement.dataset.installCount = String(Number(document.documentElement.dataset.installCount || 0) + 1);
          window.dispatchEvent(new CustomEvent('fixture:update', { detail: { status: 'installing' } }));
        },
        retry: async () => {},
      } };
    }
  ` }));
  await page.goto('/');
  const update = page.getByRole('button', { name: '安装更新', exact: true });
  await expect(update).toBeEnabled();
  const settings = page.getByRole('button', { name: '设置', exact: true });
  const updateBox = (await update.boundingBox())!;
  const settingsBox = (await settings.boundingBox())!;
  expect(updateBox.x).toBe(settingsBox.x);
  expect(updateBox.y + updateBox.height).toBeLessThan(settingsBox.y);
  expect(settingsBox.y + settingsBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await mkdir(resolve('logs/app-update-20261002'), { recursive: true });
  await page.screenshot({ path: resolve(`logs/app-update-20261002/${info.project.name}-ready.png`) });
  await settings.click();
  await expect(update).toBeVisible();
  await update.click();
  await expect(page.getByRole('button', { name: '正在安装更新' })).toBeDisabled();
  await expect(page.locator('html')).toHaveAttribute('data-install-count', '1');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('keeps downloading disabled and shows a real failure with a retry action', async ({ page }, info) => {
  await page.route('**/webClientApi.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    import { createWebClientApi as createHost } from '/webClientApi.ts?update-failure';
    export function createWebClientApi() {
      return { ...createHost(), appUpdates: {
        getState: async () => ({ status: 'downloading', percent: 64 }),
        onStateChanged(listener) {
          const receive = event => listener(event.detail);
          window.addEventListener('fixture:update', receive);
          return () => window.removeEventListener('fixture:update', receive);
        },
        install: async () => { throw new Error('不应安装未下载完成的更新'); },
        retry: async () => { window.dispatchEvent(new CustomEvent('fixture:update', { detail: { status: 'downloading', percent: 0 } })); },
      } };
    }
  ` }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '正在下载更新 64%' })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:update', { detail: { status: 'error', message: '下载失败：HTTP 503' } })));
  const error = page.getByRole('alert');
  await expect(error).toHaveText('下载失败：HTTP 503');
  const box = (await error.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box.y).toBe(24);
  await page.screenshot({ path: resolve(`logs/app-update-20261002/${info.project.name}-error.png`) });
  await page.getByRole('button', { name: '关闭提示' }).click();
  await expect(error).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试更新' })).toBeEnabled();
  await page.getByRole('button', { name: '重试更新' }).click();
  await expect(error).toHaveCount(0);
  await expect(page.getByRole('button', { name: '正在下载更新 0%' })).toBeDisabled();
});

test('shows an unavailable release as a compact neutral notice without a failed update action', async ({ page }, info) => {
  await page.route('**/webClientApi.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    import { createWebClientApi as createHost } from '/webClientApi.ts?update-unavailable';
    export function createWebClientApi() {
      return { ...createHost(), appUpdates: {
        getState: async () => ({ status: 'unavailable' }),
        onStateChanged: () => () => {},
        install: async () => { throw new Error('无发行版不应调用安装器'); },
        retry: async () => { throw new Error('无发行版不展示错误重试入口'); },
      } };
    }
  ` }));
  await page.goto('/');
  const notice = page.getByRole('status').filter({ hasText: '暂未提供在线更新' });
  await expect(notice).toHaveText('暂未提供在线更新');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重试更新' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '安装更新' })).toHaveCount(0);
  const box = (await notice.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.height).toBeLessThan(60);
  expect(await notice.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
  await mkdir(resolve('../../logs/app-update-20261011'), { recursive: true });
  await page.screenshot({ path: resolve(`../../logs/app-update-20261011/${info.project.name}-unavailable.png`) });
});
