# 本地数字人与声音克隆技术栈

更新时间：2026-08-30

## 当前主链路

```text
声音样本
  → FFmpeg 规范化为单声道 PCM WAV
  → 离线 Whisper 自动识别参考文本
  → GPT-SoVITS V3 建立音色并生成真实试听

人物视频
  → FFmpeg 转为 H.264 / yuv420p / 30fps
  → MuseTalk V1.5 检测人脸并建立可复用人物缓存

实际测算文本
  → 按当前声音语言生成内容并逐句切分
  → GPT-SoVITS V3 生成当前句 WAV
  → MuseTalk 使用同一 WAV 生成静音口型 MP4
  → OBS 舞台预加载口型视频
  → Windows 唯一音频总线开始播放 WAV
  → 播放当前句时并行准备下一句
```

## 组件职责

- **离线 ASR**：OpenAI Whisper Tiny，只读取本地模型，不依赖在线转写。
- **声音克隆与 TTS**：GPT-SoVITS V3，负责参考声音、语言和实际播报 WAV。
- **视频数字人**：MuseTalk V1.5，负责人物预处理和实际文案口型。
- **媒体处理**：内置 FFmpeg/FFprobe，负责音轨提取、浏览器兼容转码和媒体验收。
- **中控**：保存声音、人物、当前选择和任务快照，执行逐句预缓冲、错误恢复和唯一音频时钟。
- **共享舞台**：工作台与 OBS 使用同一场景渲染器；数字人视频始终静音。

## 可选人物方式

- `LOCAL_VIDEO`：当前主方案，上传人物视频后由 MuseTalk 驱动口型。
- `LOCAL_VRM`：保留的 3D 骨骼人物备用模式。
- `BAIDU_CLOUD`：国产云端手动备用，不在直播中自动换人或换声。

## 运行原则

- 只有真实试听 WAV 成功，声音才是 `READY`。
- 只有人物视频兼容处理和 MuseTalk 预处理成功，人物才是 `READY`。
- 克隆人物时只预处理和预览；实际口型在真实播报时生成。
- 口型视频不得包含音轨；声音只走 Windows/VB-CABLE。
- 当前任务不因后台修改而换人物或换声，新选择从下一条任务生效。
- 相同文案、人物、声音、速度和语言可命中缓存，禁止重复合成。

## 部署入口

- 安装离线 ASR：`scripts/install-voice-asr.ps1`
- 启动声音服务：`scripts/start-gptsovits.ps1`
- 启动完整系统：`scripts/start-production.ps1`
- 生成一体包：`scripts/package-bundle.ps1`
- OBS 地址：`http://127.0.0.1:5173/obs/source/meihua-stage`

本项目不使用虚拟摄像头、不拦截直播伴侣、不依赖蝉印商业二进制，也不把模拟接口成功当作真实口型完成。
