import { describe, expect, it } from 'vitest';
import { assertTurnToolNames, parseTurnConfiguration } from '../src/main/turn-configuration.js';

const settings = {
  modelProviders: [{
    id: 'test-provider', displayName: 'Test Provider', baseUrl: 'https://models.test/v1', protocol: 'chat-completions',
    models: [{ id: 'test-model', displayName: 'Test Model', capabilities: {
      textInput: 'supported', textOutput: 'supported', imageInput: 'unsupported', imageUnderstanding: 'unsupported',
    } }],
  }],
  conversationModel: { providerId: 'test-provider', modelId: 'test-model' },
  fallbackVisionModel: null,
  fallbackVisionEnabled: false,
};

function configuration(toolNames?: readonly string[]) {
  return parseTurnConfiguration({ settings, permissionMode: 'ask', executionBoundary: 'host-policy',
    ...(toolNames === undefined ? {} : { toolNames }) });
}

describe('turn capability snapshots', () => {
  it('rejects recovery when the source turn has no tool snapshot', () => {
    expect(() => assertTurnToolNames(configuration(), ['read_file'], false)).toThrow('缺少工具集合快照');
  });

  it('requires an exact tool set for ordinary recovery', () => {
    const source = configuration(['read_file', 'update_plan']);
    expect(() => assertTurnToolNames(source, ['update_plan', 'read_file'], false)).not.toThrow();
    expect(() => assertTurnToolNames(source, ['read_file'], false)).toThrow('工具能力集合已变化');
    expect(() => assertTurnToolNames(source, ['read_file', 'update_plan', 'search_text'], false)).toThrow('工具能力集合已变化');
  });

  it('allows only a safe subset while unknown external effects are being verified', () => {
    const source = configuration(['read_file', 'update_plan', 'publish_video_output']);
    expect(() => assertTurnToolNames(source, ['read_file', 'update_plan'], true)).not.toThrow();
    expect(() => assertTurnToolNames(source, ['read_file', 'unknown_tool'], true)).toThrow('工具能力集合已变化');
  });

  it('rejects malformed or duplicate tool snapshots at the persistence boundary', () => {
    expect(() => parseTurnConfiguration({ settings, permissionMode: 'ask', executionBoundary: 'host-policy', toolNames: ['read_file', 'read_file'] }))
      .toThrow('工具集合快照无效');
    expect(() => parseTurnConfiguration({ settings, permissionMode: 'ask', executionBoundary: 'host-policy', toolNames: [''] }))
      .toThrow('工具集合快照无效');
  });
});
