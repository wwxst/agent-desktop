import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NsisUpdater } from 'electron-updater';
import type { AppUpdateState } from '@agent-desktop/client';

/** Windows 安装包更新：SDK 负责下载、校验与启动安装器；此处只维护真实展示状态。 */
export class DesktopUpdater {
  private readonly updater = new NsisUpdater({ provider: 'github', owner: 'wwxst', repo: 'agent-desktop' });
  private current: AppUpdateState = { status: 'idle' };

  constructor(private readonly publish: (state: AppUpdateState) => void, private readonly logFilePath: string) {
    mkdirSync(dirname(logFilePath), { recursive: true });
    // 发现新版本即后台下载；退出应用本身不构成安装授权，只有入口点击才安装。
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.on('checking-for-update', () => this.setState({ status: 'checking' }));
    this.updater.on('update-available', () => this.setState({ status: 'downloading', percent: 0 }));
    this.updater.on('download-progress', progress => this.setState({ status: 'downloading', percent: progress.percent }));
    this.updater.on('update-not-available', () => this.setState({ status: 'idle' }));
    this.updater.on('update-downloaded', () => this.setState({ status: 'ready' }));
    this.updater.on('error', (error: Error) => this.reportError(error));
  }

  get state(): AppUpdateState { return this.current; }

  private setState(state: AppUpdateState): void {
    this.current = state;
    this.publish(state);
  }

  private reportError(error: Error): void {
    // 外部更新异常保留完整诊断，界面只接收当前阶段的中文提示。
    appendFileSync(this.logFilePath, `${new Date().toISOString()} ${error.stack ?? error.message}\n`, 'utf8');
    const code = 'code' in error ? error.code : undefined;
    // SDK 会把 GitHub 最新发行版的 404/406 再包装成 feed 解析错误；不能把 503 等网络失败归为无版本。
    const noRelease = code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'
      || error.message === 'No published versions on GitHub'
      || ((code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND' || code === 'ERR_UPDATER_INVALID_RELEASE_FEED')
        && error.message.includes('Unable to find latest version on GitHub') && /HttpError:\s*(404|406)\b/.test(error.message));
    if (noRelease) { this.setState({ status: 'unavailable' }); return; }
    const message = code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' ? '更新文件尚未发布完整，请稍后重试。'
      : this.current.status === 'installing' ? '更新安装失败，请稍后重试。'
      : this.current.status === 'downloading' ? '更新下载失败，请检查网络后重试。'
      : '更新检查失败，请检查网络后重试。';
    this.setState({ status: 'error', message });
  }

  async check(): Promise<void> {
    if (this.current.status !== 'idle' && this.current.status !== 'error' && this.current.status !== 'unavailable') return;
    this.setState({ status: 'checking' });
    try { await this.updater.checkForUpdates(); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      // SDK 通常先发送 error 再拒绝同一请求，已经展示和记录的异常不重复处理。
      if (this.state.status === 'checking') this.reportError(error);
    }
  }

  async install(prepareClose: () => Promise<void>): Promise<void> {
    if (this.current.status !== 'ready') throw new Error('更新尚未下载完成，无法安装。');
    // 保存期间立即禁用重复点击，保存失败则保留已下载更新供重试。
    this.setState({ status: 'installing' });
    try { await prepareClose(); }
    catch (error) { this.setState({ status: 'ready' }); throw error; }
    this.updater.quitAndInstall(true, true);
  }
}
