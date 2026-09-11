import { describe, expect, it } from 'vitest';
import { DeepSeekModel } from '@agent-desktop/model-deepseek';
import { InMemorySession, type Session } from '@agent-desktop/session';
import { createVideoAgent } from '../src/index.js';

describe('createVideoAgent', () => {
  it('assembles the formal video Agent dependencies and tools', () => {
    const agent = createVideoAgent({
      deepSeekApiKey: 'test-deepseek-key',
      deepSeekBaseUrl: 'https://deepseek.test',
      whisperModelPath: 'ggml-small.bin',
      whisperCliPath: 'whisper-cli',
      visionApiKey: 'test-vision-key',
      visionBaseUrl: 'https://vision.test/v1',
    });

    expect(agent.model).toBeInstanceOf(DeepSeekModel);
    expect(agent.session).toBeInstanceOf(InMemorySession);
    expect(agent.tools.list().map((tool) => tool.name)).toEqual([
      'probe_media',
      'extract_video_frames',
      'extract_video_range_frames',
      'extract_audio',
      'analyze_images',
      'transcribe_audio',
      'trim_video',
      'concat_videos',
      'add_audio',
      'add_subtitles',
      'resize_video',
      'crop_video',
      'set_speed',
    ]);

    const systemPrompt = agent.systemPrompt.build();
    expect(systemPrompt).toContain('优先使用 extract_audio 和 transcribe_audio');
    expect(systemPrompt).toContain('多个不连续保留区间应分别从原视频裁剪');
    expect(systemPrompt).toContain('如果用户提供多个输入视频');
    expect(systemPrompt).toContain('固定秒数裁剪可以直接使用 trim_video');
  });

  it('can assemble a text-only Agent without registering media transcription', () => {
    const agent = createVideoAgent({
      deepSeekApiKey: 'test-deepseek-key',
      visionApiKey: '',
    });

    expect(agent.tools.list().map((tool) => tool.name)).not.toContain('transcribe_audio');
  });

  it('uses an injected Session and keeps the default InMemorySession behavior', () => {
    const injectedSession: Session = {
      append: () => undefined,
      events: () => [],
    };
    const restoredAgent = createVideoAgent({
      deepSeekApiKey: 'test-deepseek-key',
      visionApiKey: '',
      session: injectedSession,
    });
    const newAgent = createVideoAgent({
      deepSeekApiKey: 'test-deepseek-key',
      visionApiKey: '',
    });

    expect(restoredAgent.session).toBe(injectedSession);
    expect(newAgent.session).toBeInstanceOf(InMemorySession);
  });
});
