import { ProbeMediaTool, DecodeVideoTool, DetectBlackSegmentsTool, ExtractVideoFramesTool,
  ExtractVideoRangeFramesTool, ExtractAudioTool, ExtractFullVideoFramesTool, ExtractVideoSegmentFramesTool, executeFileCommand,
  TrimVideoTool, ConcatVideosTool, AddAudioTool, AddSubtitlesTool, ResizeVideoTool, CropVideoTool, SetSpeedTool,
  type CommandExecutor } from '@agent-desktop/video-ffmpeg';

/** 服务执行与宿主按需注册共用同一份工具目录，避免复制名称、描述和参数契约。 */
export function ffmpegTools(execute: CommandExecutor = executeFileCommand) {
  return [new ProbeMediaTool(execute), new DecodeVideoTool(execute), new DetectBlackSegmentsTool(execute),
    new ExtractVideoFramesTool(execute), new ExtractVideoRangeFramesTool(execute), new ExtractAudioTool(execute), new ExtractFullVideoFramesTool(execute), new ExtractVideoSegmentFramesTool(execute),
    new TrimVideoTool(execute), new ConcatVideosTool(execute), new AddAudioTool(execute), new AddSubtitlesTool(execute),
    new ResizeVideoTool(execute), new CropVideoTool(execute), new SetSpeedTool(execute)];
}
