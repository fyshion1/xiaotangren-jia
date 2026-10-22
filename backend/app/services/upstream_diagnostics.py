"""Read-only diagnostics shared by chat transports; never retry generation."""
import re
import httpx

async def upstream_accessibility(options: dict) -> str:
    """失败后只查模型清单，不调用生成接口、不重试聊天、不输出响应正文或密钥。"""
    try:
        headers = {'Authorization': 'Bearer ' + options['api_key']} if options.get('api_key') else {}
        async with httpx.AsyncClient(timeout=httpx.Timeout(5, connect=3), follow_redirects=False) as client:
            response = await client.get(options['base_url'].rstrip('/') + '/models', headers=headers)
        if response.status_code != 200:
            return f'上游可访问性检查：模型清单 HTTP {response.status_code}（不能据此判断生成通道正常）'
        data = response.json()
        rows = data.get('data') if isinstance(data, dict) else None
        if not isinstance(rows, list):
            return '上游入口可达，但未返回标准模型清单；生成通道状态未知'
        present = any(isinstance(row, dict) and row.get('id') == options['model'] for row in rows)
        return ('上游入口可达，模型仍在清单中；该模型生成通道可能仍异常或拥堵' if present else
                '上游入口可达，但清单未列出当前模型；请核对模型名称及账号权限')
    except httpx.HTTPError as exc:
        return f'上游可访问性检查未通过：{type(exc).__name__}；请检查服务商入口、网络或代理'
    except (ValueError, KeyError):
        return '上游入口未返回可用模型清单；生成通道状态未知'


def _upstream_reason(exc: Exception) -> str:
    """只返回固定诊断，禁止把上游响应、密钥或聊天正文写进日志。"""
    message = str(exc).lower()
    if isinstance(exc, httpx.ConnectTimeout):
        return "连接上游超时（网络、代理或服务端入口）"
    if isinstance(exc, httpx.ReadTimeout):
        return "等待上游回复超时（请求可能已处理或计费）"
    if isinstance(exc, httpx.TimeoutException):
        return "上游请求超时"
    if isinstance(exc, httpx.ReadError):
        return "读取上游回复时连接中断（请求可能已处理或计费）"
    if isinstance(exc, httpx.RemoteProtocolError):
        return "上游响应连接或协议异常（请求可能已处理或计费）"
    if isinstance(exc, httpx.RequestError):
        return "无法连接上游模型服务"
    if any(word in message for word in ("prohibited_content", "content_filter", "safety", "blocked")):
        return "上游内容审核拦截"
    status = re.search(r"上游 (\d{3})\b", message)
    if status:
        code = status.group(1)
        hint = {"400": "请求参数或模型不兼容", "401": "API 密钥无效", "403": "访问被拒绝",
                "404": "模型或接口不存在", "429": "额度不足或请求过于频繁"}.get(code, "模型服务异常")
        return f"上游 HTTP {code}（{hint}）"
    return "上游调用异常（请检查模型服务配置）"


