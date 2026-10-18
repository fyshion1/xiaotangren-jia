# QQ 网关（SnowLuma）· 摸出来的东西

> 这篇是**踩坑记录**，不是设计文档。下次动「QQ 桥 / 同时登两个号会不会挂错号」这条线之前，
> 先读这里，能省一整个晚上的试错。
>
> 配套代码：`backend/app/services/snowluma.py`（WebUI 小客户端 + 换号逻辑）、
> `backend/app/routers/nest.py`（`_live_uin` / `_gateway_status` / `_auto_swap_bot` / `/gateway/claim`）、
> 前端 `frontend/src/components/QqBridgePanel.tsx`。
>
> 相关文档：[通用外设接入层](./nest-integration.md)（`/api/nest/*` 协议）。

---

## 1. SnowLuma 不是「QQ 机器人」，是**注入器**

大老大原话是「识别一下哪个号，自动连上去」。第一步就得先把这件事掰正：

**SnowLuma（`D:\SnowLuma`，`node.exe index.mjs`）不自己登录 QQ。** 它的做法是把代码**注入进一个
已经在跑的 `QQ.exe` 进程**，借用那个进程已经登录好的会话。

推论（都是实测撞出来的）：

- 没开着 QQ，SnowLuma 起了也**一个号都挂不上**。
- 它没有「去登哪个号」这个概念 —— 只有「往哪些进程里注入」。
- 用环境变量 `SNOWLUMA_HOOK_AUTOLOAD=1` 时，它会给**发现的每一个** QQ 进程都注入。
- **没有任何环境变量 / 命令行参数能指定「只注入某个号」**（只有 `SNOWLUMA_HOOK_AUTOLOAD`
  / `..._ALL` 这种总开关）。所以「指定号」这件事，只能从它的 **WebUI API** 下手。

---

## 2. 那个坑：两个号抢同一对端口

每个号一份配置：`D:\SnowLuma\config\onebot_<uin>.json`。里面写死了：

| 适配器 | 端口 |
|---|---|
| `http-default` | `127.0.0.1:3000` |
| `ws-default` | `127.0.0.1:3001` |

**两份配置写的是同一对端口。**（`role: Universal`，每个号一个 43 字符 `accessToken`。）

于是同时登两个号的时候：

1. autoload 把两个号都挂上；
2. 两个都去 bind 3001 → **先挂上的赢**，后挂的 `listen EADDRINUSE`；
3. 输的那个在网关日志里变成 `network startup degraded: UIN=… failures=2`；
4. 赢的多半是**大号**（先登录、先被发现）→ 桥连 3001 一切正常，
   `get_login_info` 回来的身份却是大号 → **说话的身份是错的**。

桥这边一点错都看不出来，只是「我是 XXX」那行印的是大号。**这就是原始症状。**

---

## 3. SnowLuma WebUI API（`127.0.0.1:5099`）

```bash
POST /api/login   {"password": "…"}   → {"token": "…"}   # 24h 有效，也顺手种一个 cookie
```

之后所有请求带 `Authorization: Bearer <token>`。

| 端点 | 干什么 | 备注 |
|---|---|---|
| `GET /api/status` | 总状态 | |
| `GET /api/processes` | 每个 QQ.exe 的 pid / uin / injected / status | 见 §4，`uin` 字段**不可信** |
| `GET /api/processes/:pid/probe-login` | **这个 pid 到底是哪个号** | **未注入的也能问** —— 这个很有用 |
| `POST /api/processes/:pid/unload` | 把某个号摘下来 | 端口随之松手 |
| `POST /api/processes/:pid/refresh` | 重新挂上 | ⚠ **不会重新绑端口**，实测无效 |
| `GET /api/connections` | 每个号的每个适配器 `ok` / `degraded` | 判断「谁占着端口」看这里 |
| `GET /api/config/:uin` | 读这个号的 OneBot 配置 | |
| `POST /api/config/:uin` | 存配置并**重新应用适配器** | ⚠ **只有这一步会真的重新绑端口** |
| `GET /api/qq-list` / `POST|GET /api/global-config` / `GET /api/logs*` / `GET /api/system*` | 其余杂项 | |

**配置不热加载。** `index.mjs` 里没有 `fs.watch` / `chokidar` —— 改磁盘上的
`onebot_<uin>.json` 不会有任何反应，只有走 WebUI 的 saveConfig 那条路才会 `reloadConfig`。
（这条踩过：改了文件、等了半天，网关毫无变化。）

---

## 4. 两条关键实测结论（别再重新试）

1. **`refresh` 不重新绑端口。** 把抢占的号 unload 掉之后，机器人号的适配器**仍然**是
   `degraded`（等了 15s+ 没变）。所以「摘掉抢占者」这一步**不解决问题**。
2. **`save_config(uin, config(uin))` 才会重新绑端口。** 把配置原样读出来、原样存回去
   （内容一个字没改），网关回一句 configuration applied，适配器从 `degraded` → `ok`。
   这就是唯一有效的杠杆。

