"""01 → 清洗层：只精简派生文本，绝不改写原始记录或伪造附件内容。"""
from __future__ import annotations

import html
import re

from . import memory_sources as sources

_TECHNICAL = re.compile(r'debug|提示词|PROHIBITED_CONTENT|测试.{0,15}(识图|看|模型)|'
                        r'(你们|你|大家).{0,10}看.{0,12}(图|截图).{0,12}(吗|什么|没)|'
                        r'再看看.{0,8}(好不好|好吗)|^(图图|截图)[？?]$', re.I)


def clean_text(text: str, assistant: bool = False) -> str:
    text = html.unescape(text or '')
    text = re.sub(r'!?(\[[^\]]*\])\((?:https?://|/api/)[^)]+\)', r'\1', text)
    text = re.sub(r'<[^>\n]+>', '', text)
    text = re.sub(r'🔈\s*朗读|🧠\s*(收入候选|待审核)|✎\s*编辑|重新生成|&#x20;', '', text)
    if assistant:
        text = re.sub(r'（[^（）]*）|\([^()\n]{0,600}\)', '', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    return re.sub(r'[ \t]+', ' ', text).strip()


def clean(messages: list[dict], name_of: dict[str, str], user_name: str = '用户') -> list[dict]:
    out = []
    for m in messages:
        content = clean_text(str(m.get('content') or ''), m.get('role') == 'assistant')
        # 识图调试轮不属于生活事件；图片仍保存在 01，不会因过滤调试而删除。
        if _TECHNICAL.search(content):
            continue
        timestamp = sources.timestamp(m.get('created_at') or '')
        speaker = user_name if m.get('role') == 'user' else name_of.get(m.get('character_id'), '小糖人')
        parts = m.get('segments') if m.get('role') == 'assistant' else None
        if parts:
            content = '\n'.join(f"{p.get('speaker', '小糖人')}：{clean_text(p.get('text', ''), True)}" for p in parts)
        if content or m.get('image'):
            out.append({'id': m.get('id', ''), 'role': m.get('role', 'user'), 'speaker': speaker,
                        'created_at': timestamp, 'content': content, 'image': m.get('image', ''),
                        'frames': m.get('frames') or [], 'image_source': m.get('image_source', '')})
    return sorted(out, key=lambda m: m['created_at'])


def formatted(messages: list[dict]) -> str:
    lines = []
    for m in messages:
        lines.append(f"[{m['created_at'][:19]}] {m['speaker']}（{m['role']}）：{m['content']}")
        if m.get('image'):
            lines.append('[含本地视频，关键帧另附]' if m.get('image_source') == 'video' else '[含本地图片，另附原图；未附图时内容未知]')
    return '\n'.join(lines)


def chunks(messages: list[dict], budget: int = 12000) -> list[list[dict]]:
    """整天分批，长消息也分块，禁止只取尾部丢失当天早些时候的事件。"""
    groups, current, size, image_count = [], [], 0, 0
    for m in messages:
        text = m['content']
        pieces = [text[i:i + budget - 300] for i in range(0, len(text), budget - 300)] or ['']
        for index, part in enumerate(pieces):
            cost = len(part) + 200
            images = min(8, len(m.get('frames') or ([m['image']] if m.get('image') else []))) if index == 0 else 0
            if current and (size + cost > budget or image_count + images > 8):
                groups.append(current); current, size, image_count = [], 0, 0
            piece = {**m, 'content': part}
            if index:
                piece.update(image='', frames=[])
            current.append(piece); size += cost; image_count += images
    if current:
        groups.append(current)
    return groups


def export(messages: list[dict], persona: str, session: str, day: str, feature: str = '') -> str:
    from . import memory_workflow as work
    rel = sources.relative(persona, session, day, feature).replace(work.SOURCE, '01_清洗层', 1)
    work.write(work.root() / rel, {'day': day, 'persona_id': persona, 'session_id': session,
                                 'source': sources.relative(persona, session, day, feature)}, formatted(messages))
    return rel
