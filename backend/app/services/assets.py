"""User-owned image assets, independent of optional presentation packages."""
from __future__ import annotations

import hashlib
import base64
import binascii
import io
import json
import os
import re
import sqlite3
import tempfile
import time
from contextlib import closing
from pathlib import Path

from PIL import Image

SCHEMA = '''CREATE TABLE IF NOT EXISTS user_assets (
    id TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    extension TEXT NOT NULL,
    size INTEGER NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)'''
FORMATS = {'PNG': ('image/png', 'png'), 'JPEG': ('image/jpeg', 'jpg'),
           'WEBP': ('image/webp', 'webp'), 'GIF': ('image/gif', 'gif')}
MAX_BYTES = 20 * 1024 * 1024
PREFIX = '/api/assets/'


def resource_url(identifier: str, mime: str) -> str:
    # Keep the existing portrait hover/first-frame behavior for animated GIFs.
    return f'{PREFIX}{identifier}/content' + ('?format=gif' if mime == 'image/gif' else '')


def asset_path(root: Path, identifier: str, extension: str) -> Path:
    if not re.fullmatch(r'[0-9a-f]{64}', identifier) or extension not in {'png', 'jpg', 'webp', 'gif'}:
        raise ValueError('Invalid asset identifier')
    directory = root / 'assets'
    path = directory / f'{identifier}.{extension}'
    if directory.is_symlink() or path.is_symlink() or path.resolve().parent != directory.resolve():
        raise ValueError('Invalid asset storage path')
    return path


def inspect_image(content: bytes) -> tuple[str, str]:
    if not content or len(content) > MAX_BYTES:
        raise ValueError('图片不能为空，且不能超过 20 MB')
    try:
        with Image.open(io.BytesIO(content)) as image:
            kind = image.format
            if image.width * image.height > 40_000_000:
                raise ValueError('图片像素过大')
            image.verify()
        mime, extension = FORMATS[kind]
    except (OSError, KeyError, Image.DecompressionBombError) as error:
        raise ValueError('仅支持有效的 PNG、JPEG、WebP 或 GIF 图片') from error
    return mime, extension


def register(conn, root: Path, content: bytes, source: str) -> dict:
    mime, extension = inspect_image(content)
    identifier = hashlib.sha256(content).hexdigest()
    path = asset_path(root, identifier, extension)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if hashlib.sha256(path.read_bytes()).hexdigest() != identifier:
            raise ValueError('已有资源校验失败，请先恢复备份')
    else:
        fd, temporary = tempfile.mkstemp(prefix='.import-', dir=path.parent)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    conn.execute('INSERT OR IGNORE INTO user_assets(id,mime,extension,size,source) VALUES (?,?,?,?,?)',
                 (identifier, mime, extension, len(content), source))
    return dict(id=identifier, url=resource_url(identifier, mime), mime=mime, size=len(content))


def references(value, location=''):
    """Report image fields, including form overrides, without scanning prompt text."""
    if isinstance(value, dict):
        for key, item in value.items():
            label = f'{location}.{key}' if location else key
            if key in ('avatar', 'portrait') and isinstance(item, str):
                yield label, item
            elif isinstance(item, (dict, list)):
                yield from references(item, label)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from references(item, f'{location}[{index}]')


def _replace(value, mapping):
    if isinstance(value, dict):
        return {k: mapping.get(v, v) if k in ('avatar', 'portrait') and isinstance(v, str)
                else _replace(v, mapping) for k, v in value.items()}
    if isinstance(value, list):
        return [_replace(v, mapping) for v in value]
    return value


def local_image_bytes(url: str, root: Path) -> tuple[bytes | None, str]:
    if url.startswith('data:image/'):
        if len(url) > 28_000_000:
            raise ValueError('图片不能超过 20 MB')
        try:
            header, encoded = url.split(',', 1)
            if header not in {f'data:{mime};base64' for mime, _ in FORMATS.values()}:
                raise ValueError('图片编码不支持')
            return base64.b64decode(encoded, validate=True), 'embedded-image-import'
        except (binascii.Error, ValueError) as error:
            raise ValueError('图片编码无效') from error
    if url.startswith('/characters/'):
        filename = url[len('/characters/'):]
        if not re.fullmatch(r'[A-Za-z0-9_.-]+\.(?:png|jpg|jpeg|webp|gif)', filename):
            return None, 'unsupported legacy path'
        source = next((directory / filename for directory in legacy_roots(root)
                       if not directory.is_symlink() and not (directory / filename).is_symlink()
                       and (directory / filename).is_file()), None)
    elif url.startswith('/api/files/'):
        directory = root / 'attachments'
        source = directory / url[len('/api/files/'):]
        if directory.is_symlink() or source.is_symlink() or not source.resolve().is_relative_to(directory.resolve()):
            return None, 'unsupported attachment path'
    else:
        return None, ''
    if source is None or not source.is_file():
        return None, 'source missing'
    if source.stat().st_size > MAX_BYTES:
        raise ValueError('角色图片超过 20 MB，迁移已停止')
    return source.read_bytes(), 'legacy-character-import' if url.startswith('/characters/') else 'attachment-image-import'


