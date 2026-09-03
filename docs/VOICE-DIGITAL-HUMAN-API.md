# 声音、数字人与统一播报 API

控制 API 默认地址为 `http://127.0.0.1:3210`，受 `x-meihua-token` 保护。克隆接口只负责提交素材并创建异步 Job，不再让浏览器一直等待云端训练。

## 两家供应商的规则

阿里云和百度配置会同时保存在 `providers.tts.voiceCloneApi.aliyun/baidu`、`providers.avatar.cloneApi.aliyun/baidu`。`provider` 只决定本次任务调用哪一家，不会删除另一家的配置。默认选择阿里云。

适配器已经接入两家的官方协议：

- 阿里云声音：百炼 CosyVoice `voice-enrollment` 克隆和 `SpeechSynthesizer` 合成。
- 百度声音：曦灵文件上传、`tts/clone/v2` 克隆和异步 `text2audio` 合成。当前官方克隆链路要求中文样音/中文目标，因此英文、日文、韩文目标要用阿里云或本地 OpenVoice。
- 阿里云数字人：Avatar `Create2dAvatar` 异步训练、`StartInstance` DingRTC 实时实例和文本播报参数。
- 百度数字人：曦灵 2D 视频上传、`lite2d/train` 异步训练、`liveRooms` 和 WebSocket 音频驱动。

官方参考：[阿里云 CosyVoice 克隆](https://help.aliyun.com/en/model-studio/cosyvoice-clone-api-reference)、[阿里云 StartInstance](https://help.aliyun.com/zh/avatar/avatar/developer-reference/api-avatar-2022-01-30-startinstance)、[百度曦灵声音克隆](https://cloud.baidu.com/doc/AI_DH/s/qm1ftwtgi)、[百度曦灵直播流](https://cloud.baidu.com/doc/AI_DH/s/Sm1h9a4dh)。

## 文本模型配置

控制台的“文本模型配置”对应：

- `providers.llm.adapter`: `rule-based` 或 `openai-compatible`。
- `providers.llm.baseUrl`: 默认百炼兼容地址。
- `providers.llm.model`: 默认 `qwen-plus`。
- `PUT /api/providers/secrets/llm`: 保存百炼 API Key，使用 Windows DPAPI，不返回明文。
- `reading.speechTargetSeconds`: 统一控制话术预算和音频校准。

大约的直播话术量：

| 时长 | 中文建议 | 英文建议 |
|---|---:|---:|
| 20 秒 | 38–50 字，目标约 44 字 | 18–24 词，目标约 21 词 |
| 30 秒 | 58–74 字，目标约 66 字 | 28–36 词，目标约 32 词 |

## 声音克隆

上传：`POST /api/voice-profiles`，`multipart/form-data` 字段：

- `file`: 样音文件。
- `sourceLanguage`: `auto`、`zh`、`yue`、`en`、`ja`、`ko`，推荐 `auto`。
- `referenceText`: 可选；百度克隆必须有准确样音文本。
- `targetCountry`: 例如 `US`、`JP`、`KR`、`CN`。
- `targetLocale`: 例如 `en-US`、`ja-JP`、`ko-KR`、`zh-CN`、`yue-HK`。
- `accentProfileId`: 实际目标口音模型配置。
- `cloneMode`: 默认 `COUNTRY_ACCENT`，兼容模式为 `TIMBRE_ONLY`。

成功返回 `202`，并带有 `profileId`、`jobId` 和 `PROCESSING` 状态。轮询 `GET /api/digital-human/jobs/:jobId`。只有完成 ASR、克隆、目标语言试听和 WAV 检查后才会变成 `READY`。

相关操作：

- `POST /api/voice-profiles/:id/test`
- `POST /api/voice-profiles/:id/approve`
- `POST /api/voice-profiles/:id/activate`
- `POST /api/voice-profiles/:id/retry`
- `POST /api/digital-human/jobs/:jobId/cancel`

密钥接口：

- `PUT /api/providers/secrets/voiceCloneAliyun`：百炼 API Key。
- `PUT /api/providers/secrets/voiceCloneBaidu`：百度 App Key；App ID 填在公开配置中。
- `GET /api/providers/secrets/status`：只返回是否已配置，不返回密钥。

试听文本从 `targetLocale` 获取，日语、韩语、粤语不会再被转换成 `zh-CN`。

## 数字人克隆与实时渲染

上传：`POST /api/digital-human/avatars`，上传 `file` 后返回异步 Job。任务完成前不会把头像标成 `READY`。

相关操作：

- `GET /api/digital-human/jobs/:jobId`
- `POST /api/digital-human/avatars/:id/retry`
- `POST /api/digital-human/avatars/:id/test`
- `POST /api/digital-human/avatars/:id/activate`
- `POST /api/digital-human/jobs/:jobId/cancel`

密钥和账号配置：

- 阿里云：`PUT /api/providers/secrets/avatarCloneAliyun`，保存 `{ "apiKey": "{\"accessKeyId\":\"...\",\"accessKeySecret\":\"...\"}" }`；配置 `Tenant ID`、`App ID`、公网素材地址。
- 百度：`PUT /api/providers/secrets/avatarCloneBaidu`，保存 App Key；配置 App ID。

阿里云 2D 克隆要求云端能够访问人物视频和 1:1 PNG 头像，所以控制台提供“云端克隆素材访问配置”：

- `aliyun.publicBaseUrl`: 本机 `/api/public-media/` 的公网 HTTPS 地址。
- `aliyun.portraitUrl`: 公网 PNG 地址。
- 声音克隆使用 `aliyun.publicBaseUrl` 访问 `/api/public-audio/` 样音。

这些公网路由只允许按随机文件名读取，不提供目录列表；百度上传接口不依赖它们。

阿里云实时实例返回 DingRTC 连接参数，而不是普通 MP4 URL。适配器会返回 `sessionId`、`channelId`、`token`、`userId`、`appId` 和 `gslb`，供前端 RTC SDK 拉流；没有 RTC 参数时任务失败，不伪装成视频流。百度 RTMP 模式返回拉流地址，RTC 模式返回官方 BRTC 参数。

`LOCAL_VIDEO` 只能使用 MuseTalk，MuseTalk 没有 `READY` 时返回 `DIGITAL_HUMAN_NOT_READY`，绝不自动切换 VRM。

## 统一播报

每条 Reading 固化一个不可变快照：

```json
{
  "readingId": "...",
  "voiceProfileId": "...",
  "avatarProfileId": "...",
  "targetLocale": "en-US",
  "targetCountry": "US",
  "accentProfileId": "en-us",
  "audioAssetId": "...wav",
  "videoAssetId": "...",
  "audioDurationMs": 20000,
  "videoDurationMs": 20000,
  "audioVideoOffsetMs": 0
}
```

流程是：文本模型出稿 → 目标声音生成 WAV → 同一内容驱动数字人 → 视频保持静音 → WAV 走统一 Windows Audio Bus → OBS。运行中不会重新读取 `activeVoiceProfileId` 或 `activeAvatarId`。

## 明确错误

`ACCENT_ENGINE_NOT_READY`、`ACCENT_MODEL_MISSING`、`VOICE_TARGET_UNSUPPORTED`、`CUDA_REQUIRED_FOR_LIVE`、`MUSETALK_NOT_READY`、`DIGITAL_HUMAN_NOT_READY`、`ALIYUN_AVATAR_RTC_PARAMS_REQUIRED` 等错误会让任务保持失败或待复核，不会返回假成功。

本机没有 NVIDIA/CUDA 时，只能做 CPU 离线验证，不能标记为实时直播验收通过。
