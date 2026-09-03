# V2.0 功能状态矩阵

更新时间：2026-08-23

状态定义：

- `CODED`：代码已实现。
- `AUTOMATED_VERIFIED`：自动化测试通过。
- `BROWSER_VERIFIED`：真实浏览器交互通过。
- `OBS_VERIFIED`：OBS 实机录制通过。
- `LIVE_VERIFIED`：真实 TikFinity/直播间事件通过。
- `BLOCKED_EXTERNAL`：因本机缺少外部软件、账号或素材无法继续实机验收。
- `RESERVED`：只保留适配契约，不是已实现能力。

## 内部系统

| 能力 | 代码 | 自动化 | 浏览器 | 说明 |
|---|---|---|---|---|
| LiveSession 开始/暂停/恢复/结束/中止 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 开播锁定已发布场景版本 |
| 程序重启恢复未结束场次 | CODED | AUTOMATED_VERIFIED | — | 恢复为 PAUSED，需人工确认后继续 |
| DirectorCue 主轨、并行礼物轨、递增序号 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | Cue 持久化并在后台展示 |
| V2 快照、心跳、晚加入与断线恢复 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 正式来源与预览来源分离 |
| 礼物权益、插队、时长、连击终帧幂等 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | TikFinity 真实字段仍待 LIVE 验证 |
| 礼物队列永久等待 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 礼物绑定后清除免费过期时间；人工移除或处理完成前保留 |
| 点赞阈值资格 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 本场按用户累计 |
| 评论包含/精确/正则资格 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 与礼物、点赞共用队列 |
| 免费排队超时取消 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 默认 20 分钟，可配置 |
| 本场礼物榜与互动榜 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 分榜输出，不与队列混用 |
| 确定性梅花排盘 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 本卦、互卦、变卦、动爻和证据持久化 |
| SpeechPlan 分句和 WAV 时长分配 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 每句不少于 900ms |
| Windows 真实 WAV | CODED | AUTOMATED_VERIFIED | — | 自动化生成并校验真实 WAV；失败不使用伪造时长 |
| 音频播放开始/暂停/结束/失败审计 | CODED | AUTOMATED_VERIFIED | — | API 契约已验证；正式 OBS 播放仍待实机 |
| 音频主时钟回写和 Cue 重定位 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 音频真实开始后统一校准字幕、卦象焦点和人物动作 |
| 媒体数字人动作槽位与回退 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 配置界面已验；最终素材动作观感待外部素材 |
| 素材 MIME/扩展名/文件头校验和哈希去重 | CODED | AUTOMATED_VERIFIED | — | 被版本引用的素材禁止删除；浏览器上传未单独验收 |
| 场景草稿、发布、恢复与直播锁定 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 发布后自动创建下一版草稿 |
| 同源编辑预览会话 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 不污染正式状态，不使用硬编码样例 URL |
| 自定义标题、空闲文案、内容模板和样式 | CODED | — | BROWSER_VERIFIED | 模板支持来源变量；IDLE 已验证与正式来源一致 |
| 五入口傻瓜式中控 | CODED | — | BROWSER_VERIFIED | 仅保留必要业务数值、内容、字体颜色、OBS 来源与接口 |
| V2 SQLite 迁移和迁移前备份 | CODED | AUTOMATED_VERIFIED | — | 迁移/恢复有自动化；备份文件已在本机实际生成 |
| 旧 `/module/*` 来源兼容 | CODED | AUTOMATED_VERIFIED | BROWSER_VERIFIED | 新配置应迁移到 `/obs/source/*` |

## 外部系统

| 能力 | 当前状态 | 结论 |
|---|---|---|
| OBS 独立来源实机录制 | BLOCKED_EXTERNAL | 本机未安装 OBS Studio，不能写 `OBS_VERIFIED` |
| TikFinity 真实评论 | BLOCKED_EXTERNAL | 本机未安装/运行 TikFinity Desktop |
| TikFinity 真实点赞 | BLOCKED_EXTERNAL | 同上 |
| TikFinity 普通礼物 | BLOCKED_EXTERNAL | 同上 |
| TikFinity 连击最终帧 | BLOCKED_EXTERNAL | 同上 |
| TikFinity 断线重连 | BLOCKED_EXTERNAL | 同上 |
| VTube Studio | RESERVED | 不属于首版媒体动作数字人完成率 |
| Warudo | RESERVED | 不属于首版媒体动作数字人完成率 |
| 外部 OpenAI-compatible LLM | RESERVED | 本地规则内容计划器可运行 |
| 外部 TTS | RESERVED | Windows 本地 TTS 可运行 |

## 当前完成结论

V2 内部编码、类型检查、自动化、生产构建和关键浏览器交互已完成。项目尚不能声明“完整实播验收完成”，唯一原因是本机缺少 OBS 与 TikFinity 的外部实机环境；这两项必须按验收报告补做。
