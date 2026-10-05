---
name: semantic-editing
description: 根据视频中的对白和画面剪辑讲解、去除广告或整理精彩片段时使用。
---

# 语义视频剪辑

1. 确认输入视频、用户希望保留或删除的内容，以及输出要求；无法确定时调用 ask_user。
2. 使用 probe_media 检查视频，必要时提取音频并调用 transcribe_audio 建立对白时间轴。
3. 需要判断画面时抽取相关区间的帧并调用 analyze_images，不仅凭对白判断画面。
4. 在写出前调用 declare_video_outputs，声明每个输出项和可验收要求。
5. 使用 trim_video 和 concat_videos 生成候选；有多个不连续片段时保留自然的语句边界。
6. 用 validate_video_candidate 验证可播放性、时长和黑屏；语义要求使用 check_video_semantics。
7. 只有所有要求通过后才使用 publish_video_output。无法确认的要求必须明确保留，不能声称已完成。

工具只在已注册时使用；缺少语音或视觉能力时说明缺口，继续完成其他有证据支持的工作。
