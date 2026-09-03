# Kokoro 本地英文女声

这是系统内置的英文预置音色服务，不需要 API Key，也不会把试听或正式播报偷偷降级成 Windows 原声。

- 默认音色：`af_heart`
- 备选音色：`af_bella`、`af_sarah`、`bf_emma`
- HTTP：`127.0.0.1:9890`
- 模型：`kokoro-v1.0.onnx`（CPU 兼容完整版；int8 版本保留为可选资产）
- 输出：写入主程序 `data/audio`，继续由现有 Audio Bus 播放

模型与音色文件来自 Kokoro ONNX 发布包；源码启动时执行 `scripts/start-kokoro-tts.ps1`，生产一键启动和 bundle 打包脚本也会自动带上该服务。
