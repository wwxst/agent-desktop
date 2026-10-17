import { useEffect, useState } from 'react';
import { AlertCircle, Download, LoaderCircle } from 'lucide-react';
import type { AppUpdateApi, AppUpdateState } from '../api.js';
import { ExtensionToast } from './ExtensionFeedback.js';

/** 导航栏只展示宿主更新事实；点击已就绪图标直接安装，不打开版本详情页。 */
export function AppUpdateButton({ api, isProcessing }: { readonly api: AppUpdateApi; readonly isProcessing: boolean }) {
  const [state, setState] = useState<AppUpdateState>({ status: 'idle' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let received = false;
    const unsubscribe = api.onStateChanged(next => { received = true; setState(next); setError(next.status === 'error' ? next.message : ''); });
    void api.getState().then(next => { if (active && !received) { setState(next); setError(next.status === 'error' ? next.message : ''); } }).catch(failure => {
      if (!(failure instanceof Error)) throw failure;
      if (active) setError(failure.message);
    });
    return () => { active = false; unsubscribe(); };
  }, [api]);

  const feedback = error === '' ? null : <ExtensionToast notice={{ variant: 'error', message: error }} onClose={() => setError('')} />;
  if (state.status === 'idle' || state.status === 'checking') return feedback;
  if (state.status === 'unavailable') return <p className="app-update-error unavailable" role="status">暂未提供在线更新</p>;
  const waiting = state.status === 'downloading' || state.status === 'installing';
  const label = state.status === 'error' ? '重试更新'
    : state.status === 'downloading' ? `正在下载更新 ${Math.round(state.percent)}%`
    : state.status === 'installing' ? '正在安装更新' : '安装更新';
  const message = error || (state.status === 'error' ? state.message : '');
  const run = async () => {
    setBusy(true); setError('');
    try { if (state.status === 'error') await api.retry(); else await api.install(); }
    catch (failure) { if (!(failure instanceof Error)) throw failure; setError(failure.message); }
    finally { setBusy(false); }
  };
  return <>
    <button type="button" className={`navigation-button app-update-button${state.status === 'error' ? ' failed' : ''}`}
      aria-label={label} title={message || (isProcessing ? '任务结束后可安装更新' : label)}
      disabled={waiting || busy || isProcessing} onClick={() => void run()}>
      {waiting ? <LoaderCircle className="app-update-spinner" size={18} /> : state.status === 'error' ? <AlertCircle size={18} /> : <Download size={18} />}
    </button>
    {feedback}
  </>;
}
