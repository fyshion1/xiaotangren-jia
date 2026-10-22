"""HTTP bridge to the independent project-costs feature."""
import httpx
BASE_URL = 'http://127.0.0.1:18793'

async def request(method, path, persona, *, content=None, content_type=None, params=None, request_key=None):
    headers = {'X-Costs-Persona': persona}
    if content_type:
        headers['Content-Type'] = content_type
    if request_key:
        headers['X-Idempotency-Key'] = request_key
    async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
        return await client.request(method, BASE_URL + '/' + path, headers=headers, content=content, params=params)



def __getattr__(name):
    if name.startswith('__'):
        raise AttributeError(name)
    from .. import tool_feature
    return getattr(tool_feature.load('project_tools'), name)
