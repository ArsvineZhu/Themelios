# @themelios/media

为 Themelios 注册基于 FFmpeg 的媒体配方。FFmpeg 和 ffprobe 可从 PATH 发现，也可由应用指定路径。

```ts
import { createMediaAdapters } from "@themelios/media";
import { createPreparation } from "@themelios/models";

const preparation = createPreparation({ adapters: createMediaAdapters() });
```

- `media.audio` 从音频或视频提取 PCM WAV，可以交给转写模型。
- `video.clip` 将选定视频片段编码为 MP4。FFmpeg 需提供 H.264 和 AAC 编码器。
- `video.frame` 提取选区内第一张可解码画面，返回 PNG 和该画面在原件中的时刻。可调 `maxWidth` 和 `maxHeight`。

时间选区使用毫秒半开区间。来源记录保留原件时长、请求选区和交付部件的范围及实际尺度。编码后的片段时长由 ffprobe 读取，会随帧率和封装变化。音视频处理在本机执行，模型收到准备好的交付部件。
