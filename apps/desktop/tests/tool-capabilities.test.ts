import { describe, expect, it } from 'vitest';
import type { Tool } from '@agent-desktop/tools';
import { collectToolCapabilities } from '../src/main/tool-capabilities.js';

function tool(name: string, capability?: string): Tool {
  return {
    name,
    description: name,
    inputSchema: {},
    ...(capability === undefined ? {} : { contract: { capability } }),
    execute: async () => ({ status: 'success', output: {} }),
  };
}

describe('tool capability exposure', () => {
  it('deduplicates registered contracts while retaining unknown legacy tools', () => {
    const vision = tool('analyze_images', 'vision');
    expect(collectToolCapabilities([
      vision,
      tool('probe_media', 'media'),
      tool('trim_video', 'media'),
      tool('publish_video_output'),
    ], vision, undefined)).toEqual(['vision', 'media', 'unknown']);
  });

  it('removes vision when the route is unavailable or the tool was not registered', () => {
    const vision = tool('analyze_images', 'vision');
    expect(collectToolCapabilities([vision, tool('read_file')], vision, '视觉模型不可用。'))
      .toEqual(['unknown']);
    expect(collectToolCapabilities([vision, tool('read_file')], undefined, undefined))
      .toEqual(['unknown']);
  });

  it('only reflects the already-filtered registry used by safe recovery', () => {
    const vision = tool('analyze_images', 'vision');
    expect(collectToolCapabilities([tool('read_file'), tool('verify_tool_outcome')], vision, undefined))
      .toEqual(['unknown']);
  });
});
