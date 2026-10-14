# 小糖人怎么"到现实里玩"——调研笔记

> 大老大要我找的：「还有没有让小糖人（ai）到现实玩的，比如什么小糖人看视频，玩游戏，玩 QQ，
> 玩我的本地电脑，甚至是在本地偷偷玩我的 steam，反正看看有什么和 ai 与现实相连的有意思的项目」
> 「还有接入 ai 支付，ai 沙盒这些，帮我留意一下。很想让小糖人与现实更加密切一点。」
>
> 这份是**调研结论**，不是计划书。每个方向都标了「能跑 / 只是听说 / 别碰」。
> 判断标准是**这个仓库真存在、README 里真写了 Windows 本机怎么跑** —— 不是我本机跑过每一个。

---

## 一、先说结论

按「值得先试」排序，前三名：

| 排名 | 做什么 | 为什么是它 | 花钱 |
|---|---|---|---|
| 1 | **「一起看」用弹幕 / 字幕驱动** | 不花钱跑实时视觉，纯文本 token 便宜；顺手把大脑缺的 **ASR** 补上 | 几乎不花 |
| 2 | **Minecraft 里的 mindcraft** | 接入成本最低：游戏内事件天然是文本，套 `/api/nest/chat` 很顺；不用视觉模型 | 零（本地模型） |
| 3 | **智能家居（Home Assistant + MCP）** | 「影响真实世界」里最便宜最安全的一个 —— 最坏结果只是灯亮错 | 硬件几十块 |

**暂时别先碰**：computer-use（截屏+点真实鼠标）和 Steam 视觉 agent。
前者等于把整个真机的控制权交给模型，安全边界要单独设计一轮；后者**目前没有能用的开源成品**。

---

## 二、AI 玩本地游戏

