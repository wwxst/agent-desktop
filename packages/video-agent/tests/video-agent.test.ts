import { describe, expect, it } from 'vitest';
import { DeepSeekModel } from '@agent-desktop/model-deepseek';
import { InMemorySession, type Session } from '@agent-desktop/session';
import { ProbeMediaTool } from '@agent-desktop/video-ffmpeg';
import { createVideoAgent } from '../src/index.js';

describe('createVideoAgent', () => {
  it('registers the injected Probe instance and preserves other video capabilities when absent', () => {
    const probe = { name: 'probe_media', description: '', inputSchema: {}, execute: async () => ({ status: 'success' as const, output: {} }) };
    expect(createVideoAgent({ deepSeekApiKey: 'fixture', probeMedia: probe }).tools.list().find(tool => tool.name === 'probe_media')).toBe(probe);
    const names = createVideoAgent({ deepSeekApiKey: 'fixture' }).tools.list().map(tool => tool.name);
    expect(names).not.toContain('probe_media');
    for (const name of ['trim_video', 'decode_video', 'extract_audio', 'validate_video_candidate', 'publish_video_output', 'check_video_semantics']) expect(names).toContain(name);
  });
  it('assembles the formal video Agent dependencies and tools', () => {
    const agent = createVideoAgent({
      deepSeekApiKey: 'test-deepseek-key',
      probeMedia: new ProbeMediaTool(),
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
      'decode_video',
      'detect_black_segments',
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
      'declare_video_outputs',
      'validate_video_candidate',
      'publish_video_output',
      'check_video_semantics',
    ]);

    const systemPrompt = agent.systemPrompt.build();
    // 通用客户端规则：普通问答直接回答、只用真实注册的能力。
    expect(systemPrompt).toContain('你是一个通用智能体');
    expect(systemPrompt).toContain('不需要为了回答调用 Tool');
    expect(systemPrompt).toContain('某个能力当前没有注册对应 Tool 时，直接说明缺少什么能力');
    // 视频规则：已经真实剪辑验证过的行为保持不变。
    expect(systemPrompt).toContain('优先使用 extract_audio 和 transcribe_audio');
    expect(systemPrompt).toContain('多个不连续保留区间应分别从原视频裁剪');
    expect(systemPrompt).toContain('如果用户提供多个输入视频');
    expect(systemPrompt).toContain('固定秒数裁剪可以直接使用 trim_video');
    expect(systemPrompt).toContain('明确要求不要黑帧');
    expect(systemPrompt).toContain('detect_black_segments');
    expect(systemPrompt).toContain('不能声称已避免黑帧');
    // 交付流程：声明 → 候选 → 真实验收 → 发布，缺一步都不算交付。
    expect(systemPrompt).toContain('declare_video_outputs');
    expect(systemPrompt).toContain('validate_video_candidate');
    expect(systemPrompt).toContain('publish_video_output');
    expect(systemPrompt).toContain('所有视频写出 Tool 的 outputPath 都必须写在该目录内');
    expect(systemPrompt).toContain('只有 validate_video_candidate 返回的检查全部通过时');
    expect(systemPrompt).toContain('start、duration、保留区间、拼接顺序、输出路径和编码等是生成候选时的操作参数');
    expect(systemPrompt).toContain('不要把它们转换成 semantic');
    expect(systemPrompt).toContain('只有用户明确提出成片必须包含或排除某种画面、内容或语义时，才声明 semantic');
  });

  it('scopes the write rules to tasks that actually ask for a file', () => {
    const agent = createVideoAgent({ deepSeekApiKey: 'test-deepseek-key' });
    const systemPrompt = agent.systemPrompt.build();

    // 写文件规则只在用户确实要求产出文件时成立；
    // 否则普通问答、读取和搜索会被迫生成多余文件。
    expect(systemPrompt).toContain('只有在用户确实要求产出文件时才写文件');
    expect(systemPrompt).not.toContain('最后一个 Tool 必须写入提示中给出的最终 outputPath');
  });

  it('can assemble a text-only Agent without registering media transcription', () => {
    const agent = createVideoAgent({
      deepSeekApiKey: 'test-deepseek-key',
      visionApiKey: '',
    });

    expect(agent.tools.list().map((tool) => tool.name)).not.toContain('transcribe_audio');
    expect(agent.tools.list().map((tool) => tool.name)).not.toContain('analyze_images');
  });

  it('registers the local tools only when the host provides a workspace port', () => {
    const localTools = [
      'set_working_directory',
      'list_directory',
      'read_file',
      'search_text',
      'write_text_file',
      'edit_text_file',
    ];
    const withoutWorkspace = createVideoAgent({ deepSeekApiKey: 'test-deepseek-key' });
    // 没有宿主目录确认能力时不能注册这些工具：目录工具没有合法的范围来源，也没有审批消费者。
    for (const name of localTools) {
      expect(withoutWorkspace.tools.list().map((tool) => tool.name)).not.toContain(name);
    }

    const withWorkspace = createVideoAgent({
      deepSeekApiKey: 'test-deepseek-key',
      workspace: {
        confirmedDirectory: () => undefined,
        requestApproval: async () => true,
        confirmDirectory: () => undefined,
      },
    });
    for (const name of localTools) {
      expect(withWorkspace.tools.list().map((tool) => tool.name)).toContain(name);
    }
  });

  it('passes the configured model override to DeepSeek', async () => {
    const requests: unknown[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(init?.body as string) as unknown);
      // DeepSeek Provider 始终请求 SSE 流；这里返回最小合法流（含终止 finish_reason）以读取模型覆盖配置。
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      );
    };
    try {
      const agent = createVideoAgent({
        deepSeekApiKey: 'test-key',
        deepSeekModel: 'runtime-model',
      });
      await agent.model.complete({ systemPrompt: 'test', messages: [], tools: [] });
      expect(requests).toEqual([expect.objectContaining({ model: 'runtime-model' })]);
    } finally {
      globalThis.fetch = previousFetch;
    }
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
