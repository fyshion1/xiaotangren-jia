# 媒体识别与 Google Takeout 导入方案

本阶段先确定边界和数据流，不把外部格式、视频处理逻辑塞进聊天接口。

## 视频

浏览器上传到后端后，任务只保存到 `backend/data/attachments` 和 SQLite。后端先执行本地探测与预处理：读取时长、分辨率和音轨，用项目目录内可配置的 `ffmpeg` 抽取最多 8 张关键帧，并把音频作为独立转写输入。完整视频不直接发送给模型。

第一版只支持 15 秒以内、50 MB 以内的视频。关键帧和转写文本组成视觉请求；模型结果进入待确认结果，用户确认后才写聊天或记忆。ffmpeg 未安装时返回明确错误，不自动调用系统范围安装。

建议接口：

```text
POST /api/media/video/analyze
GET  /api/media/tasks/{task_id}
POST /api/media/tasks/{task_id}/commit
```

## Google Takeout

上传 ZIP 后先解压到临时目录，识别 JSON、HTML、CSV 等格式，再通过 parser 转成统一消息：

```json
{"conversation_id":"", "timestamp":"", "sender":"", "content":"", "attachments":[], "source":"google_takeout"}
```

清洗包括时间标准化、HTML 清理、系统通知过滤、连续消息合并和重复记录去除。先生成预览统计，不自动写入现有聊天表；用户确认后才导入。原始 ZIP 默认在任务完成后删除，附件只保存引用。

建议接口：

```text
POST /api/imports/google-takeout
GET  /api/imports/{import_id}
GET  /api/imports/{import_id}/preview
POST /api/imports/{import_id}/commit
```

## 技术约束

- 复用 FastAPI、SQLite、现有附件目录和前端 API 封装。
- 任务先使用 SQLite 状态表和前端轮询，不引入 Redis/Celery。
- 不默认安装大型语音或视频模型；`ffmpeg`、`faster-whisper` 通过项目内可选配置启用。
- 任何导入内容先进入待确认区，写入聊天或记忆必须显式提交。
- 视频、导入记录与普通聊天记忆分开标记，避免自动污染长期记忆。
