"""SnowLuma 网关的 WebUI 小客户端 + 「让机器人号独占端口」那件事。

**为什么需要它**（这一块是真金白银摸出来的，别删注释）：

SnowLuma 不是自己登录 QQ，而是**注入到一个已经在跑的 QQ 进程**里。它每个 QQ 号存一份配置
`config/onebot_<号>.json`，而**两份配置都写死同一对端口**（http 3000 / ws 3001）。于是：

- 同时登两个号 → autoload 把两个都挂上 → 抢同一对端口 → **先挂上的那个赢**，
  另一个 `listen EADDRINUSE` 变 degraded（网关日志里的 `network startup degraded: UIN=… failures=2`）。
- 赢的多半是**大号**（先登录、先被发现），于是桥连上去一切正常，说话身份却是错的。
- SnowLuma **没有**任何环境变量 / 参数能指定「只挂某个号」（只有 `SNOWLUMA_HOOK_AUTOLOAD` /
  `_ALL` 这类总开关），所以「指定号」只能从它的 WebUI API 下手。

WebUI API（`127.0.0.1:5099`，Bearer token）有用的几条：
    POST /api/login                  {"password": …} → {"token": …}（**口令只走内存，不进日志**）
    GET  /api/processes              → 每个 QQ.exe 的 pid / uin / injected / status
    GET  /api/processes/:pid/probe-login → 这个 pid 到底是哪个号（**未注入的也能问**）
    POST /api/processes/:pid/unload  → 把某个号摘下来，端口它就放手了
    POST /api/processes/:pid/refresh → 重新挂上（**光 refresh 不会重新绑端口**，实测无效）
    GET  /api/connections            → 每个号的每个适配器 ok / degraded
    GET  /api/config/:uin            → 这个号的 OneBot 配置
    POST /api/config/:uin            → 存配置并**重新应用适配器**（= 重新绑端口，实测有效）

所以「自动换到机器人号」的完整动作是：
    ① 探出当前端口被**谁**占着（connections 里那个号的 ws 适配器是 ok）；
    ② 不是机器人号 → 把它 unload（这个号退出 OneBot，端口释放）；
    ③ 把**机器人号**的配置原样 POST 回去 —— 这一步才会真的重新绑端口（refresh 不行）；
    ④ 复查 connections，确认机器人号 ok 了。
"""

from __future__ import annotations

import hashlib
import time

import httpx

DEFAULT_WEBUI_PORT = 5099

# token 缓存：{base_url|口令指纹: (token, 到期时刻)}。
# 面板每 4 秒轮询一次网关状态，每次都重新登录太浪费；SnowLuma 的 token 是 24h 有效的。
_TOKENS: dict[str, tuple[str, float]] = {}
_TOKEN_TTL = 600.0


class SnowLumaError(RuntimeError):
    """WebUI 连不上 / 口令不对 / 接口报错 —— 一律带一句人话，不当 500 抛给用户。"""


def _fingerprint(password: str) -> str:
    """口令指纹（只用于缓存 key，**不是**口令本身、也不可逆）。"""
    return hashlib.sha256(password.encode("utf-8")).hexdigest()[:12]


