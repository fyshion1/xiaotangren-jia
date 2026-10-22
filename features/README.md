# features/ —— 小窝功能（独立项目区）

**这个目录里的东西不进本体仓库。** 每个功能是一个**独立的 git 项目**，各自 push 到自己的远端。

## 为什么

《规划探讨.md》§0 第一原则：小糖人之家是**内核 / 大脑**，不是万能应用。
游戏的状态机、B站的抓取逻辑、QQ 的桥接进程，一旦混进本体仓库就会把「家」搅成一锅杂烩，
也拖慢本体的迭代。所以：

- **本体仓库**：人设、记忆、Prompt 组装、对话、小窝大脑 API（`/api/nest/*`）。
- **功能仓库（这里）**：各自采集状态、执行动作、跑自己的循环，通过 HTTP 反向调用大脑。

好处：① 本体聊天流干净；② 每个功能独立迭代、独立开源、坏了不拖垮大脑；③ 换大脑实现时功能不用动。

## 怎么放

```
features/
├── README.md                 # 本文件（本体仓库收录的唯一文件）
├── tools/                    # 可选工具运行包与工具适配（独立项目）
├── autonomous-activity/      # 自主活动与沙盒（独立专家插件仓库）
├── desktop-pet/             # Electron 桌面聊天（独立 git 仓库）
├── project-costs/           # 项目实付费用、账单导入与人工确认对账（独立 git 仓库）
├── dont-starve-together/     # 饥荒联机（独立 git 仓库）
├── bilibili-scout/           # 小糖人逛 B站（独立 git 仓库）
└── qq-bridge/                # QQ 桥（独立 git 仓库）
```

建一个新功能：

```bash
cd features
git init dont-starve-together   # 或 git clone <远端> 进来
```

目录名对应后端 `backend/app/features_registry.py` 里那条功能的 `folder` 字段。
本体仓库的 `.gitignore` 已经写死 `/features/*`（只放行本 README），所以不用担心误提交。

## 功能怎么接大脑

工具插件（`features/tools`）也是可信本机插件：本体只保留配置与加载接口，不自带工具执行或第三方联网实现。工具中心按插件抽屉展示，联网排第一。

自主活动与沙盒是可信本机插件的另一个例外：实现、界面和沙盒资源全部位于独立项目，
由本体的通用插件宿主注入本机 SDK，在独立后台进程运行。未安装或未开启专家模式时不开放。
它与下面仅通过 HTTP 接入的外设不同，需与宿主版本配套；见[专家模式说明](../docs/guides/expert-mode.md)。

2026-10-19 已接入 [共享活动契约](../docs/integrations/feature-memory-api.md)：来源与可见范围分离，新功能通过事件入口加入统一当天经历；统一来源管理在个人记忆库。实现与边界见 [总体方案施工结果](../docs/plans/shared-memory-features-plan.md#六施工结果2026-10-19)。下文带 `feature_id` 隔离的说明描述旧协议，不能作为新 features 必须隔离的要求。

每个功能只依赖大脑的 HTTP 契约，不 import 本体任何代码。契约见
[`docs/integrations/nest-integration.md`](../docs/integrations/nest-integration.md)（通用外设接入层）与
[`docs/integrations/game-integration.md`](../docs/integrations/game-integration.md)（旧的游戏专用协议，仍兼容）。

要点：

- **配置**：向 `GET /api/nest/features/{feature_id}/api-config` 要一份**合并好的**模型配置
  （全局默认 + 本功能覆盖；默认带视觉路）。**不要在功能里硬编码 key**，也不要读浏览器 localStorage。
- **记忆**：自动提炼记忆时带 `feature_id`（落 `memories.game_id`），
  这样玩游戏 / 逛 B站 攒下的记忆**不会漏进日常聊天**。
- **通用队列 / 消息中转**：用 `/api/game/commands` 和 `/api/agents/messages` 那套协议。

桌宠属于普通聊天的另一个呈现端，按用户要求与私聊/群聊共享记录与记忆，使用
`/api/chat/session`，不单独建立外设记忆桶，也不把模型凭证交给渲染进程。
具体契约与本机启动方式见 [`docs/plans/desktop-pet-mvp.md`](../docs/plans/desktop-pet-mvp.md)。

## 给第三方留的口子

契约是通用的（就是 HTTP + JSON），所以**别人写的功能也能接这套大脑**，
你写的功能换个大脑（比如别人自建的同构服务）也能跑 —— 只要对上契约。
投简历时拿这份契约 + 一个参考外设就够看，本体实现不用开源。
