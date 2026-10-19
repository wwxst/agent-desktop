import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateState } from '@agent-desktop/client';
import { DesktopUpdater } from '../src/main/app-updater.js';

const sdk = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn(), instances: [] as EventEmitter[],
  beforeRequest: undefined as ((details: { url: string; method: string }, callback: (result: { cancel: boolean }) => void) => void) | undefined }));
vi.mock('electron-updater', () => ({
  NsisUpdater: class extends EventEmitter {
    autoDownload = false;
    autoInstallOnAppQuit = true;
    netSession = { webRequest: { onBeforeRequest: (listener: typeof sdk.beforeRequest) => { sdk.beforeRequest = listener; } } };
    constructor() { super(); sdk.instances.push(this); }
    checkForUpdates() { return sdk.check(); }
    quitAndInstall(...args: unknown[]) { sdk.install(...args); }
  },
}));

describe('desktop application updates', () => {
  let directory: string;
  let logFilePath: string;
  beforeEach(() => {
    sdk.check.mockReset(); sdk.install.mockReset(); sdk.instances.length = 0; sdk.beforeRequest = undefined;
    directory = mkdtempSync(join(tmpdir(), 'app-updater-'));
    logFilePath = join(directory, 'logs', 'app-updater.log');
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('requires an explicit update operation and admits each SDK request including redirect targets', async () => {
    const authorize = vi.fn(async (request: { url: string }) => new URL(request.url).hostname === 'github.com');
    const host = new DesktopUpdater(() => {}, logFilePath, authorize);
    expect(sdk.check).not.toHaveBeenCalled();
    await host.check(false);
    expect(authorize).not.toHaveBeenCalled(); expect(sdk.check).not.toHaveBeenCalled();
    await host.check(); expect(sdk.check).toHaveBeenCalledOnce();
    const denied = await new Promise(resolve => sdk.beforeRequest!({ url: 'https://other.test/update.exe', method: 'GET' }, resolve));
    expect(denied).toEqual({ cancel: true });
    const allowed = await new Promise(resolve => sdk.beforeRequest!({ url: 'https://github.com/wwxst/agent-desktop/releases', method: 'GET' }, resolve));
    expect(allowed).toEqual({ cancel: false });
    expect(authorize).toHaveBeenLastCalledWith({ url: 'https://github.com/wwxst/agent-desktop/releases', method: 'GET', resourceType: 'app-update' });
    const rejected = new DesktopUpdater(() => {}, logFilePath, async () => false);
    await rejected.check(); expect(sdk.check).toHaveBeenCalledOnce();
    expect(rejected.state.status).toBe('error');
  });

  it('downloads after discovery and waits for an explicit installation click', async () => {
    const states: AppUpdateState[] = [];
    const host = new DesktopUpdater(state => states.push(state), logFilePath);
    const transport = sdk.instances[0]!;
    await host.check();
    transport.emit('update-available');
    transport.emit('download-progress', { percent: 48 });
    expect(host.state).toEqual({ status: 'downloading', percent: 48 });
    await expect(host.install(async () => {})).rejects.toThrow('尚未下载完成');
    transport.emit('update-downloaded');
    expect(host.state).toEqual({ status: 'ready' });
    expect(sdk.install).not.toHaveBeenCalled();
    expect(transport).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: false });
    expect(states).toContainEqual({ status: 'ready' });
  });

  it('saves the session before installing and rejects a duplicate click while saving', async () => {
    const host = new DesktopUpdater(() => {}, logFilePath);
    sdk.instances[0]!.emit('update-downloaded');
    let saved!: () => void;
    const pending = host.install(() => new Promise<void>(resolve => { saved = resolve; }));
    expect(host.state.status).toBe('installing');
    expect(sdk.install).not.toHaveBeenCalled();
    await expect(host.install(async () => {})).rejects.toThrow('尚未下载完成');
    saved();
    await pending;
    expect(sdk.install).toHaveBeenCalledExactlyOnceWith(true, true);
  });

  it('keeps the downloaded update available when session saving fails', async () => {
    const host = new DesktopUpdater(() => {}, logFilePath);
    sdk.instances[0]!.emit('update-downloaded');
    await expect(host.install(async () => { throw new Error('磁盘不可写'); })).rejects.toThrow('磁盘不可写');
    expect(host.state.status).toBe('ready');
    expect(sdk.install).not.toHaveBeenCalled();
    await host.install(async () => {});
    expect(sdk.install).toHaveBeenCalledOnce();
  });

  it('reports a failed request and allows a user retry without replaying installation', async () => {
    const host = new DesktopUpdater(() => {}, logFilePath);
    sdk.check.mockRejectedValueOnce(new Error('HTTP 503'));
    await host.check();
    expect(host.state).toEqual({ status: 'error', message: '更新检查失败，请检查网络后重试。' });
    expect(readFileSync(logFilePath, 'utf8')).toContain('HTTP 503');
    await host.check();
    sdk.instances[0]!.emit('update-not-available');
    expect(host.state.status).toBe('idle');
    expect(sdk.check).toHaveBeenCalledTimes(2);
    expect(sdk.install).not.toHaveBeenCalled();
  });

  it('keeps an installer failure visible instead of claiming success', async () => {
    const host = new DesktopUpdater(() => {}, logFilePath);
    sdk.instances[0]!.emit('update-downloaded');
    sdk.install.mockImplementation(() => sdk.instances[0]!.emit('error', new Error('安装器启动失败')));
    await host.install(async () => {});
    expect(host.state).toEqual({ status: 'error', message: '更新安装失败，请稍后重试。' });
    expect(readFileSync(logFilePath, 'utf8')).toContain('安装器启动失败');
  });

  it.each([
    ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'No published versions on GitHub'],
    ['ERR_UPDATER_INVALID_RELEASE_FEED', 'Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/wwxst/agent-desktop/releases/latest), please ensure a production release exists: HttpError: 406'],
    ['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'Unable to find latest version on GitHub: HttpError: 404'],
  ])('reports an unavailable release without an error and keeps diagnostics (%s)', async (code, message) => {
    const states: AppUpdateState[] = [];
    const host = new DesktopUpdater(state => states.push(state), logFilePath);
    const failure = Object.assign(new Error(message), { code });
    // 真实 SDK 会先通知 error 再拒绝同一检查请求，诊断与用户状态只产生一次。
    sdk.check.mockImplementationOnce(async () => { sdk.instances[0]!.emit('error', failure); throw failure; });
    await host.check();
    expect(host.state).toEqual({ status: 'unavailable' });
    expect(states).toEqual([{ status: 'checking' }, { status: 'unavailable' }]);
    expect(readFileSync(logFilePath, 'utf8').split(message)).toHaveLength(2);
    await host.check();
    sdk.instances[0]!.emit('update-not-available');
    expect(host.state.status).toBe('idle');
    expect(sdk.install).not.toHaveBeenCalled();
  });

  it('keeps a wrapped latest-release network failure as an error and preserves its diagnostics', async () => {
    const host = new DesktopUpdater(() => {}, logFilePath);
    const failure = Object.assign(new Error('Cannot parse releases feed: Unable to find latest version on GitHub: HttpError: 503'), { code: 'ERR_UPDATER_INVALID_RELEASE_FEED' });
    sdk.check.mockRejectedValueOnce(failure);
    await host.check();
    expect(host.state).toEqual({ status: 'error', message: '更新检查失败，请检查网络后重试。' });
    expect(readFileSync(logFilePath, 'utf8')).toContain(failure.message);
    sdk.instances[0]!.emit('update-available');
    sdk.instances[0]!.emit('error', new Error('download: net::ERR_CONNECTION_RESET'));
    expect(host.state).toEqual({ status: 'error', message: '更新下载失败，请检查网络后重试。' });
    expect(readFileSync(logFilePath, 'utf8')).toContain('net::ERR_CONNECTION_RESET');
  });
});