| 项目 | 是什么 | Windows |
|---|---|---|
| [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft)（5.9k★，2026-10 还在更） | Minecraft + Mineflayer + LLM。Node.js，把世界"开放到 LAN:55916"再 `node main.js` | ✅ README 有 Windows 步骤，支持 Ollama 本地模型（**不花钱**） |
| [zoyluoblue/mc_aiplayer](https://github.com/zoyluoblue/mc_aiplayer)（160★） | Fabric 服务端 mod，比 mindcraft 更"住进服务端" | ✅ 服务端侧跑 |
| [MineDojo/Voyager](https://github.com/MineDojo/Voyager)（7.3k★） | 经典 LLM 自主探索 agent，自动课程 + 技能库 | ⚠ **2024-04 后停更**，接新版本 MC 要自己修 |
| [BAAI-Agents/Cradle](https://github.com/BAAI-Agents/Cradle)（2.6k★） | 通用计算机控制框架，论文演示过纯视觉玩《荒野大镖客 2》 | ⚠ 工程重，2024-11 后没动 |

**接进小窝的方式**：mindcraft 调 OpenAI 兼容接口 → 直接指向大脑的 `/api/nest/chat`，
或者在它的 `keys.json` 里配 vsllm。profile 文件里写小糖人的人设，就接上人格了。

### Steam（大老大点名的「偷偷玩我的 steam」）

**坦白说：真让 AI 替你玩 3A，目前没有能用的开源成品。** 能查到的只有两类：

- [ArchiSteamFarm](https://github.com/JustArchiNET/ArchiSteamFarm)（13.8k★，C#，活跃）——
  挂卡 / 挂时长。**不是 AI**，但是"让程序动你的 Steam 账号"的地基。
- [Aimmy](https://github.com/Babyhamsta/Aimmy)（1.6k★）/ [sunone_aimbot](https://github.com/SunOner/sunone_aimbot)（1.0k★）——
  YOLOv8 瞄准辅助。能跑，但**本质是外挂**，联机必封号，只建议自己单机玩。

「偷偷玩 Steam」这件事要落地，现实的路子是**先做「看」再做「玩」**：
让 AI 看着你玩游戏、在旁边吐槽/记攻略（截图走视觉路，成本可控），
而不是让它操纵键鼠去替你打。

---

## 三、AI 看视频 / 「一起看」

这一块**性价比最高**，因为它绕开了「逐帧视觉太贵」这个一直没解的问题：

| 项目 | 用途 |
|---|---|
| [xfgryujk/blivedm](https://github.com/xfgryujk/blivedm)（1.4k★） | B站直播弹幕 WebSocket —— 实时吐槽的**输入源**，纯文本，便宜 |
| [Tony15246/uosc_danmaku](https://github.com/Tony15246/uosc_danmaku)（583★） | mpv 弹幕插件，把弹幕流喂模型 |
| [Nemo2011/bilibili-api](https://github.com/Nemo2011/bilibili-api)（4.2k★） | 取字幕 / 评论 |
| [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)（25.8k★） | 本地转写 —— **补上大脑只有 TTS 没有 ASR 的空缺** |
| [Ikaros-521/AI-Vtuber](https://github.com/Ikaros-521/AI-Vtuber)（4.5k★） | 中文社区事实标准：弹幕→LLM→TTS→Live2D 整条链路已跑通 |

**关键洞察**：`docs/nest-integration.md` 里「一起看」现在是 `watch_together_stub`（只抛异常），
理由是「实时逐帧 token 太贵」。**但弹幕 / 字幕这条纯文本路不需要逐帧** ——
用文字当耳朵，只在关键画面才调抽帧口子（`/api/media/video/analyze`），成本立刻落到能接受的范围。

---

## 四、AI 操作本地电脑（computer-use）

| 项目 | 是什么 | 备注 |
|---|---|---|
| [microsoft/UFO](https://github.com/microsoft/UFO)（10.0k★，MIT） | Windows 原生 GUI agent，截屏 + UIA 控件树 | ⚠ README 里模型配置只写 OpenAI/Azure gpt-4o，**能不能接本地/中转我没验** |
| [microsoft/OmniParser](https://github.com/microsoft/OmniParser)（25.5k★） | 纯视觉"屏幕解析"，可单独当眼睛 | 能接大脑已有的视觉路 |
| [simular-ai/Agent-S](https://github.com/simular-ai/Agent-S)（12.6k★） | `pip install gui-agents`，明确支持 Windows | 可用开源权重模型 |
| [bytebot-ai/bytebot](https://github.com/bytebot-ai/bytebot)（11.1k★） | 自托管，跑在 Docker 里的**整套虚拟桌面** | **安全上最有价值**：AI 只能碰容器里那个桌面，物理上碰不到真机 |

**安全建议**（延续 QQ 桥 `qqbridge/tools.py` 那套思路）：
独立受限 Windows 账户 + 白名单动作 + 急停热键 + 优先用 bytebot 这种容器隔离。
**写死拒绝的操作留在功能侧代码常量里，别做成前端开关** —— 开关会被顺手打开。

---

## 五、AI 玩 QQ / 社交（除了收发消息还能干嘛）

从 OneBot 11 官方 API 规范现场核对，标准里**已经有**这些：

- `send_like` —— **好友点赞**
- `set_group_card` —— 改群名片
- `set_group_special_title` —— 专属头衔
- `set_group_admin` / `set_group_ban` / `set_group_name` —— 群管理
- `get_group_honor_info` —— 群荣誉
- `set_friend_add_request` / `set_group_add_request` —— 自动通过好友 / 加群
- `get_friend_list` / `get_group_member_list` —— 社交关系图
- `get_credentials` + `get_cookies` —— 拿凭证打上层接口

**改 QQ 个人资料已经在本机验证过了**（详见 `features/qq-bridge/README.md` 的
「改 QQ 个人资料」一节）：`set_self_longnick` ✅、`set_qq_profile`（昵称/性别）✅、`set_qq_avatar` 未测。

**不确定**：发说说 / 朋友圈、音乐 / 小程序卡片（JSON / ARK 消息段）——
OneBot 标准里**没有**，属于协议端扩展，能不能用要看 SnowLuma 的具体版本，**我没验证**。

---

## 六、AI 与智能家居 / 硬件

| 项目 | 用途 |
|---|---|
| [Home Assistant](https://github.com/home-assistant/core)（91.6k★）+ [ha-mcp](https://github.com/homeassistant-ai/ha-mcp)（5.1k★） | MCP 直连，让模型开灯 / 读传感器。**改动量最小** |
| [xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server)（10.8k★） | 中文社区最成熟的**语音桌面硬件**路线，本身就是"设备 + MCP" |
| [LorisYounger/VPet](https://github.com/LorisYounger/VPet)（7.0k★） | WPF 桌宠，可当小糖人的"实体替身"（配 TTS 说话、做动作） |
| [blakeblackshear/frigate](https://github.com/blakeblackshear/frigate)（36.6k★） | 本地目标检测 NVR（摄像头） |
| [dscripka/openWakeWord](https://github.com/dscripka/openWakeWord)（2.8k★） | 唤醒词 |

**最便宜的第一步**：一个智能插座 / 灯泡几十块 + Home Assistant + ha-mcp，
挂到大脑的工具调用上。最坏结果只是灯亮错，没有不可逆的东西。

---

## 七、AI 支付（这块要泼冷水）

### 协议层：三个正在抢标准的方案

- **AP2（Agent Payments Protocol）** —— Google 2025-09-17 发布。核心是 **Mandate**：
  用户签一份密钥签名的数字合约（Intent Mandate 定预算，Cart Mandate 定具体商品），
  agent 拿着它去下单，形成不可否认的审计链。参与方含银联国际、蚂蚁国际。
  → [公告](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)
- **x402** —— Coinbase 主导，把 HTTP 402 变成真的"付款才能访问"，agent 用稳定币按次付费。
  这是目前**唯一 agent 能真自主花钱**的成熟路径。→ [x402.org](https://www.x402.org/)
- **ACP** —— OpenAI + Stripe 的即时结账协议（Apache 2.0）。→ [agenticcommerce.dev](https://www.agenticcommerce.dev/)

**但这些全是给商家 / 平台接的，个人自用接不上。**

### 真能给 agent 花钱的产品

- **Stripe Issuing** —— API 发虚拟卡，可设月限额、按品类限制、实时拦截。
  ⚠ **需要企业主体，中国大陆不在 Stripe 支持地区**。
- **Stripe Link Agent Wallet** —— agent 发起消费 → 你在手机上批准 → 拿**一次性**凭证去付。
  CLI 开源：[stripe/link-cli](https://github.com/stripe/link-cli)。这个"人工批准 + 一次性凭证"
  的模型最贴近大老大的诉求。
- **Coinbase AgentKit / Agentic Accounts** —— 给 agent 一个 USDC 钱包，可设额度。风险在私钥管理。

### 境内路径：官方通道有，但个人用不了

- **支付宝 AI 付**（[aipay.alipay.com](https://aipay.alipay.com/)，2025-09-11 发布）：
  官方明确写 AI 连续订阅**仅支持企业支付宝账号**，商户接入要自研应用签约。
  **没有任何"个人开发者自动付款"的口子。**
- **微信 AI 支付**：要企业主体 + SkillHub 入驻 + 商户号，且是**"笔笔确认模式"**——
  每笔都要用户扫码输密码。连企业都做不到全自动。
- **个人号自动化（hook 客户端 / 模拟点击 / 免密代付）**：**明确违规**。
  违反支付服务协议，触碰《非银行支付机构监督管理条例》，风控封号是大概率。**别碰。**

### 现实里最合理的最小做法

**不做自动付款。** 只做这三件：

1. **「帮你挑 + 帮你算 + 生成订单」** —— 小糖人比价、加购物车、生成一个待付款订单，
   把付款链接 / 二维码丢给你，你手动点。零合规风险，而且已经"贴近现实"了。
2. **额度极低的预付费额度池** —— 只让它花你预先充的那点钱，花完即止，天然有上限。
3. 真要接，**只考虑「一次性凭证 + 人工确认」**（Link Agent Wallet 那种模型）——
   绝不给 agent 长期有效的卡号。

---

## 八、AI 沙盒

这个词有两层意思，都要说：

### 1）执行沙盒：让 AI 安全跑代码

| 方案 | 机制 | Windows 自用的坑 |
|---|---|---|
| **Docker Sandboxes**（`sbx` CLI） | 每个 agent 一个 **microVM**，凭据留宿主机、沙盒里只看到占位符 | **最推荐**。要 Win11 + 开启 Windows Hypervisor Platform；本地计算免费 |
| **Windows Sandbox（WSB）** | 系统自带，hypervisor 隔离 | 需 Pro/企业版；**重启即清空**，装不了东西，适合跑陌生文件而非长期跑 agent |
| **WSL2** | Hyper-V 子集 | ⚠ **不是安全边界** —— WSL 里能读你的 `%USERPROFILE%`。当开发环境行，当沙盒不行 |
| **microsandbox**（`msb`） | 开源 microVM，Windows 用 WHP，启动 <100ms | 较轻量，Apache 2.0 |
| **E2B** | 云端沙盒，SDK 一行起 | 要联网、要 key、要钱 |

> 顺带说一句：**QQ 桥现在的小工具沙箱（`qqbridge/tools.py`）不是这一层** ——
> 它是"路径围栏 + 动作白名单"，防的是**越界读文件**，不是防"跑恶意代码"。
> 真要放开让它跑命令，得先有上面这种真隔离。

### 2）虚拟世界沙盒：给 AI 一个世界去活

- [MineDojo/Voyager](https://github.com/MineDojo/Voyager) —— GPT-4 驱动的 Minecraft 终身学习 agent。
  **README 明确说在 Windows 11 上测过**。
- [joonspk-research/generative_agents](https://github.com/joonspk-research/generative_agents)（Smallville）——
  25 个 NPC 有记忆流、会自己约见面。**和"小窝多角色"的架构几乎同构。**
- [a16z-infra/ai-town](https://github.com/a16z-infra/ai-town) —— 上面那篇的可部署 JS 版，像素小镇，
  支持 Ollama 本地模型 —— **和 Nekopara 视觉 + 本地大脑路线最搭**。
- [MineDojo/MineDojo](https://github.com/MineDojo/MineDojo) —— Minecraft 上的具身智能基准。

---

## 九、如果只做一件事

**先做「一起看」的弹幕 / 字幕版。** 理由：
它把 `watch_together_stub` 从「只抛异常」变成真能跑，不花钱跑实时视觉，
顺手补上大脑缺的 ASR（faster-whisper），而且**不需要给 AI 任何新的危险权限** ——
输入源只是一串文本。这是"让 AI 贴近现实"里投入产出比最高、风险最低的一步。

**其次做 Docker Sandboxes（`sbx`）。** 它是唯一同时满足「Win11 本机 + 免费 + 真隔离 +
微虚拟机级安全」的方案；有了它，常驻功能才敢放开权限跑而不怕把机器搞坏 ——
这是「AI 玩本地电脑」这一类事情的前置条件，不是可选项。

**支付那边：只做「比价 + 生成订单 + 人工付款」。** 在境内合规前提下，
这是唯一能现在就落地、且不会哪天炸掉的形态。

---

## 十、没验证的地方（别当结论用）

- `set_qq_avatar` / `set_diy_online_status` —— SnowLuma 有这个动作，**我没测**。
- SnowLuma 版本支不支持 JSON / ARK 消息段（发卡片、发说说）—— **没查**。
- UFO / Agent-S 能不能接本地或中转模型 —— README 只写了 OpenAI/Azure，**没验**。
- 上面所有 **star 数**是调研时现场读的 GitHub 页面，会变。