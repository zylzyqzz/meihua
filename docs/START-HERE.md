# 0｜请先看这里

这是梅花直播系统完整一体包。中控、OBS 正式画面、本地 Kokoro 英文女声、GPT-SoVITS、MuseTalk、模型、Python、Node、FFmpeg、TikFinity 与源码均随包归档。

## 推荐：首次只双击一个文件

双击根目录：

```text
0-一键检测安装并启动.bat
```

它会严格按顺序完成：

1. 检查整包文件、模型、安装包校验值、磁盘空间和写入权限。
2. 检查并补齐 OBS、VB-CABLE、TikFinity 等 Windows 环境。
3. 读取当前生产配置，只启动当前声音与画面模式真正需要的服务。
4. 验证中控 API、管理端、OBS 正式画面和当前声音服务。
5. 验收通过后打开 `http://127.0.0.1:5200/`。

脚本可以重复运行。已健康运行的服务会直接复用，不会重复启动；端口被其他程序占用时不会强制结束对方，而会明确报告进程和端口。

## 日常启动

以后双击：

```text
2-启动系统.bat
```

当前默认的 `Kokoro + VIDEO_ONCE` 链路只启动中控和 Kokoro。预录视频模式不再等待 MuseTalk；未选择声音克隆时不再强制启动 GPT-SoVITS。这样可以减少启动时间、内存占用和模型争抢。

如需分步排障，仍可使用：

- `1-环境检查与安装.bat`：只检查和补齐 Windows 环境。
- `安装工具\01-检查整包.bat`：只检查一体包完整性。
- `安装工具\03-一键检测安装并启动.bat`：与根目录统一入口相同。

## 自动生成的报告

所有报告和日志在 `logs/`：

- `last-environment-report.json`：环境、驱动、OBS、VB-CABLE、TikFinity、端口和磁盘状态。
- `last-start-report.json`：本次实际复用/启动的服务、当前模式、预检和错误原因。
- `bootstrap.log`：一键流程总日志。
- `launcher.log`：每次启动过程日志。
- `*.err.log`：具体服务错误日志。

## OBS

OBS 只添加一个浏览器源：

```text
http://127.0.0.1:5173/obs/source/meihua-stage
宽 1080，高 1920，30fps
```

声音统一从 VB-CABLE 音频总线进入。预录视频始终静音。

## 能力分级

- 当前生产链路必需：中控、管理端、OBS 正式画面、当前选中的声音服务、当前选中的画面模式。
- 直播数据必需：TikFinity 已登录并连接目标直播间。
- OBS 实际推流必需：OBS 与 VB-CABLE。
- 可选能力：GPT-SoVITS 声音克隆、MuseTalk 实时数字人、OpenVoice 目标口音。未被当前配置选中时，它们不阻断系统启动。
- NVIDIA/CUDA：预录视频与 Kokoro CPU 模式可运行；实时 MuseTalk 和 CUDA 口音能力仍需适配的 NVIDIA 驱动、CUDA 与模型。

首次安装 VB-CABLE 后通常需要重启 Windows，再重新运行统一入口。
