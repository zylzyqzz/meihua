# 梅花直播系统完整一体包

发行物只有一个 `MeihuaStudio` 目录，不分开发版和正式版。它同时包含中控、工作台、OBS舞台、素材、GPT‑SoVITS声音克隆、离线ASR、MuseTalk数字人、模型、Python、Node、FFmpeg、TikFinity、官方依赖安装器和全链路源码。

## 生成完整包

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-bundle.ps1 `
  -ProjectRoot E:\meihua\meihua-live `
  -GptSoVitsRoot E:\meihua\V3音色包 `
  -MuseTalkRoot E:\meihua\MuseTalk `
  -OutRoot E:\meihua\bundle
```

输出：`E:\meihua\bundle\MeihuaStudio`

打包过程会重新构建项目，安全导出当前SQLite数据库，保留 `media/lux3d/audio/voices` 全部素材，整理GPT‑SoVITS和MuseTalk源码，并排除 `node_modules`、旧备份、日志、缓存、测试截图和临时文件。

## 解压后的操作顺序

1. 打开 `0-请先看这里.md`。
2. 双击 `1-环境检查与安装.bat`。工具会检测整包、NVIDIA驱动、CUDA、OBS、VB‑CABLE、TikFinity和端口，并提供缺失项安装入口。
3. 安装VB‑CABLE或显卡驱动后重启Windows。
4. 双击 `2-启动系统.bat`。
5. 按 `3-操作攻略.md` 配置声音、数字人、队列和画面。
6. 按 `4-TikFinity图文攻略.md` 连接真实直播间。
7. OBS添加 `http://127.0.0.1:5173/obs/source/meihua-stage`，设置1080×1920、30fps。

## 包内组成

- `app/`：中控生产程序、前端、配置、当前数据库及全部素材。
- `desktop/`：梅花中控桌面客户端。
- `gptsovits/`：GPT‑SoVITS源码、Python运行时、ASR和完整模型。
- `musetalk/`：MuseTalk源码、Python依赖和完整模型。
- `runtime/`：便携Node.js。
- `tikfinity/`：已安装的TikFinity桌面程序。
- `installers/`：OBS和VB‑CABLE官方离线安装器及SHA256。
- `5-源码/`：中控、声音克隆、数字人、脚本、配置、当前数据库和素材的干净源码副本。
- `安装工具/`：环境助手和整包自检工具。

## 自动运行方式

- 检测到可用NVIDIA CUDA时自动使用GPU。
- 没有CUDA时可使用CPU完成流程验证，但声音和口型生成明显更慢。
- 不需要单独安装Node、Python、FFmpeg、Whisper、GPT‑SoVITS或MuseTalk依赖。
- OBS和VB‑CABLE属于系统级组件，由环境助手从包内官方安装器安装。
- NVIDIA驱动必须匹配显卡和Windows版本，环境助手只引导安装官方Studio Driver，不会静默安装错误驱动。

## 固定端口

- 3210：中控API
- 5173：OBS舞台
- 5200：后台
- 9881：GPT‑SoVITS
- 9898：MuseTalk
- 9899：本地 CUDA OpenVoice 目标口音服务
- 21213：TikFinity本地事件WebSocket

推荐投产基线：Windows 11、i5‑12400F、RTX 3060 12GB、32GB内存和1TB NVMe。正式使用前仍要完成真实TikFinity事件、OBS录制、30条连续测算和2小时稳定性验收。
