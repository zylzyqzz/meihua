# 5｜安装完成后检查

统一入口已经自动完成机器级检查，正常结束时应满足：

1. `http://127.0.0.1:5200/` 可以打开管理端。
2. `http://127.0.0.1:5173/obs/source/meihua-stage` 可以打开 OBS 正式画面。
3. `logs\last-start-report.json` 的 `status` 为 `READY`。
4. 报告中的 `control-service`、`admin-ui`、`obs-stage` 和当前选中的声音服务均为 `READY`。
5. 管理端开播检查显示当前声音、画面和 TikFinity 的真实状态。

当前使用预录视频时，MuseTalk 或 OpenVoice 未就绪属于可选能力警告，不应阻止中控启动。切换到实时数字人或目标国家口音后，它们才会成为当前链路的必需项。

## 出现问题时

- 再次双击 `2-启动系统.bat`：健康进程会复用，缺失进程会补启动。
- 运行 `安装工具\01-检查整包.bat`：检查文件、模型、安装包哈希、磁盘和权限。
- 运行 `1-环境检查与安装.bat`：重新检查 OBS、VB-CABLE 与 TikFinity。
- 打开 `logs\last-start-report.json`：查看精确失败服务、端口和错误原因。
- 打开对应的 `logs\*.err.log`：查看服务自身错误。

启动器遇到陌生进程占用端口时不会自动杀进程。请根据报告中的 PID 确认后再自行关闭，避免误伤其他软件。
