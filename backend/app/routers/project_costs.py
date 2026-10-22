"""Same-origin gateway to the independent local feature; no ledger logic here."""
import re

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from .. import db
from ..services import project_costs

router = APIRouter(prefix='/project-costs', tags=['project-costs'])
ALLOWED = re.compile(r'^(daily(?:/[a-f0-9]{32})?|health|entries(?:/[a-f0-9]{32})?|imports|bank|candidates/[a-f0-9]{32}|matches(?:/[a-f0-9]{32})?|budget|export)$')


@router.api_route('/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE'])
async def proxy(path: str, request: Request):
    if not ALLOWED.fullmatch(path):
        raise HTTPException(404, '未找到费用接口')
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > 21 * 1024 * 1024:
            raise HTTPException(413, '账单最多 20MB')
    try:
        response = await project_costs.request(request.method, path, db.get_active_persona_id() or 'dalaoda',
            content=bytes(content), content_type=request.headers.get('content-type'), params=request.query_params)
    except httpx.HTTPError:
        raise HTTPException(503, '项目费用服务未连接，请点击「启动费用服务」') from None
    return Response(response.content, status_code=response.status_code,
                    headers={key: value for key, value in response.headers.items()
                             if key in ('content-type', 'content-disposition')})
