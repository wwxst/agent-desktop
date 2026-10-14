// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskPlan } from '../src/components/TaskPlan.js';

describe('TaskPlan', () => {
  it('shows projected statuses and evidence without adding controls', () => {
    render(<TaskPlan taskState={{
      rootTurnId: 'turn-1', latestTurnId: 'turn-1', status: 'completed',
      plan: { revision: 2, explanation: '先读取再回复', steps: [
        { id: 'read', description: '读取文件', status: 'completed', completionKind: 'tool', evidenceLabels: ['文件已读取'] },
        { id: 'reply', description: '生成回复', status: 'completed', completionKind: 'response', evidenceLabels: [] },
        { id: 'blocked', description: '确认外部结果', status: 'blocked', completionKind: 'tool', evidenceLabels: ['工具已返回，业务结果未确认'] },
      ] },
    }} />);
    expect(screen.getByRole('region', { name: '任务计划' })).toBeTruthy();
    expect(screen.getByText('文件已读取')).toBeTruthy();
    expect(screen.getByText('文本回复已生成')).toBeTruthy();
    expect(screen.getByText('待确认')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
