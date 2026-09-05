# 下载器第三方来源与改动边界

安装器只把梅花项目源码和必要的兼容覆盖文件保存在私有 Git 仓库中。模型权重、第三方运行时、生产数据库、API Key、OBS 推流密钥和用户素材均在目标电脑安装时下载或由用户配置。

| 组件 | 固定来源 | 本项目是否修改 | 安装方式 |
|---|---|---:|---|
| Kokoro ONNX | `thewh1teagle/kokoro-onnx` model-files-v1.0 | 否 | 从官方 Release 下载模型和 voices，校验 SHA-256 |
| Whisper Tiny | OpenAI 官方模型地址 | 否 | 下载单个模型，校验 SHA-256 |
| GPT-SoVITS | `RVC-Boss/GPT-SoVITS` 标签 `20250228v3` | 是 | 克隆官方标签，再覆盖 `overlays/gptsovits-v3` |
| MuseTalk | `TMElyralab/MuseTalk` 提交 `0a89dec45a0192b824e3cf4daf96c239440c5ed8` | 是 | 克隆官方提交，再覆盖 `overlays/musetalk` |
| OpenVoice V2 | `myshell-ai/OpenVoice` | 服务适配层在主项目中 | 克隆官方源码，安装 MeloTTS，下载官方 V2 checkpoints |
| Python 3.10 | Python Software Foundation | 否 | winget 或 Python 官方 3.10.11 x64 安装包 |
| FFmpeg | FFmpeg Windows builds（gyan.dev，备用 BtbN Release） | 否 | 下载 Windows x64 压缩包并配置到安装目录 |
| Microsoft VC++ Runtime | Microsoft | 否 | Microsoft 官方常青 x64 安装包 |
| OBS Studio | OBS Project | 否 | winget；无 winget 时使用 OBS 官方 GitHub Release |
| VB-CABLE | VB-Audio | 否 | 官方驱动包；安装时由 Windows 请求管理员确认 |
| TikFinity | TikFinity 官方分发 | 否 | 官方安装程序；账号登录由用户完成 |

## MuseTalk 覆盖层

- `musetalk/utils/preprocessing.py`：Windows 环境缺少完整 mmcv/mmpose 编译栈时的检测回退、空关键点处理与稳定性修复。
- `scripts/realtime_inference.py`：增加预处理模式、静音视频输出、CPU/GPU 精度选择，以及只在需要时加载大模型，保证与系统唯一 Audio Bus 配合。

## GPT-SoVITS 覆盖层

本地包与官方 V3 在 API、并发和运行环境方面存在多处配套改动，因此保留完整的轻量源码覆盖层，但排除所有模型、运行时、日志和缓存。关键入口包括：

- `api_v3.py`：UTF-8 日志、`/health`、CUDA 状态、异步合成与模型显存释放。
- `start_api.py`：梅花系统使用的稳定启动入口。
- `requirements.txt`：与现有声音克隆链路验证过的依赖版本。

覆盖层随附上游许可证副本。第三方模型仍应遵守各模型仓库自己的许可和用途限制。
