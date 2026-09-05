# 梅花直播系统下载器

完整版压缩包内置当前固定版本的主中控源码，新电脑不需要登录 GitHub；模型和第三方软件按所选组件下载。

双击 `START-INSTALLER.cmd`（或 `启动梅花安装器.cmd`），按以下顺序操作：

1. 选择安装目录。
2. 点击“检查环境”。
3. 保留默认组件，或按需勾选声音克隆、ASR、MuseTalk、OpenVoice。
4. 点击“一键补齐依赖”：只安装当前缺少的 Git、Node.js、pnpm、Python 3.10、FFmpeg、VC++ 运行库，以及所选 OBS、VB-CABLE、TikFinity。
5. 点击“安装所选组件”：释放主源码、下载 Node/Python 依赖和所选模型并完成生产构建。
6. 网络中断或电脑休眠后，再次打开安装器并点击“继续安装”；已经完成的组件和下载缓存不会丢失。
7. 安装完成后，双击安装目录中的 `START-MEIHUA.cmd`。

默认安装的是主中控、Kokoro 英文女声、OBS、VB-CABLE 和 TikFinity。GPT-SoVITS、MuseTalk 与 OpenVoice 下载量大，因此保持可选。

“检查环境”会按人能读懂的分组输出 Windows/磁盘、基础依赖、显卡与 CUDA、主中控构建、所有本地模型、直播软件和音频驱动。没有 winget 不会再阻断安装，安装器会改用软件官方安装包；NVIDIA 驱动和 CUDA 因显卡型号不同，只检测并给出明确说明，不盲目自动安装。

## 版本策略

- 完整版安装器内置构建时锁定的主中控源码；精简版才从私有仓库 `zylzyqzz/meihua` 下载。
- MuseTalk 固定到已验证提交，再覆盖 `installer/overlays/musetalk` 中的 Windows/静音输出兼容文件。
- GPT-SoVITS 固定到 V3 标签，再覆盖 `installer/overlays/gptsovits-v3` 中的梅花专用 API 与兼容源码。
- Kokoro 与 Whisper 模型使用官方地址和 SHA-256 校验。
- 模型、数据库、API Key、OBS 推流密钥和用户素材不会存入 Git 仓库。

## 私有仓库认证

请优先使用 `MeihuaInstaller-v*.zip` 完整版，其中包含 `payload/meihua-live-source.zip`，不需要 GitHub 登录。只有手工复制缺少 `payload` 的精简版安装器时，才需要私有仓库权限。

## 日志

- `installer/logs/`：安装全过程日志。
- `installer/state/environment.json`：最近一次环境检查。
- `installer/state/installation.json`：已安装组件和固定版本。
- `<安装目录>/.meihua-installer/`：每个组件最近一次安装结果。
- `<安装目录>/downloads/*.partial`：可继续下载的大文件缓存；不要手工删除。

下载器每 10 秒显示已缓存容量；网络中断会自动尝试恢复，仍失败时保留缓存。再次点击安装，会跳过已经通过复检的组件并从未完成处继续。

驱动安装和 TikFinity 首次登录仍需要人工确认；这是 Windows 驱动安全和第三方账号登录要求，安装器会在对应步骤明确提示。
