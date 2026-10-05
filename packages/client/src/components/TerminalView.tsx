import { useEffect, useRef, useState } from 'react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { AgentClientApi, TerminalSnapshot } from '../api.js';

/** 终端是会话资源，不属于某个已完成回复；xterm 只展示输出，模型输入仍走宿主审批。 */
export function TerminalView({ snapshot, api }: { readonly snapshot: TerminalSnapshot; readonly api: AgentClientApi }) {
  const container = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | undefined>(undefined);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(true);
  const output = useRef(snapshot.output);
  const renderedOutput = useRef('');
  output.current = snapshot.output;
  useEffect(() => {
    if (!expanded || container.current === null) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import('@xterm/xterm').then(({ Terminal }) => {
      if (disposed || container.current === null) return;
      const view = new Terminal({ disableStdin: true, fontSize: 12, rows: 14, cols: 80, scrollback: 1000,
        theme: { background: '#202320', foreground: '#edf1ed' } });
      view.open(container.current);
      terminal.current = view;
      view.write(output.current);
      renderedOutput.current = output.current;
      const observer = new ResizeObserver(([entry]) => {
        if (entry === undefined) return;
        const cols = Math.max(20, Math.min(300, Math.floor(entry.contentRect.width / 7.3)));
        view.resize(cols, 14);
        if (snapshot.status === 'running') void api.resizeTerminal(snapshot.terminalId, cols, 14).catch((failure: Error) => setError(failure.message));
      });
      observer.observe(container.current);
      cleanup = () => { observer.disconnect(); view.dispose(); terminal.current = undefined; renderedOutput.current = ''; };
    }).catch((failure: Error) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; cleanup?.(); };
  }, [api, snapshot.terminalId, snapshot.status, expanded]);
  useEffect(() => {
    const view = terminal.current;
    if (view === undefined) return;
    // 常规输出只追加增量，历史被截断后才重置，避免连续输出反复重放控制序列。
    if (snapshot.output.startsWith(renderedOutput.current)) view.write(snapshot.output.slice(renderedOutput.current.length));
    else { view.reset(); view.write(snapshot.output); }
    renderedOutput.current = snapshot.output;
  }, [snapshot.output, snapshot.terminalId, snapshot.status, expanded]);
  return <section className="session-terminal" aria-label="会话终端">
    <div className="terminal-heading">
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>终端</button>
      <span>{snapshot.status === 'running' ? '运行中' : snapshot.status === 'disconnected' ? '连接已结束' : `已退出 ${snapshot.exitCode ?? ''}`}</span>
      <code title={snapshot.workingDirectory}>{snapshot.workingDirectory}</code>
      {snapshot.status === 'running' && <button type="button" title="关闭终端" aria-label="关闭终端"
        onClick={() => void api.closeTerminal(snapshot.terminalId).catch((failure: Error) => setError(failure.message))}>×</button>}
    </div>
    {expanded && <div ref={container} className="terminal-screen" />}
    {snapshot.droppedBytes > 0 && <p>已省略 {snapshot.droppedBytes} 字节历史输出。</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
