import { useState } from 'react';
import type { QuestionAnswer, QuestionRequest } from '../api.js';

export function UserQuestion({ request, onAnswer }: {
  readonly request: QuestionRequest; readonly onAnswer: (answer: QuestionAnswer) => Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (value: QuestionAnswer) => {
    setBusy(true);
    try { await onAnswer(value); }
    catch (failure) { setError((failure as Error).message); setBusy(false); }
  };
  return <section className="user-question" aria-label="待回答问题">
    <strong>{request.question}</strong>
    {request.options !== undefined && <div className="question-options">{request.options.map((option) => (
      <label key={option}><input type="radio" name={request.requestId} checked={answer === option}
        disabled={busy} onChange={() => setAnswer(option)} />{option}</label>
    ))}</div>}
    <textarea aria-label="问题答复" value={answer} maxLength={4000} disabled={busy}
      onChange={(event) => setAnswer(event.target.value)} rows={2} />
    <div className="question-actions">
      <button type="button" disabled={busy} onClick={() => void submit({ outcome: 'skipped' })}>跳过</button>
      <button type="button" disabled={busy || !answer.trim()} onClick={() => void submit({ outcome: 'answered', answer })}>提交答复</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}
