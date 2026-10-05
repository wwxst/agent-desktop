import { NsisUpdater } from 'electron-updater';
import type { AppUpdateState } from '@agent-desktop/client';

/** Windows 安装包更新：SDK 负责下载、校验与启动安装器；此处只维护真实展示状态。 */
export class DesktopUpdater {
  private readonly updater = new NsisUpdater({ provider: 'github', owner: 'wwxst', repo: 'agent-desktop' });
  private current: AppUpdateState = { status: 'idle' };

  constructor(private readonly publish: (state: AppUpdateState) => void) {
    // 发现新版本即后台下载；退出应用本身不构成安装授权，只有入口点击才安装。
    this.updater.autoDownload = true;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.on('checking-for-update', () => this.setState({ status: 'checking' }));
    this.updater.on('update-available', () => this.setState({ status: 'downloading', percent: 0 }));
    this.updater.on('download-progress', progress => this.setState({ status: 'downloading', percent: progress.percent }));
    this.updater.on('update-not-available', () => this.setState({ status: 'idle' }));
    this.updater.on('update-downloaded', () => this.setState({ status: 'ready' }));
    this.updater.on('error', error => this.setState({ status: 'error', message: error.message }));
  }

  get state(): AppUpdateState { return this.current; }

  private setState(state: AppUpdateState): void {
    this.current = state;
    this.publish(state);
  }

  async check(): Promise<void> {
    if (this.current.status !== 'idle' && this.current.status !== 'error') return;
    this.setState({ status: 'checking' });
    try { await this.updater.checkForUpdates(); }
    catch (error) {
      if (!(error instanceof Error)) throw error;
      this.setState({ status: 'error', message: error.message });
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
