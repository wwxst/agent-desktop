import type { AgentTaskOutputItemResult } from '../api.js';

/** 逐项状态的界面文案；它只翻译宿主给出的真实结论，不重新判断质量。 */
const STATUS_LABELS: Record<AgentTaskOutputItemResult['status'], string> = {
  published: '已交付',
  failed: '未通过',
  blocked: '无法确认',
  incomplete: '未完成',
};

interface OutputResultsProps {
  readonly results: readonly AgentTaskOutputItemResult[];
}

/**
 * 逐项交付结果：按声明集合展示已交付项和未交付原因。
 *
 * 已交付文件的打开动作由产物卡承担，这里只展示状态与缺口，避免同一轮出现两套打开入口。
 */
export function OutputResults({ results }: OutputResultsProps) {
  const publishedCount = results.filter((result) => result.status === 'published').length;

  return (
    <section className="output-results" aria-label="交付结果">
      <p className="output-results-summary">交付结果 {publishedCount}/{results.length}</p>
      <ul className="output-results-list">
        {results.map((result, index) => (
          <li
            key={result.outputItemId}
            className={`output-result-row output-result-${result.status}`}
          >
            <div className="output-result-head">
              <span className="output-result-name">
                {result.status === 'published' ? result.fileName : `输出项 ${index + 1}`}
              </span>
              <span className="output-result-status">{STATUS_LABELS[result.status]}</span>
            </div>
            {result.status !== 'published' && (
              <p className="output-result-reason">{result.reason}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
