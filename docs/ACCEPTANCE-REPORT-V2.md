# V2.0 验收报告

验收日期：2026-08-23

## 已执行

| 项目 | 结果 | 证据 |
|---|---|---|
| TypeScript 全工作区类型检查 | PASS | `pnpm typecheck`，12/13 工作区适用项目通过 |
| 自动化测试 | PASS | `pnpm test`，71 项通过 |
| 生产构建 | PASS | `pnpm build` |
| Windows TTS 真实 WAV | PASS | 自动化实际调用 System.Speech 并校验可播放 WAV |
| V2 Session/Cue/恢复 | PASS | 自动化覆盖开始、暂停、恢复、结束、重启恢复 |
| 礼物/点赞/评论/榜单 | PASS | 自动化覆盖幂等、积分和统一队列 |
| 场景草稿/发布锁定/预览隔离 | PASS | 自动化与浏览器交互均通过 |
| 状态来源编辑值一致性 | PASS | IDLE 预览与正式 `/obs/source/status` 均显示后台保存值 `1111111111111` |
| 礼物队列不按免费时间过期 | PASS | 自动化验证礼物绑定后 Reading 和 QueueItem 的 expiresAt 均被清除 |
| 音频主时钟 | PASS | 自动化验证 PLAY_STARTED 回写 SPEAKING Cue 起点和 revision |
| 傻瓜式中控 | PASS | 浏览器验证五入口及点赞次数、免费分钟、评论词、礼物时长、文字字体颜色设置 |
| 内容模板同源更新 | PASS | 浏览器输入 `STATE: {{stage}}` 后两个同源 iframe 同步显示 |
| 空闲隐藏行为 | PASS | 正式 `current-viewer` 无任务时输出透明空页面 |
| 中文后台响应式 | PASS | 988px 宽度 `scrollWidth=973`，无横向溢出 |
| 完整来源布局 | PASS | 1280×720 检查 `scrollWidth=innerWidth` |
| 浏览器控制台错误 | PASS | Admin 与 Overlay 错误日志均为空 |

## 未执行且不能冒充通过

| 项目 | 状态 | 原因 |
|---|---|---|
| OBS 逐来源添加和 60 分钟录制 | BLOCKED_EXTERNAL | 本机未安装 OBS Studio |
| OBS 渲染/编码延迟记录 | BLOCKED_EXTERNAL | 同上 |
| TikFinity 真实评论 | BLOCKED_EXTERNAL | 本机未安装/运行 TikFinity Desktop |
| TikFinity 真实点赞 | BLOCKED_EXTERNAL | 同上 |
| 普通礼物与连击最终帧 | BLOCKED_EXTERNAL | 同上 |
| TikFinity 断线自动重连 | BLOCKED_EXTERNAL | 同上 |
| 正式人物动作素材观感 | BLOCKED_EXTERNAL | 用户尚未提供最终人物动作素材 |

## 实机验收通过条件

1. 安装并启动 OBS Studio 与 TikFinity Desktop。
2. OBS 添加全部正式来源，完成 1080×1920 构图。
3. 录制不少于 60 分钟，记录丢帧、渲染延迟和编码延迟。
4. 真实直播间依次触发评论、点赞、普通礼物、连击礼物最终帧。
5. 验证重复 payload 不重复积分/发权益，断线后自动重连。
6. 验证人物、字幕、卦象、当前用户和音频同 Cue 启动；目标误差 250ms，结束误差 500ms。
7. 保存录像和脱敏字段样本后，才可把对应状态改为 `OBS_VERIFIED`、`LIVE_VERIFIED`。

## 当前判定

内部 V2 产品功能可本地运行并完成了自动化与浏览器验收；真实直播投产验收尚未完成，阻塞项全部来自缺失的外部 OBS/TikFinity 环境，不得标记为完整上线。
