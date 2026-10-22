"""Local dashboard access check shared by optional plugins and setup pages."""
import ipaddress
from urllib.parse import urlsplit

from fastapi import HTTPException, Request


def local_dashboard(request: Request):
    host = request.client.host if request.client else ''
    try:
        local = ipaddress.ip_address(host).is_loopback
    except ValueError:
        local = host == 'testclient'
    origin = request.headers.get('origin')
    parsed = urlsplit(origin) if origin else None
    dev_origin = bool(parsed and parsed.scheme in ('http', 'https')
                      and parsed.hostname in ('localhost', '127.0.0.1', '::1') and parsed.port == 5173)
    same_origin = not origin or urlsplit(origin).netloc == request.url.netloc or dev_origin
    if (not local or not same_origin or request.headers.get('x-exploration-dashboard') != '1'
            or request.headers.get('sec-fetch-site', 'same-origin') not in ('same-origin', 'none')):
        raise HTTPException(403, '只能通过本机前端后台操作；聊天回复不授予权限')
