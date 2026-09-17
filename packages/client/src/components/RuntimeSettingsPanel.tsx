import { useEffect, useRef, useState } from 'react';
import type { AgentClientApi, RuntimeSecretStatus, RuntimeSettings } from '../api.js';

interface RuntimeSettingsPanelProps {
  readonly api: AgentClientApi;
  readonly isProcessing: boolean;
  readonly onClose: () => void;
}

function sourceLabel(status: RuntimeSecretStatus): string | null {
  if (status.source === 'saved') return '本机设置';
  if (status.source === 'environment') return '环境变量';
  return null;
}

function SecretStatus({ status }: { readonly status: RuntimeSecretStatus }) {
  const source = sourceLabel(status);
  return (
    <div className="settings-secret-status" aria-live="polite">
      <span>{status.configured ? '已配置' : '未配置'}</span>
      {source !== null && <small>来源：{source}</small>}
    </div>
  );
}

export function RuntimeSettingsPanel({ api, isProcessing, onClose }: RuntimeSettingsPanelProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState('deepseek');
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [deepSeekApiKey, setDeepSeekApiKey] = useState('');
  const [visionApiKey, setVisionApiKey] = useState('');
  const [deepSeekBaseUrl, setDeepSeekBaseUrl] = useState('');
  const [deepSeekModel, setDeepSeekModel] = useState('');
  const [visionBaseUrl, setVisionBaseUrl] = useState('');
  const [whisperModelPath, setWhisperModelPath] = useState('');
  const [whisperCliPath, setWhisperCliPath] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    // 原生模态框负责焦点圈定、Escape 关闭和背景不可交互，避免自建焦点管理。
    dialog.current!.showModal();
  }, []);

  const applySettings = (next: RuntimeSettings) => {
    setSettings(next);
    setDeepSeekBaseUrl(next.deepSeek.baseUrl);
    setDeepSeekModel(next.deepSeek.model);
    setVisionBaseUrl(next.vision.baseUrl);
    setWhisperModelPath(next.whisper.modelPath);
    setWhisperCliPath(next.whisper.cliPath);
  };

  useEffect(() => {
    let mounted = true;
    void api.loadRuntimeSettings().then((next) => {
      if (mounted) applySettings(next);
    }).catch((error: unknown) => {
      if (mounted) {
        setHasError(true);
        setMessage(error instanceof Error ? error.message : '无法加载设置。');
      }
    });
    return () => { mounted = false; };
  }, [api]);

  const save = async () => {
    if (isProcessing || isSaving) return;
    setIsSaving(true);
    setMessage(null);
    setHasError(false);
    try {
      const next = await api.saveRuntimeSettings({
        ...(deepSeekApiKey.length === 0 ? {} : { deepSeekApiKey }),
        deepSeekBaseUrl: deepSeekBaseUrl.length === 0 ? null : deepSeekBaseUrl,
        deepSeekModel: deepSeekModel.length === 0 ? null : deepSeekModel,
        ...(visionApiKey.length === 0 ? {} : { visionApiKey }),
        visionBaseUrl: visionBaseUrl.length === 0 ? null : visionBaseUrl,
        whisperModelPath: whisperModelPath.length === 0 ? null : whisperModelPath,
        whisperCliPath: whisperCliPath.length === 0 ? null : whisperCliPath,
      });
      applySettings(next);
      // Key 只在当前输入控件中短暂存在，保存后立即清空，永不从 Host 回显。
      setDeepSeekApiKey('');
      setVisionApiKey('');
      setMessage('设置已保存，将从下一次任务开始生效。');
    } catch (error) {
      setHasError(true);
      setMessage(error instanceof Error ? error.message : '无法保存设置。');
    } finally {
      setIsSaving(false);
    }
  };

  const clearSecret = async (name: 'deepSeekApiKey' | 'visionApiKey') => {
    if (isProcessing || isSaving) return;
    setIsSaving(true);
    setMessage(null);
    setHasError(false);
    try {
      const next = await api.saveRuntimeSettings({ [name]: null });
      applySettings(next);
      setMessage('已清除本机保存的接口密钥。');
    } catch (error) {
      setHasError(true);
      setMessage(error instanceof Error ? error.message : '无法清除接口密钥。');
    } finally {
      setIsSaving(false);
    }
  };

  const disabled = isProcessing || isSaving;
  return (
    <dialog ref={dialog} className="settings-dialog" aria-label="运行时设置" onCancel={onClose} onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <nav className="settings-nav" aria-label="设置分区">
        <h1>设置</h1>
        {['deepseek', 'vision', 'whisper', 'ffmpeg'].map((id) => (
          <button key={id} type="button" aria-current={section === id ? 'location' : undefined}
            disabled={settings === null} onClick={() => {
              setSection(id);
              document.getElementById(`settings-${id}`)!.scrollIntoView({ block: 'start' });
            }}>
            {{ deepseek: '对话模型', vision: '视觉模型', whisper: '语音识别', ffmpeg: '视频处理' }[id]}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <div className="settings-topbar">
          <button type="button" className="icon-button settings-close" aria-label="关闭设置" onClick={onClose} autoFocus>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        <main className="settings-page" aria-label="设置">
          {settings === null ? (
            <p role={hasError ? 'alert' : 'status'} className={hasError ? 'settings-error' : undefined}>{message ?? '正在加载设置…'}</p>
          ) : (
            <div className="settings-content">
              <header className="settings-header">
                <p>运行时设置会在下一次任务开始时生效。</p>
              </header>

              <section className="settings-section" aria-labelledby="settings-deepseek">
                <h2 id="settings-deepseek">对话模型</h2>
                <label>
                  <span>接口密钥</span>
                  <input
                    type="password"
                    value={deepSeekApiKey}
                    disabled={disabled}
                    autoComplete="off"
                    placeholder="输入新密钥（不会回显已保存密钥）"
                    onChange={(event) => setDeepSeekApiKey(event.target.value)}
                  />
                </label>
                <div className="settings-secret-row">
                  <SecretStatus status={settings.deepSeek.apiKey} />
                  <button
                    type="button"
                    disabled={disabled || settings.deepSeek.apiKey.source !== 'saved'}
                    onClick={() => void clearSecret('deepSeekApiKey')}
                  >清除本机密钥</button>
                </div>
                <label><span>服务地址</span><input placeholder="留空时使用环境变量或服务默认值" value={deepSeekBaseUrl} disabled={disabled} onChange={(event) => setDeepSeekBaseUrl(event.target.value)} /></label>
                <label><span>模型名称</span><input placeholder="留空时使用环境变量或服务默认值" value={deepSeekModel} disabled={disabled} onChange={(event) => setDeepSeekModel(event.target.value)} /></label>
              </section>

              <section className="settings-section" aria-labelledby="settings-vision">
                <h2 id="settings-vision">视觉模型</h2>
                <label>
                  <span>接口密钥</span>
                  <input
                    type="password"
                    value={visionApiKey}
                    disabled={disabled}
                    autoComplete="off"
                    placeholder="输入新密钥（不会回显已保存密钥）"
                    onChange={(event) => setVisionApiKey(event.target.value)}
                  />
                </label>
                <div className="settings-secret-row">
                  <SecretStatus status={settings.vision.apiKey} />
                  <button
                    type="button"
                    disabled={disabled || settings.vision.apiKey.source !== 'saved'}
                    onClick={() => void clearSecret('visionApiKey')}
                  >清除本机密钥</button>
                </div>
                <label><span>服务地址</span><input placeholder="留空时使用环境变量或服务默认值" value={visionBaseUrl} disabled={disabled} onChange={(event) => setVisionBaseUrl(event.target.value)} /></label>
              </section>

              <section className="settings-section" aria-labelledby="settings-whisper">
                <h2 id="settings-whisper">语音识别</h2>
                <label><span>模型文件路径</span><input value={whisperModelPath} disabled={disabled} onChange={(event) => setWhisperModelPath(event.target.value)} /></label>
                <label><span>命令行路径</span><input value={whisperCliPath} disabled={disabled} onChange={(event) => setWhisperCliPath(event.target.value)} /></label>
              </section>

              <section className="settings-section" aria-labelledby="settings-ffmpeg">
                <h2 id="settings-ffmpeg">视频处理</h2>
                <p className="settings-readonly">通过系统环境变量查找视频处理程序</p>
              </section>

              {message !== null && <p className={`settings-message${hasError ? ' settings-error' : ''}`} role={hasError ? 'alert' : 'status'}>{message}</p>}
              <button className="settings-save" type="button" disabled={disabled} onClick={() => void save()}>
                {isSaving ? '正在保存…' : '保存设置'}
              </button>
            </div>
          )}
        </main>
      </div>
    </dialog>
  );
}
