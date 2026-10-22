"""日粒度原文归档。SQLite 保存排序索引，Markdown 是可读导出，附件仍在本地媒体库。"""
from __future__ import annotations

import hashlib
import json
import re
import threading
from datetime import datetime, timedelta, timezone

from .. import db

LOCAL = timezone(timedelta(hours=8))
_lock = threading.RLock()


def timestamp(value: str = "") -> str:
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00")) if value else datetime.now(timezone.utc)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)  # SQLite datetime('now')
    except (ValueError, TypeError):
        dt = datetime.now(timezone.utc)
    return dt.astimezone(LOCAL).isoformat(timespec="seconds")


def table() -> None:
    with db._tx() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS memory_source_messages (
            id TEXT NOT NULL, persona_id TEXT NOT NULL, session_id TEXT NOT NULL,
            feature_id TEXT NOT NULL, day TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL,
            PRIMARY KEY(id,persona_id,session_id,feature_id))""")


def safe(value: str) -> str:
    sanitized = re.sub(r'[^\w@.-]', '_', value, flags=re.U).strip('.')
    if sanitized != value or len(sanitized) > 100:
        return (sanitized[:80] or '未命名') + '-' + hashlib.sha256(value.encode()).hexdigest()[:10]
    return sanitized or '未命名'


def relative(persona: str, session: str, day: str, feature: str = "") -> str:
    from .memory_workflow import SOURCE
    return f"{SOURCE}/{safe(persona)}/{safe(feature or '日常')}/{safe(session)}/{day}.md"


def read_day(persona: str, session: str, day: str, feature: str = "") -> list[dict]:
    table()
    with db._tx() as conn:
        rows = conn.execute("""SELECT payload FROM memory_source_messages
            WHERE persona_id=? AND session_id=? AND day=? AND feature_id=?
            ORDER BY timestamp, COALESCE(json_extract(payload,'$.seq'),rowid), id""", (persona, session, day, feature)).fetchall()
    return [json.loads(r[0]) for r in rows]


def render(persona: str, session: str, day: str, feature: str = "") -> str:
    from . import memory_workflow as work
    rel = relative(persona, session, day, feature)
    messages = read_day(persona, session, day, feature)
    path = work.root() / rel
    if not messages:
        path.unlink(missing_ok=True)
        return rel
    names = {c['id']: c.get('name', c['id']) for c in db.list_characters()}
    profile = db.get_profile(persona) or {}
    lines = [f"# {day} · {session}", "", "时间：北京时间（UTC+08:00），原始记录精确到秒。附件链接指向本地原文件。", ""]
    for m in messages:
        who = profile.get('name') or persona if m.get('role') == 'user' else names.get(m.get('character_id'), '小糖人')
        content = str(m.get('content') or '')
        if m.get('segments'):
            content = '\n\n'.join(f"**{p.get('speaker', '小糖人')}**：{p.get('text', '')}" for p in m['segments'])
        lines.extend([f"## {m['created_at'][11:19]} · {who}", "", content, ""])
        image = m.get('image') or ''
        if image and not image.startswith('data:'):
            lines.extend([f"[{'视频' if m.get('image_source') == 'video' else '图片'}原文件]({image})", ""])
        elif image:
            lines.extend(['[内联图片：原始字节保留在消息库]', ''])
        for url in m.get('frames') or []:
            lines.append(f"[视频帧]({url})")
    work.write(path, {'persona_id': persona, 'session_id': session, 'day': day,
                     'feature_id': feature, 'message_count': len(messages)}, '\n'.join(lines))
    return rel


def archive(messages: list[dict], persona: str, session: str, feature: str = "") -> str:
    table()
    days = set()
    with _lock:
        for incoming in messages:
            # 使用落库时间和附件字段，避免提炼请求里的裁剪消息覆盖原始内容。
            saved = db.get_message(incoming['id']) if incoming.get('id') else None
            m = {**incoming, **(saved or {})}
            m['created_at'] = timestamp(m.get('created_at') or '')
            day = m['created_at'][:10]
            days.add(day)
            key = str(m.get('id') or hashlib.sha256(json.dumps(
                [m.get('role'), m.get('content'), m.get('image'), m.get('created_at')[:10]], ensure_ascii=False).encode()).hexdigest())
            m['id'] = key
            # 大块字节不复制到索引；原始消息表和附件库仍保留全量。
            payload = {**m}
            if str(payload.get('image') or '').startswith('data:'):
                payload['image'] = 'data:[内联图片保留在消息库]'
            with db._tx() as conn:
                conn.execute('INSERT OR REPLACE INTO memory_source_messages VALUES (?,?,?,?,?,?,?)',
                             (key, persona, session, feature, day, m['created_at'], json.dumps(payload, ensure_ascii=False)))
        for day in sorted(days):
            render(persona, session, day, feature)
    from . import activity_memory
    activity_memory.from_messages(messages, persona, session, [], feature or 'core')
    return relative(persona, session, max(days), feature) if days else ''


def remove(ids: list[str]) -> None:
    """存储管理删除原文时同步删除日归档和清洗副本，正式记忆由用户单独管理。"""
    if not ids:
        return
    from . import activity_memory
    activity_memory.remove_messages(ids)
    from . import memory_workflow as work
    table()
    with _lock:
        with db._tx() as conn:
            marks = ','.join('?' for _ in ids)
            affected = conn.execute(f'SELECT DISTINCT persona_id,session_id,day,feature_id FROM memory_source_messages WHERE id IN ({marks})', ids).fetchall()
            conn.execute(f'DELETE FROM memory_source_messages WHERE id IN ({marks})', ids)
        for persona, session, day, feature in affected:
            rel = render(persona, session, day, feature)
            cleaned = work.root() / rel.replace(work.SOURCE, '01_清洗层', 1)
            cleaned.unlink(missing_ok=True)
        # 旧版备份也不能悄悄留着用户要求删除的原始消息。
        for path in (work.root() / '.旧版源记忆备份').glob('*.md'):
            meta, body = work.document(path.read_text(encoding='utf-8-sig'))
            try:
                old = json.loads(re.sub(r'^```json\s*|\s*```$', '', body.strip()))
            except ValueError:
                continue
            remaining = [m for m in old if m.get('id') not in ids]
            if len(remaining) != len(old):
                if remaining:
                    work.write(path, meta, '```json\n' + json.dumps(remaining, ensure_ascii=False, indent=2) + '\n```')
                else:
                    path.unlink()


def migrate_legacy() -> int:
    """旧散片移入备份，同时按本地数据库原始时间合并；不改记忆结论。"""
    from . import memory_workflow as work
    old = work.root() / work.SOURCE / '对话归档'
    if not old.is_dir():
        return 0
    count = 0
    aliases = {}
    for path in list(old.glob('*.md')):
        meta, body = work.document(path.read_text(encoding='utf-8-sig'))
        try:
            rows = json.loads(re.sub(r'^```json\s*|\s*```$', '', body.strip()))
        except ValueError:
            continue
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not row.get('id'):
                with db._tx() as conn:
                    saved = conn.execute('SELECT rowid,* FROM messages WHERE session_id=? AND role=? AND content=? ORDER BY created_at LIMIT 1',
                                         (meta.get('session_id', ''), row.get('role', 'user'), row.get('content', ''))).fetchone()
                if saved:
                    row.update(db._row_to_message(saved))
            if not row.get('created_at'):
                row['created_at'] = meta.get('created_at', '')
        rel = archive(rows, meta.get('persona_id', 'dalaoda'), meta.get('session_id', ''), meta.get('feature_id', ''))
        aliases[path.relative_to(work.root()).as_posix()] = rel
        target = work.root() / '.旧版源记忆备份' / path.name
        target.parent.mkdir(parents=True, exist_ok=True)
        path.replace(target)
        count += 1
    if aliases:
        index = work.root() / '.旧版源记忆备份' / '路径索引.json'
        old_aliases = json.loads(index.read_text(encoding='utf-8')) if index.exists() else {}
        index.write_text(json.dumps({**old_aliases, **aliases}, ensure_ascii=False, indent=2), encoding='utf-8')
    return count
