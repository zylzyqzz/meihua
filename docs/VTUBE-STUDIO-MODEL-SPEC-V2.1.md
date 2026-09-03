# VTube Studio Live2D 模型与 OBS 规范（V2.1）

## 当前边界

VTube Studio 是可选人物方案，不是核心测算链路和正式开播硬条件。OBS 直接捕获 VTube Studio 人物窗口；中控仅按导演阶段触发动作热键，不发送嘴型参数，也不承诺口型与音频同步。

若不使用 VTube Studio，推荐上传透明 WebM、绿幕 MP4 或 PNG/WebP 遮口人物素材，并在 OBS 添加 `/obs/source/avatar`。两种人物方式只能选一种，避免双人物。

## 动作热键

需要联动时，将模型热键命名为：

```text
MEIHUA_IDLE
MEIHUA_QUESTION
MEIHUA_CASTING
MEIHUA_THINKING
MEIHUA_SPEAKING
MEIHUA_EMPHASIS
MEIHUA_GIFT
MEIHUA_FINISH
MEIHUA_ERROR
```

建议动作持续 0.6–2.5 秒、无声音；`IDLE` 可循环，其余动作结束后回待机。动作触发失败只记录告警并回退待机，不中断已开始的语音。

## 配置与验收

1. 在 VTube Studio 开启 Plugin API，默认地址为 `ws://127.0.0.1:8001`。
2. 在中控“数字人阶段动作（可选）”中连接并授权；令牌由 Windows DPAPI 加密保存。
3. 加载模型并运行“测试全部动作”，逐项确认热键确实触发。
4. OBS 使用窗口捕获或游戏捕获取得人物画面，并配置透明背景或色度键。
5. 不要在 OBS 添加 `/obs/source/audio`。语音由中控后端直接播放到 Windows 默认输出设备。
6. 字幕、卦象、当前观众、队列和榜单按需添加独立浏览器源；字幕可关闭。

没有正式模型时，适配器只能标记 `CODED` 或 `AUTOMATED_VERIFIED`；人物实机动作仍为 `BLOCKED_EXTERNAL`。官方资料：[VTube Studio Plugin API](https://github.com/DenchiSoft/VTubeStudio/blob/master/README.md)。