def persist_document(conn, root: Path, data: dict, strict: bool = False) -> tuple[dict, list[dict]]:
    mapping = {}
    missing = []
    for field, url in references(data):
        if url in mapping:
            continue
        try:
            content, source = local_image_bytes(url, root)
            if content is not None:
                mapping[url] = register(conn, root, content, source)['url']
            elif source:
                missing.append(dict(field=field, reason=source))
        except ValueError as error:
            if strict:
                raise
            missing.append(dict(field=field, reason=str(error)))
    return _replace(data, mapping), missing


def prepare_profile(data: dict) -> dict:
    """Normalize editor uploads before saving a character or user identity."""
    from .. import db
    with db._tx() as conn:
        conn.execute(SCHEMA)
        updated, _ = persist_document(conn, db.DATA_DIR, data, strict=True)
    return updated


def legacy_roots(root: Path) -> list[Path]:
    from .. import theme_feature
    from ..data_paths import PROJECT_ROOT
    # Plain file access also works when the theme is disabled; never import its code.
    return [theme_feature.FEATURE_DIR / 'public/characters',
            root / 'uninstalled-plugins/xiaotangren-theme/public/characters',
            PROJECT_ROOT / 'frontend/public/characters']


def preserve_profile_art(conn, root: Path) -> dict:
    conn.execute(SCHEMA)
    changed = 0
    missing = []
    for table in ('characters', 'profiles'):
        for row in conn.execute(f'SELECT id,data FROM {table}').fetchall():
            data = json.loads(row['data'])
            updated, unresolved = persist_document(conn, root, data)
            missing.extend(dict(kind=table, owner_id=row['id'], **item) for item in unresolved)
            if updated != data:
                conn.execute(f'UPDATE {table} SET data=? WHERE id=?',
                             (json.dumps(updated, ensure_ascii=False), row['id']))
                changed += 1
    return dict(updated=changed, unresolved=missing)


def backup_before_migration(database: Path, root: Path):
    """One consistent snapshot before replacing any existing legacy image URLs."""
    if not database.is_file():
        return
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)) as source:
        tables = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        legacy = [(table, row[0], row[1]) for table in ('characters', 'profiles') if table in tables
                  for row in source.execute(f"SELECT id,data FROM {table} WHERE data LIKE '%/characters/%' OR data LIKE '%/api/files/%' OR data LIKE '%data:image/%' ORDER BY id")]
        if not legacy:
            return
        folder = root / 'backups'
        folder.mkdir(parents=True, exist_ok=True)
        fingerprint = hashlib.sha256(json.dumps(legacy, ensure_ascii=False).encode()).hexdigest()[:24]
        saved = folder / f'before-character-assets-{fingerprint}.db'
        if saved.is_file():
            with closing(sqlite3.connect(saved.resolve().as_uri() + '?mode=ro', uri=True)) as check:
                if check.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError('已有迁移备份损坏，迁移已停止')
            return
        fd, temporary = tempfile.mkstemp(prefix='before-character-assets-', suffix='.db', dir=folder)
        os.close(fd)
        try:
            with closing(sqlite3.connect(temporary)) as target:
                started = time.monotonic()
                def progress(status, remaining, total):
                    if time.monotonic() - started > 45:
                        raise TimeoutError('迁移前数据库备份超时，原库未修改')
                source.backup(target, pages=128, progress=progress)
                if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError('迁移前备份校验失败')
            os.replace(temporary, saved)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise


def inventory(conn, root: Path) -> list[dict]:
    uses = {}
    for table in ('characters', 'profiles'):
        for row in conn.execute(f'SELECT id,data FROM {table}'):
            data = json.loads(row['data'])
            for field, url in references(data):
                uses.setdefault(url, []).append(dict(kind=table, owner_id=row['id'],
                                                      name=data.get('name', row['id']), field=field))
    rows = []
    for row in conn.execute('SELECT * FROM user_assets ORDER BY created_at DESC,id'):
        item = dict(row)
        item['url'] = resource_url(item['id'], item['mime'])
        item['references'] = uses.get(item['url'], [])
        item['available'] = asset_path(root, item['id'], item['extension']).is_file()
        rows.append(item)
    return rows


def legacy_inventory(conn) -> list[dict]:
    return [dict(kind=table, owner_id=row['id'], name=data.get('name', row['id']), field=field,
                 url='内嵌图片' if url.startswith('data:') else url)
            for table in ('characters', 'profiles')
            for row in conn.execute(f'SELECT id,data FROM {table}')
            for data in [json.loads(row['data'])]
            for field, url in references(data) if url.startswith(('/characters/', '/api/files/', 'data:image/'))]
