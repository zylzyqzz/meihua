# 梅花直播中控系统 V2.0

这是一个面向 Windows 直播机的事件驱动直播中控。OBS 只负责最终构图；本系统负责直播场次、TikFinity 事件、资格与队列、梅花易数排盘、统一导演 Cue、可选分句字幕、媒体数字人阶段动作、TTS 音频、本场榜单和所有独立浏览器来源的同步。

后台操作界面固定为中文；TikTok/OBS 输出内容语言可配置为英文、中文及其他已支持语言。

## 核心链路

```text
TikFinity / 本地演练事件
  → 字段标准化、幂等、黑名单、本场统计
  → 礼物 / 点赞 / 评论 / 人工资格
  → 统一队列与过期规则
  → LiveSession + DirectorCue 服务端时间轴
  → 梅花排盘 + SpeechPlan + 真实 WAV
  → 后端播放 WAV + 人物阶段动作 / 可选字幕 / 卦象 / 当前观众 / 榜单 / 特效
  → OBS 独立分层合成
```

所有正式来源订阅同一个 `BroadcastSnapshotV2` 和递增 Cue 序号。新打开或重连的来源先恢复完整快照，再接收增量消息。后台同源预览和正式 OBS 来源复用同一套 React 渲染组件，不再使用硬编码 `?preview=1` 样例。

## 启动

要求 Windows、Node.js 22.5+、pnpm 11+。

```powershell
pnpm install
pnpm verify:offline
pnpm start:live
```

只做本机启动检查：

```powershell
.\scripts\start-live.ps1 -PreflightOnly
```

地址：

- 中控后台：`http://127.0.0.1:5200/`
- **正式直播舞台（V2.2 默认，单条入 OBS）：`http://127.0.0.1:5173/obs/source/meihua-stage`（1080×1920）**
- 排练参考画面：`http://127.0.0.1:5173/obs/source/full-preview`（仅排练，不作为正式画面）
- OBS 来源中心：`http://127.0.0.1:5173/modules`
- 中控 API：`http://127.0.0.1:3210`

启动服务不等于开始直播。必须在中控“直播导演台”通过预检并点击“开始直播”，系统才会创建并锁定一个 `LiveSession`。

## V2 正式 OBS 来源

正式地址统一为 `http://127.0.0.1:5173/obs/source/:sourceId`：

| sourceId | 作用 | 推荐尺寸 |
|---|---:|---|
| `meihua-stage` | **正式一体化直播舞台（默认推荐）**：背景、人物区域、当前观众、问题、卦象、三态队列、礼物反馈与免责声明整屏联动；转场全部由导演 Cue 驱动 | **1080 × 1920** |
| `avatar` | 媒体数字人动作 | 720 × 1280 |
| `background` | 图片/循环视频背景 | 1080 × 1920 |
| `current-viewer` | 当前观众、问题、资格与时长 | 900 × 220 |
| `hexagram` | 本卦、互卦、变卦和动爻 | 1040 × 560 |
| `subtitles` | 可选分句字幕 | 900 × 180 |
| `queue` | 下一位和等待队列 | 520 × 500 |
| `gift-alert` | 礼物到账、权益和插队结果 | 760 × 180 |
| `gift-ranking` | 本场礼物榜 | 520 × 560 |
| `engagement-ranking` | 本场互动榜 | 520 × 560 |
| `status` | 导演阶段状态 | 900 × 120 |
| `effects` | 独立透明特效层 | 1080 × 1920 |
| `disclaimer` | 免责声明 | 900 × 60 |
| `audio` | 旧版兼容地址，正式场景默认关闭 | 160 × 80 |

旧 `/module/*` 地址继续兼容。正式语音由生产后端直接播放到 Windows 默认输出设备，OBS 不添加 `audio`；人物和背景视频始终静音。详见 [OBS-SOURCES-V2.md](docs/OBS-SOURCES-V2.md)。

## 本地完整能力

- 直播场次开始、暂停接入、恢复、正常收播、立即中止及重启恢复。
- 持久化 Director Cue、服务端时间、序号、主轨与礼物并行轨。
- TikFinity 评论、点赞、普通礼物和连击终帧适配；真实事件到达前不会显示“实播验证完成”。
- 礼物限时权益、排队后提权、独立测算时长、礼物榜积分。
- 点赞阈值资格、评论包含/精确/正则规则、免费队列自动过期。
- 确定性梅花时间数字起卦，本卦、互卦、变卦、动爻和排盘证据持久化；V2.2 起默认由权威引擎 mingyu-core（邵雍《梅花易数》通行本，MIT）排盘，已通过 40 个固定样本双算比对，旧引擎保留回滚开关。
- 真实 Windows WAV 和后端唯一播放路径；可选字幕按实测 WAV 时长分配，人物只切换阶段动作。
- 透明 WebM、绿幕 MP4、PNG/WebP 静态回退动作素材；舞台人物槽位支持外部视频流嵌入（供应商待接入）。
- 场景草稿、发布版本、直播样式锁定、历史恢复、素材哈希去重和引用保护。
- 同源预览会话、内容模板、颜色、透明度、亮度、辉光、动画和空闲行为。
- SQLite V2 幂等迁移及首次迁移前 `.pre-v2.bak` 备份。
- 审计日志、场次报告、榜单、本地回放和故障降级。

## 验证命令

```powershell
pnpm typecheck
pnpm test
pnpm build
```

中控已经收口为“开播、简单设置、OBS 画面、接口、记录”五个入口。操作者只设置点赞次数、免费排队分钟数、评论词、礼物名称和时长、显示文字、字体与颜色；内部优先级、连击终帧、资格、排盘、语速、字幕、卦象焦点和人物动作不再暴露为人工参数。

当前内部自动化为 117 项，类型检查和生产构建均通过。自动化或浏览器通过不代表 OBS 或真实 TikTok 直播通过；分级状态见 [V2.2-IMPLEMENTATION-STATUS.md](docs/V2.2-IMPLEMENTATION-STATUS.md)、[V2.1-IMPLEMENTATION-STATUS.md](docs/V2.1-IMPLEMENTATION-STATUS.md) 和 [ACCEPTANCE-REPORT-V2.md](docs/ACCEPTANCE-REPORT-V2.md)。

## 外部边界

- VTube Studio、Warudo、外部 LLM 和外部 TTS 仅保留清晰适配契约，未计入本次完成率。
- 本机当前未安装 OBS Studio 和 TikFinity Desktop，因此 `OBS_VERIFIED` 与 `LIVE_VERIFIED` 仍为 `BLOCKED_EXTERNAL`。
- 真实上线前必须完成 OBS 连续录制和 TikFinity 五类事件验收，不得以本地 Mock 代替。

操作、验收与恢复文档：

- [中控操作手册](docs/OPERATOR-MANUAL-V2.md)
- [开播与验收报告](docs/ACCEPTANCE-REPORT-V2.md)
- [已知限制和故障恢复](docs/KNOWN-LIMITATIONS-V2.md)
