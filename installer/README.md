# 梅花直播系统下载器

双击 `MeihuaInstaller.bat`，按以下顺序操作：

1. 选择安装目录。
2. 点击“检查环境”。
3. 保留默认组件，或按需勾选声音克隆、ASR、MuseTalk、OpenVoice。
4. 点击“开始安装”。
5. 安装完成后，从项目根目录运行 `scripts/start-production.ps1`。

默认安装的是主中控、Kokoro 英文女声、OBS、VB-CABLE 和 TikFinity。GPT-SoVITS、MuseTalk 与 OpenVoice 下载量大，因此保持可选。

## 版本策略

- 主中控来自私有仓库 `zylzyqzz/meihua` 的 `main` 分支。
- MuseTalk 固定到已验证提交，再覆盖 `installer/overlays/musetalk` 中的 Windows/静音输出兼容文件。
- GPT-SoVITS 固定到 V3 标签，再覆盖 `installer/overlays/gptsovits-v3` 中的梅花专用 API 与兼容源码。
- Kokoro 与 Whisper 模型使用官方地址和 SHA-256 校验。
- 模型、数据库、API Key、OBS 推流密钥和用户素材不会存入 Git 仓库。

## 私有仓库认证

如果只把 `installer` 文件夹复制到新电脑，安装器会尝试克隆私有仓库。请先安装 Git，并在 Windows Git Credential Manager 中登录有权访问 `zylzyqzz/meihua` 的 GitHub 账号。

## 日志

- `installer/logs/`：安装全过程日志。
- `installer/state/environment.json`：最近一次环境检查。
- `installer/state/installation.json`：已安装组件和固定版本。

驱动安装和 TikFinity 首次登录仍需要人工确认；这是 Windows 驱动安全和第三方账号登录要求，安装器会在对应步骤明确提示。
