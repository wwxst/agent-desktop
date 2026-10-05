import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateState } from '@agent-desktop/client';
import { DesktopUpdater } from '../src/main/app-updater.js';

const sdk = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn(), instances: [] as EventEmitter[] }));
vi.mock('electron-updater', () => ({
  NsisUpdater: class extends EventEmitter {
    autoDownload = false;
    autoInstallOnAppQuit = true;
    constructor() { super(); sdk.instances.push(this); }
    checkForUpdates() { return sdk.check(); }
    quitAndInstall(...args: unknown[]) { sdk.install(...args); }
  },
}));

describe('desktop application updates', () => {
  beforeEach(() => { sdk.check.mockReset(); sdk.install.mockReset(); sdk.instances.length = 0; });

  it('downloads after discovery and waits for an explicit installation click', async () => {
    const states: AppUpdateState[] = [];
    const host = new DesktopUpdater(state => states.push(state));
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
    const host = new DesktopUpdater(() => {});
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
    const host = new DesktopUpdater(() => {});
    sdk.instances[0]!.emit('update-downloaded');
    await expect(host.install(async () => { throw new Error('磁盘不可写'); })).rejects.toThrow('磁盘不可写');
    expect(host.state.status).toBe('ready');
    expect(sdk.install).not.toHaveBeenCalled();
    await host.install(async () => {});
    expect(sdk.install).toHaveBeenCalledOnce();
  });

  it('reports a failed request and allows a user retry without replaying installation', async () => {
    const host = new DesktopUpdater(() => {});
    sdk.check.mockRejectedValueOnce(new Error('HTTP 503'));
    await host.check();
    expect(host.state).toEqual({ status: 'error', message: 'HTTP 503' });
    await host.check();
    sdk.instances[0]!.emit('update-not-available');
    expect(host.state.status).toBe('idle');
    expect(sdk.check).toHaveBeenCalledTimes(2);
    expect(sdk.install).not.toHaveBeenCalled();
  });

  it('keeps an installer failure visible instead of claiming success', async () => {
    const host = new DesktopUpdater(() => {});
    sdk.instances[0]!.emit('update-downloaded');
    sdk.install.mockImplementation(() => sdk.instances[0]!.emit('error', new Error('安装器启动失败')));
    await host.install(async () => {});
    expect(host.state).toEqual({ status: 'error', message: '安装器启动失败' });
  });
});
