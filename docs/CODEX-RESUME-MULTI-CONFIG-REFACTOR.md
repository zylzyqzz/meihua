# 暂停任务：多配置 GPU 稳定化改造

恢复口令：**继续改造多配置任务**。

记录时间：2026-08-31

## 用户目标

一套完整安装包自动适配不同显卡；当前重点是 Ryzen 5 3600 + RTX 2060 SUPER 8GB，稳定运行声音克隆、MuseTalk 视频数字人、OBS 1080×1920/30fps 和中控，不要求用户理解 CUDA、Batch 或显存。

## 已确认根因

1. `scripts/start-musetalk-service.ps1` 以前只要检测到 CUDA 就设置 `MUSETALK_BATCH_SIZE=8`，对 8GB 显卡不安全。
2. MuseTalk 的渲染服务内部有串行锁，但 GPT-SoVITS 与 MuseTalk 没有共享 GPU 调度；分段预缓冲可能让后续 TTS 与当前口型渲染重叠。
3. GPT-SoVITS V3 的 `api_v3.py` 在启动时就把 SSL/BERT 模型放入 CUDA，且模型缓存没有在 TTS 完成后主动释放；这会让 MuseTalk 子进程启动时争抢显存。
4. GPT-SoVITS V3 没有 `/health` 接口，而中控检查的是 `/health`，会导致“fetch failed/验证失败”的假故障。
5. 当前一体包的启动、自检和工具入口不够傻瓜：PS1 会因系统关联打开记事本；自检对 Python stderr 过于严格；启动失败时 `.bat` 会秒关且不告诉用户原因。

## 本次已经写入、尚未测试的代码

- 新增 `apps/orchestrator/src/gpu-runtime.ts`：显存档位（CPU / 8GB / 12GB / 16GB）、环境变量导出、进程内 GPU FIFO 任务锁。
- `packages/adapters/src/index.ts`：GPT-SoVITS V3 适配器支持 TTS 后调用 `/runtime/release` 释放 CUDA；8GB 档可要求该调用必须成功。
- `apps/orchestrator/src/runtime.ts`：接入运行档位与 GPU 任务锁；已把部分声音测试、声音生成、人物预处理、MuseTalk 渲染放进同一队列；8GB档会要求GPT-SoVITS释放显存。

这些修改尚未执行 typecheck/build；恢复后必须优先编译并修正类型问题。

## 恢复后的实施顺序

1. 完成 `api_v3.py` 的受控改造：懒加载 CUDA 模型、`GET /health`、`POST /runtime/release`、单请求锁和释放缓存。
2. 完成 `runtime.ts` 的8GB预缓冲策略：`SAFE_8GB` 禁止在当前段播放时准备下一段；12GB/16GB按档位缓冲。
3. 调整 MuseTalk：按真实显存选 batch（8GB=1）、prep/render共用锁、健康接口显示显存/档位/队列、空闲显存不足时明确失败。
4. 调整桌面启动器、PowerShell启动器和一体包静默启动器，使三者继承同一硬件档位。
5. 修复一体包：全部用户入口为 `.bat`，PS1移入内部目录；启动失败写日志并显示可读错误；自检不因Python stderr中断；验证数据库和素材数量，打包后自动完整性验证。
6. 新增真实冒烟测试：声音生成WAV、3-5秒口型渲染、舞台加载、GPU显存/服务恢复。
7. 在 RTX 2060 SUPER 上跑30条任务与2小时稳定性验收，再生成新一体包。

## 一体包已知问题（必须一起修）

- 用户截图中的包缺少 `app/data/meihua-live.db` 和所有 `media/lux3d/audio/voices` 内容；新打包流程必须在压缩前检查数据库和四类素材均非空，压缩后抽样/完整测试。
- `安装工具`显示 `.ps1` 文件，双击会按 Windows 设置打开记事本。需要给用户只显示 `.bat` 入口。
- `2-启动系统.bat` 目前可能在桌面启动器报错后直接退出；需要异步启动、等待健康、失败弹出日志位置，不再秒关。
