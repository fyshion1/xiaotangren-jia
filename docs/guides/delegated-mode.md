# 原生模式与委托模式

部署采用复制方式。笔记本原有数据库、QQ 桥和原生服务保留；另一台机器运行独立副本。复制后的数据各自保存，目前没有双向同步。

## 分工

- 主机持有聊天、记忆、附件、定时提醒和 QQ 桥，负责调用聊天 API 与联网搜索。
- 算力端是独立 `app.worker` 服务，不启动主机数据库、QQ 桥或自主任务。当前支持本地 embedding，以及显式启用的 ComfyUI 图片生成。
- 原生模式维持原来的单机路径；委托模式将上述本地计算交给算力端。它不是所有后台功能的远程执行框架。
- embedding 也可直接选择外部 OpenAI 兼容 API，两种模式都支持，不经过算力端。参见 [外部 embedding 配置](embedding-api.md)。

算力端失联时，记忆仍然写入主机，检索退回关键词；基础聊天和搜索仍在主机运行。失败的图片任务不会自动重试，以免重复生成。基础聊天仍需要主机自身能够访问聊天 API，搜索也需要互联网。

## 轻量主机

参考 `deploy/j1900.env.example` 和 `deploy/xiaotangren.service`。安装 `backend/requirements-lightweight.txt` 及本地 `packages/tool-runtime`，前端预先在笔记本构建，再复制 `frontend/dist`。

`RUNTIME_PROFILE=lightweight` 关闭桌宠、语音及音视频接口，停用采集和自主探索调度；不加载本地向量模型。无需安装 PyTorch、ASR 或 TTS。

Linux 运行目录为 `/opt/xiaotangren-jia`。服务用 `systemctl enable --now xiaotangren` 设置开机启动，日志用 `journalctl -u xiaotangren` 查看。不要把主机的完整管理 API 暴露到公网。

如果需要 HTTP 代理，必须把代理变量配置到 systemd 的进程环境；仅在 Pydantic `.env` 中写入未定义的 `HTTP_PROXY` 不会让 HTTP 客户端自动使用代理。代理服务也必须能独立恢复，不能依赖笔记本提供代理。

## 算力端

安装 `backend/requirements-worker.txt`，本地 embedding 另需 `sentence-transformers` 和模型文件。将 `deploy/worker.env.example` 中的值设为算力端进程环境，保持原生 `.env` 不变，然后运行 `start-worker.ps1` 或 `start-worker.sh`。Windows 启动脚本也支持从被 Git 忽略的 `backend/data/compute-worker.json` 读取 `token` 字段。密钥至少 24 字符，推荐随机生成 32 字节。

默认监听 8010；防火墙只开放给主机所在的可信网络。跨公网部署请使用 VPN 或 HTTPS。两端 `EMBED_LOCAL_MODEL` 必须一致；更换模型或 API 后重建记忆向量索引。首次加载模型可能超过请求超时并触发降级，预热后重试即可。

在前端「小窝大脑」中保存委托地址和密钥，可测试连接；更换目的地址需要重新填写密钥。切回原生模式不删除原生功能或资料。算力端故障后有 10 秒冷却，之后新请求自动重新尝试。

## 2026-10-21 实机验证与未完成项

J1900 Debian 13 的轻量主机已复制部署到 `192.168.31.237:8000`，设置 systemd 开机启动。笔记本当前通过有线地址 `192.168.31.29:8010` 提供算力，换成路由器 Wi-Fi 后需要更新地址或设置固定 DHCP 租约。

真实 embedding 请求返回 512 维向量，预热后单条约 0.56 秒。停止笔记本算力进程后，主机健康检查、前端、隔离数据库里的记忆写入和关键词召回通过；J1900 未安装 PyTorch。此结果不是完整 QQ 收发或真实聊天 API 的验收。

Debian QQ 与 NapCat 已安装，账号已登录；`napcat` 和 `xiaotangren-qq-bridge` 服务已设置开机启动。反向 WebSocket 在 `127.0.0.1:3010/onebot/v11/ws` 连接成功，桥已读取登录账号。笔记本上的 QQ 桥已停止，原有配置保留；不要同时启动两个副本监听同一账号，以免重复回复。真实消息收发仍待用户发消息验收。

设置接口的 `values` 包含界面默认值，`overrides` 只包含已保存配置与运行约束；QQ 桥使用后者，避免未配置的默认值覆盖部署副本的本地连接密钥和白名单。轻量部署使用单账号反向 WS，关闭语音及主动消息。

J1900 代理当前运行，但其开机自启尚未完成；需要外网代理的 API 在重启后可能不可达。笔记本算力进程也尚未配置开机自启。
