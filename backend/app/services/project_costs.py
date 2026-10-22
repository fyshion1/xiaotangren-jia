"""HTTP adapter; ledger and reconciliation live in the independent feature."""
import json
from datetime import datetime, timedelta, timezone
from typing import Literal

import httpx
from pydantic import Field
from xiaotangren_tools import Arguments, Tool, ToolContext, ToolDenied

BASE_URL = 'http://127.0.0.1:18793'


async def request(method, path, persona, *, content=None, content_type=None, params=None, request_key=None):
    headers = {'X-Costs-Persona': persona}
    if content_type:
        headers['Content-Type'] = content_type
    if request_key:
        headers['X-Idempotency-Key'] = request_key
    async with httpx.AsyncClient(timeout=60, trust_env=False) as client:
        return await client.request(method, BASE_URL + '/' + path, headers=headers, content=content, params=params)


class CostInput(Arguments):
    occurred_on: str = Field(description='付款日期 YYYY-MM-DD，按北京时间；不明确时先追问')
    amount: str = Field(max_length=32, description='实际付款金额字符串，如 100.00；充值只记付款，不叠加调用消耗')
    merchant: str = Field(min_length=1, max_length=160, description='API平台、商户或收款方')
    project: str = Field(default='小糖人之家', min_length=1, max_length=100)
    currency: str = Field(default='CNY', description='CNY、USD、EUR、HKD；不同币种不相加')
    description: str = Field(default='', max_length=1000, description='用途或备注')
    category: str = Field(default='API充值', max_length=80, description='例如API充值、订阅、服务器、域名、其他')
    platform: str = Field(default='unknown', description='wechat、alipay、other、unknown')
    kind: str = Field(default='expense', description='expense 支出；refund 已实际收到的退款')


class QueryInput(Arguments):
    project: str = Field(default='小糖人之家', max_length=100)
    month: str = Field(default='', description='YYYY-MM；留空查全部')


class DailyInput(Arguments):
    kind: Literal['diet', 'exercise'] = Field(description='diet 饮食，exercise 运动')
    content: str = Field(min_length=1, max_length=300, description='只写吃了什么或运动项目，例如牛肉面、骑车；不写地点、时长、热量或评价。照片只写可辨认的食物')
    occurred_on: str = Field(default='', description='YYYY-MM-DD；今天、刚刚、现在留空，由服务按北京时间确定；明确说昨天等才填写对应日期')
    period: Literal['', '凌晨', '上午', '中午', '下午', '晚上'] = Field(default='', description='优先保留用户明确说的时段，尤其“中午”必须填中午，不要改成下午；仅未指定时段的刚刚/现在留空。默认北京时间00-06凌晨、06-12上午、12-14中午、14-18下午、18-24晚上')


class DailyQuery(Arguments):
    month: str = Field(default='', description='YYYY-MM，留空查最近记录，最多500条')


async def daily_record(args: DailyInput, context: ToolContext):
    now = datetime.now(timezone(timedelta(hours=8)))
    payload = args.model_dump()
    payload['occurred_on'] = args.occurred_on or now.date().isoformat()
    payload['period'] = args.period or ('中午' if 12 <= now.hour < 14 else ('凌晨', '上午', '下午', '晚上')[now.hour // 6])
    try:
        response = await request('POST', 'daily', context.actor_id, content=json.dumps(payload, ensure_ascii=False).encode(),
                                 content_type='application/json', request_key=context.call_id or None)
    except httpx.HTTPError:
        raise ToolDenied('饮食运动记录未保存，项目费用服务未连接；不要声称已记录') from None
    if response.is_error:
        raise ToolDenied('饮食运动记录未保存，请核对日期、时段和内容')
    return json.dumps({'saved': True, 'entry': response.json(), 'message': '记录成功，继续自然聊天即可，无需正式播报、额外确认或打卡提示'}, ensure_ascii=False)


async def daily_query(args: DailyQuery, context: ToolContext):
    try:
        response = await request('GET', 'daily', context.actor_id, params=args.model_dump())
    except httpx.HTTPError:
        raise ToolDenied('项目费用服务未连接，无法查询饮食运动记录') from None
    if response.is_error:
        raise ToolDenied('查询失败，请检查月份')
    data = response.json()
    return json.dumps({'items': data['items'][:30], 'shown': min(30, len(data['items'])), 'message': '仅代表已记录内容，不代表完整生活情况'}, ensure_ascii=False)


async def record(args: CostInput, context: ToolContext):
    try:
        response = await request('POST', 'entries', context.actor_id,
            content=args.model_dump_json().encode(), content_type='application/json', request_key=context.call_id or None)
    except httpx.HTTPError:
        raise ToolDenied('项目费用服务未连接，请在糖人小窝打开「项目费用」并启动服务；不要声称已保存') from None
    if response.is_error:
        raise ToolDenied('费用未保存，请核对日期、金额、币种和支付方式')
    return json.dumps({'saved': True, 'entry': response.json(), 'message': '已保存项目费用，尚未与原始账单对账'}, ensure_ascii=False)


async def query(args: QueryInput, context: ToolContext):
    try:
        response = await request('GET', 'entries', context.actor_id, params=args.model_dump())
    except httpx.HTTPError:
        raise ToolDenied('项目费用服务未连接，请在糖人小窝打开「项目费用」并启动服务') from None
    if response.is_error:
        raise ToolDenied('查询失败，请检查月份格式 YYYY-MM')
    data = response.json()
    count = len(data['items'])
    data['items'] = data['items'][:10]
    return json.dumps({**data, 'total_records': count, 'shown_records': len(data['items']),
                       'money_unit': 'amount_cents 和 totals 均以分为单位，各币种独立统计'}, ensure_ascii=False)


def tools():
    return [Tool('project_cost_record', '仅在用户明确要求记项目费用时直接保存实付支出或已到账退款。普通消费聊天不可自动写入；不推测金额或商户。充值付款与API消耗不可重复计费。不进行支付，不确认对账。', CostInput, record, risk='write'),
            Tool('project_cost_query', '查询已记录的项目实付费用、退款、预算和待对账情况；不同币种分别汇总。', QueryInput, query),
            Tool('daily_life_record', '用户已授权随分享记录饮食和运动，不需要说记一下。仅记录用户本人实际发生的吃饭或运动：刚去骑车→运动骑车；正在吃饭的照片→可辨认的食物。只存日期、时段、食物或运动项目。不记录玩耍、工作、地点、时长，不记录计划、假设、他人经历或旧消息。照片看不清食物不猜，单独菜单或食物图片无本人进食语境不记。相同事件不要重复调用。工具成功后自然聊天，不必正式汇报记账。', DailyInput, daily_record, risk='write'),
            Tool('daily_life_query', '查询用户已记录的饮食和运动，日期和时段粒度，不包含费用。', DailyQuery, daily_query)]