class SnowLumaClient:
    """一个 WebUI 客户端。所有调用都短超时 —— 网关在本机，慢就是出问题了。"""

    def __init__(self, password: str, port: int = DEFAULT_WEBUI_PORT,
                 host: str = "127.0.0.1", timeout: float = 8.0) -> None:
        self.base = f"http://{host}:{int(port)}"
        self.password = password
        self.timeout = timeout
        self._token = ""
        self._client: httpx.Client | None = None

    # ---- 底层 ----
    def __enter__(self) -> "SnowLumaClient":
        self._client = httpx.Client(base_url=self.base, timeout=self.timeout)
        return self

    def __exit__(self, *exc: object) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    def _http(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(base_url=self.base, timeout=self.timeout)
        return self._client

    def login(self) -> str:
        """拿 token。命中缓存就直接用。"""
        cache_key = f"{self.base}|{_fingerprint(self.password)}"
        hit = _TOKENS.get(cache_key)
        now = time.time()
        if hit and hit[1] > now:
            self._token = hit[0]
            return self._token
        try:
            r = self._http().post("/api/login", json={"password": self.password})
        except httpx.HTTPError as exc:
            raise SnowLumaError(f"连不上网关网页（{self.base}）：{exc}") from exc
        if r.status_code == 401:
            raise SnowLumaError("网关网页密码不对 —— 在「接入方式 → 网关网页密码」里改一下")
        if r.status_code >= 400:
            raise SnowLumaError(f"网关网页登录失败（HTTP {r.status_code}）")
        try:
            data = r.json()
        except ValueError as exc:
            raise SnowLumaError("网关网页登录返回的不是 JSON") from exc
        token = str(data.get("token") or "")
        if not token:
            raise SnowLumaError("网关网页登录没给 token")
        self._token = token
        _TOKENS[cache_key] = (token, now + _TOKEN_TTL)
        return token

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        if not self._token:
            self.login()
        headers = {"Authorization": f"Bearer {self._token}"}
        try:
            r = self._http().request(method, path, headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise SnowLumaError(f"连不上网关网页（{path}）：{exc}") from exc
        if r.status_code == 401:
            # token 可能过期/被换口令顶掉 —— 重新登录再来一次。
            self._token = ""
            self.login()
            headers = {"Authorization": f"Bearer {self._token}"}
            r = self._http().request(method, path, headers=headers, json=body)
        if r.status_code >= 400:
            raise SnowLumaError(f"{path} 失败（HTTP {r.status_code}）")
        try:
            return r.json()
        except ValueError as exc:
            raise SnowLumaError(f"{path} 返回的不是 JSON") from exc

    # ---- 业务 ----
    def processes(self) -> list[dict]:
        return list((self._call("GET", "/api/processes").get("list") or []))

    def connections(self) -> list[dict]:
        return list((self._call("GET", "/api/connections").get("list") or []))

    def config(self, uin: str | int) -> dict:
        return dict((self._call("GET", f"/api/config/{uin}").get("config") or {}))

    def save_config(self, uin: str | int, config: dict) -> dict:
        """存配置并重新应用适配器 —— **这一步才会真的重新绑端口**。"""
        return dict(self._call("POST", f"/api/config/{uin}", config))

    def probe_login(self, pid: int) -> dict:
        return dict((self._call("GET", f"/api/processes/{int(pid)}/probe-login").get("info") or {}))

    def unload(self, pid: int) -> dict:
        return dict(self._call("POST", f"/api/processes/{int(pid)}/unload"))

    def refresh(self, pid: int) -> dict:
        return dict(self._call("POST", f"/api/processes/{int(pid)}/refresh"))


# ---- 端口归属 ----

def _ws_ports(config: dict) -> list[tuple[str, int]]:
    """配置里的 WS 服务：(适配器名, 端口)。"""
    out: list[tuple[str, int]] = []
    for srv in ((config.get("networks") or {}).get("wsServers") or []):
        try:
            out.append((str(srv.get("name") or "ws-default"), int(srv.get("port"))))
        except (TypeError, ValueError):
            continue
    return out


def _adapter_ok(conn: dict, name: str) -> bool:
    for a in conn.get("adapters") or []:
        if str(a.get("name")) == name:
            return str(a.get("status")) == "ok"
    return False


def logged_in(client: SnowLumaClient) -> dict[str, int]:
    """现在 QQ 上登着哪些号 → {uin: pid}。

    用 probe-login 而不是 `/api/processes` 里的 uin 字段：后者对**没被挂上**的进程报 0，
    而「没被挂上」正是我们要找的那种号（端口被别人占了，它就是没挂上的那个）。
    """
    out: dict[str, int] = {}
    for p in client.processes():
        if str(p.get("name") or "").lower() != "qq.exe":
            continue
        pid = int(p.get("pid") or 0)
        if pid <= 0:
            continue
        try:
            info = client.probe_login(pid)
        except SnowLumaError:
            continue
        uin = str(info.get("uin") or "")
        if uin and uin != "0":
            out[uin] = pid          # 同一个号的多个 pid：留最后发现的（都能挂，无所谓）
    return out


def _port_owners(client: SnowLumaClient, port: int, accounts: dict[str, int]) -> list[str]:
    """谁正占着这个 WS 端口 —— 它的 ws 适配器状态是 ok。"""
    conns = {str(c.get("uin")): c for c in client.connections()}
    owners: list[str] = []
    for uin in accounts:
        conn = conns.get(uin)
        if not conn:
            continue
        try:
            names = dict((n, p) for n, p in _ws_ports(client.config(uin)))
        except SnowLumaError:
            names = {"ws-default": port}
        for name, p in names.items():
            if int(p) == int(port) and _adapter_ok(conn, name):
                owners.append(uin)
                break
    return owners


def ensure_bot_account(password: str, want_uin: str, port: int,
                       webui_port: int = DEFAULT_WEBUI_PORT,
                       on_log=None) -> dict:
    """让 `want_uin` 独占 `port` 端口。返回 {ok, uin, changed, message, lines}。

    失败**不抛异常**：网关本身开好了就算成功，换号只是锦上添花 —— 调用方要的是
    「能开就开、开不了说清楚为什么」，不是 500。
    """
    lines: list[str] = []

    def log(text: str) -> None:
        lines.append(text)
        if on_log is not None:
            try:
                on_log(text)
            except Exception:  # noqa: BLE001 - 写日志失败不该影响换号
                pass

    want_uin = str(want_uin or "").strip()
    if not want_uin:
        return {"ok": False, "uin": "", "changed": False, "lines": lines,
                "message": "没配「机器人 QQ 号」，不换"}
    try:
        with SnowLumaClient(password, port=webui_port) as client:
            client.login()
            accounts = logged_in(client)
            if want_uin not in accounts:
                who = "、".join(accounts) or "一个都没有"
                log(f"✗ 机器人号 {want_uin} 现在没在 QQ 上登录（现在登着：{who}）")
                return {"ok": False, "uin": "", "changed": False, "lines": lines,
                        "message": f"机器人号 {want_uin} 没登录 —— 先在 QQ 上登它，再点一次"}
            owners = _port_owners(client, port, accounts)
            if want_uin in owners:
                log(f"✓ 端口 {port} 已经是机器人号 {want_uin} 的，不用换")
                return {"ok": True, "uin": want_uin, "changed": False, "lines": lines,
                        "message": f"网关挂的就是机器人号 {want_uin}"}
            log(f"端口 {port} 现在被 {'、'.join(owners) or '（没人）'} 占着，换给 {want_uin}")
            for uin in owners:
                pid = accounts.get(uin, 0)
                if not pid:
                    continue
                # 摘掉抢着端口的号：它在 SnowLuma 那边下车，端口就松手了。
                client.unload(pid)
                time.sleep(0.5)
            # 光 refresh 不会重新绑端口（实测），必须把配置原样存一遍才会重新应用适配器。
            client.save_config(want_uin, client.config(want_uin))
            for _ in range(10):
                time.sleep(1.0)
                if want_uin in _port_owners(client, port, accounts):
                    log(f"✓ 换好了：{port} 现在是 {want_uin} 的")
                    return {"ok": True, "uin": want_uin, "changed": True, "lines": lines,
                            "message": f"已经把 {port} 换给机器人号 {want_uin}"}
            log(f"✗ 摘掉抢占的号之后，{want_uin} 还是没拿到 {port}（等 10 秒）")
            return {"ok": False, "uin": "", "changed": True, "lines": lines,
                    "message": f"换号没成功：{want_uin} 没拿到 {port} —— 看一眼网关日志"}
    except SnowLumaError as exc:
        log(f"✗ 自动换号失败：{exc}")
        return {"ok": False, "uin": "", "changed": False, "lines": lines, "message": str(exc)}
    except Exception as exc:  # noqa: BLE001 - 网关版本换了也不该把「开网关」打崩
        log(f"✗ 自动换号出错：{type(exc).__name__}: {exc}")
        return {"ok": False, "uin": "", "changed": False, "lines": lines,
                "message": f"自动换号出错：{exc}"}


def bot_uin_online(password: str, port: int, webui_port: int = DEFAULT_WEBUI_PORT) -> dict:
    """轻量查一下：现在谁占着 `port`（给状态轮询用）。失败返回空，不抛。"""
    try:
        with SnowLumaClient(password, port=webui_port) as client:
            client.login()
            accounts = logged_in(client)
            owners = _port_owners(client, port, accounts)
            return {"owners": owners, "logged_in": sorted(accounts)}
    except Exception:  # noqa: BLE001 - 只是显示用，查不到就别说话
        return {"owners": [], "logged_in": []}