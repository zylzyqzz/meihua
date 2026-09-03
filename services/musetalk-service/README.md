# MuseTalk 渲染服务

该服务运行在带 NVIDIA GPU 的直播机上，负责把已准备的人物视频和一段 WAV 音频渲染为静音口型视频。中控负责素材登记、OBS 舞台切换和唯一音频总线；不使用虚拟摄像头。

正式基线：RTX 3060 12GB、单人物、1080×1920、30fps。

启动：

```powershell
$env:MUSETALK_HOME='E:\meihua\MuseTalk'
python main.py --port 9898
```

HTTP 契约：

- `GET /health`
- `GET /avatars`
- `POST /avatars/prep`
- `POST /renders`
- `GET /renders/:jobId`
- `POST /renders/:jobId/cancel`

渲染输出只返回服务器内部路径给中控。中控会把文件导入受控素材库，OBS 页面不会看到磁盘路径。