3. **`GET /api/processes` 里的 `uin` 字段对「没被挂上的进程」报 0** —— 而我们要找的
   恰恰就是「没挂上的那个」。所以枚举登录账号要一律走 `probe-login`，不看 `processes.uin`
   （`snowluma.py:logged_in()` 就是这么写的）。

---

## 5. 于是「自动换到机器人号」= 四步

写死在 `backend/app/services/snowluma.py::ensure_bot_account()`：

```
① probe-login 列出「现在登着哪些号」（uin → pid）
   —— 机器人号不在里面就直接说清楚「它没登录，先登它」，不做无谓动作
② 从 /api/connections 找出「谁占着 3001」（ws 适配器状态 ok 的那个号）
   —— 已经是机器人号 → 直接成功，什么都不动
③ unload 掉抢占的**别的**号（它在 SnowLuma 那边下车，端口松手）
④ 把机器人号的配置原样 POST 回 /api/config/<机器人号>   ← 只有这步会重新绑端口
   然后轮询 /api/connections 最多 10 秒，确认机器人号真的 ok 了
```

全程 `ensure_bot_account()` **不抛异常**：网关开起来了就算成功，换号只是锦上添花 ——
调用方要的是「能开就开、开不了说清楚为什么」，不是 500。

---

## 6. 它接进小窝的形状

**设置**（`features_registry.py` → `qq_bridge` → 分组「接入方式」）：

| 键 | 说明 |
|---|---|
| `gateway.folder` | SnowLuma 目录（默认 `D:\SnowLuma`） |
| `gateway.webui_port` | WebUI 端口，默认 `5099` |
| `gateway.password` | **`secret: True`** —— SnowLuma 网页登录密码，**绝不进日志、绝不进 git** |

**后端**（`backend/app/routers/nest.py`）：

- `_setting()` 读设置；`_live_uin()` 探「现在挂的是哪个号」（带 `_UIN_CACHE` / `_UIN_TTL=6.0`，
  因为前端每 4 秒轮询一次状态，每次都真去问 WebUI 太浪费）；
- `_gateway_status` 返回 `uin`（实际挂的）/ `expected_uin`（应挂的机器人号）/ `has_password`；
- `start_gateway` 在端口起来后调 `_auto_swap_bot()` 自动换号；
- `POST /features/{id}/gateway/claim` = 手动再换一次（号是后来才登上的时候用）。

**前端**（`QqBridgePanel.tsx`）：

- 状态条上一个 `挂的 QQ <uin>` 徽标，对不上就标红 `≠ 机器人号` + 一条黄色横幅；
- 号不对时**不自动开桥** —— 那等于用错的号去群里说话；
- 有密码 → 显示「↻ 换给机器人号」按钮；没密码 → 提示去填「接入方式 → 网关网页密码」。

---

## 7. 自己给自己挖的坑（也记一下，防复发）

- **`set_feature_settings()` 是「整份覆盖写」**（`backend/app/db.py`），不是合并。
  而且 `PUT /api/nest/features/{id}/settings` 的 body 键名是 **`values`**（`class SettingsIn`），
  不是 `data` —— 用 `data` 发过去会**静默什么都不做**（回 `saved keys: []`）。
  我拿「前端那份表单」（当时是空的）整份 PUT 上去，把 `onebot.self_id` / `access_token` /
  `allow.groups` / `owner.qq` / `persona.character_id` **一起清成了空**。
  想改单个键，**必须先把当前值读出来合并再整份写**。
- **功能的 `apply_remote()` 是无条件覆盖的**（`qqbridge/config.py`）：`REMOTE_KEYS` 里登记过的键，
  前端设置里是空字符串也会照盖到本地 `config.json` 上。唯一有「空值不覆盖」保护的是
  `accounts` 那个整表键（空表跳过）。所以「库里被清空」= 桥上立刻失去身份，`config.json`
  明明还是好的也没用。
- **sqlite 删行 / 改行只是把页标成空闲，不擦字节。** 被覆盖掉的旧值能直接从
  `backend/data/xiaotangren.db` 里扫回来：找 `qq_bridge{` 标记，从 `{` 开始
  **交给 `json.JSONDecoder().raw_decode()`**（**不要自己数括号配平** —— 空闲页的字节是乱的，
  碎片的引号/大括号会把配平带偏，实测有一版配错在 char 1241）。旧行常被**拦腰截断**
  （有一版正好断在 `…"m`），这时退一步：从断点往前找最后一个 `,`，补 `}` 再解，
  断点**之前**的字段全是好的 —— 要捞的正是那些。
  还原的正确姿势是**以当前行为底、只补「旧的有值而当前为空」的键**，不要整份换回去
  （会顺手把新加的 `gateway.*` 冲掉）。

---

## 8. 现在的状态

- 网关：`D:\SnowLuma`，`pid` 由外部 launcher 起（`started_by_nest: false`），占 3001 + 5099。
- `GET /api/nest/features/qq_bridge/gateway` 返回
  `uin: "553350415"` / `expected_uin: "553350415"` / `has_password: true`。
- 桥起来那行日志是 `✅ 和 QQ 网关连上了，我是 芳月诗音（553350415）` —— **身份对了**。
- 白名单只有群 `338645902`。