import { useEffect, useState } from 'react';
import type { AgentClientApi, RuntimeSecretStatus, RuntimeSettings } from '../api.js';

interface RuntimeSettingsPanelProps {
  readonly api: AgentClientApi;
  readonly isProcessing: boolean;
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

export function RuntimeSettingsPanel({ api, isProcessing }: RuntimeSettingsPanelProps) {
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
      if (mounted) setMessage(error instanceof Error ? error.message : '无法加载设置。');
    });
    return () => { mounted = false; };
  }, [api]);

  const save = async () => {
    if (isProcessing || isSaving) return;
    setIsSaving(true);
    setMessage(null);
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
      setMessage(error instanceof Error ? error.message : '无法保存设置。');
    } finally {
      setIsSaving(false);
    }
  };

  const clearSecret = async (name: 'deepSeekApiKey' | 'visionApiKey') => {
    if (isProcessing || isSaving) return;
    setIsSaving(true);
    setMessage(null);
    try {
      const next = await api.saveRuntimeSettings({ [name]: null });
      applySettings(next);
      setMessage('已清除本机保存的 API Key。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法清除 API Key。');
    } finally {
      setIsSaving(false);
    }
  };

  if (settings === null) {
    return <main className="settings-page" aria-label="设置"><p>正在加载设置…</p></main>;
  }

  const disabled = isProcessing || isSaving;
  return (
    <main className="settings-page" aria-label="设置">
      <div className="settings-content">
        <header className="settings-header">
          <h1>设置</h1>
          <p>运行时设置会在下一次任务开始时生效。</p>
        </header>

        <section className="settings-section" aria-labelledby="settings-deepseek">
          <h2 id="settings-deepseek">DeepSeek</h2>
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={deepSeekApiKey}
              disabled={disabled}
              autoComplete="off"
              placeholder="输入新 Key（不会回显已保存 Key）"
              onChange={(event) => setDeepSeekApiKey(event.target.value)}
            />
          </label>
          <div className="settings-secret-row">
            <SecretStatus status={settings.deepSeek.apiKey} />
            <button
              type="button"
              disabled={disabled || settings.deepSeek.apiKey.source !== 'saved'}
              onClick={() => void clearSecret('deepSeekApiKey')}
            >清除本机 Key</button>
          </div>
          <label><span>Base URL</span><input placeholder="留空使用环境变量或 Provider 默认值" value={deepSeekBaseUrl} disabled={disabled} onChange={(event) => setDeepSeekBaseUrl(event.target.value)} /></label>
          <label><span>Model</span><input placeholder="留空使用环境变量或 Provider 默认值" value={deepSeekModel} disabled={disabled} onChange={(event) => setDeepSeekModel(event.target.value)} /></label>
        </section>

        <section className="settings-section" aria-labelledby="settings-vision">
          <h2 id="settings-vision">Vision</h2>
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={visionApiKey}
              disabled={disabled}
              autoComplete="off"
              placeholder="输入新 Key（不会回显已保存 Key）"
              onChange={(event) => setVisionApiKey(event.target.value)}
            />
          </label>
          <div className="settings-secret-row">
            <SecretStatus status={settings.vision.apiKey} />
            <button
              type="button"
              disabled={disabled || settings.vision.apiKey.source !== 'saved'}
              onClick={() => void clearSecret('visionApiKey')}
            >清除本机 Key</button>
          </div>
          <label><span>Base URL</span><input placeholder="留空使用环境变量或 Provider 默认值" value={visionBaseUrl} disabled={disabled} onChange={(event) => setVisionBaseUrl(event.target.value)} /></label>
        </section>

        <section className="settings-section" aria-labelledby="settings-whisper">
          <h2 id="settings-whisper">Whisper</h2>
          <label><span>Model Path</span><input value={whisperModelPath} disabled={disabled} onChange={(event) => setWhisperModelPath(event.target.value)} /></label>
          <label><span>CLI Path</span><input value={whisperCliPath} disabled={disabled} onChange={(event) => setWhisperCliPath(event.target.value)} /></label>
        </section>

        <section className="settings-section" aria-labelledby="settings-ffmpeg">
          <h2 id="settings-ffmpeg">FFmpeg</h2>
          <p className="settings-readonly">使用系统 PATH</p>
        </section>

        {message !== null && <p className="settings-message" role="status">{message}</p>}
        <button className="settings-save" type="button" disabled={disabled} onClick={() => void save()}>
          {isSaving ? '正在保存…' : '保存设置'}
        </button>
      </div>
    </main>
  );
}
