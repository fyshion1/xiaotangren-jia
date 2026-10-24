"""Declarative character packages: preview, import and retain user-owned data."""
from __future__ import annotations

import hashlib
import io
import json
import re
import stat
import time
import uuid
import zipfile
from pathlib import PurePosixPath

from .. import db
from . import assets

MAX_ARCHIVE = 64 * 1024 * 1024
MAX_EXPANDED = 96 * 1024 * 1024
PREVIEW_TTL = 3600
SCHEMA = '''
CREATE TABLE IF NOT EXISTS character_packs (
    id TEXT PRIMARY KEY, version TEXT NOT NULL, name TEXT NOT NULL,
    metadata TEXT NOT NULL, archive_hash TEXT NOT NULL,
    installed INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS character_pack_members (
    pack_id TEXT NOT NULL, template_id TEXT NOT NULL, character_id TEXT NOT NULL,
    imported_version TEXT NOT NULL,
    PRIMARY KEY(pack_id,template_id)
);
'''
FIELDS = set('id name alias emoji about jp birthday age height bloodType constellation personality likes dislikes catchphrase bodyType eyeColor hairstyle hairColor bust hip clothing occupation relationships specialFeatures weight measurements secret weakPoint privateWish signature portrait avatar hiddenFields customFields baseFormName forms activeFormId greeting'.split())
LIST_FIELDS = {'personality', 'likes', 'dislikes', 'hiddenFields'}
ID = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}')


class PackError(ValueError):
    pass


def initialize(conn):
    # Do not executescript inside an existing transaction: SQLite would commit it.
    for statement in SCHEMA.split(';'):
        if statement.strip():
            conn.execute(statement)


def _text(value, label, limit=2000, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise PackError(f'{label}格式不正确或超出长度限制')
    return value


def _profile(value, image_ids, form=False):
    if (not isinstance(value, dict) or set(value) - FIELDS
            or (form and set(value) & {'id','name','activeFormId','baseFormName'})):
        raise PackError('角色包含不支持的字段；本格式仅支持文本、形态和图片')
    result = {}
    for key, item in value.items():
        if key in ('avatar', 'portrait'):
            if item != '' and (not isinstance(item, str) or not item.startswith('asset:') or item[6:] not in image_ids):
                raise PackError('角色图片必须引用包内声明的资源，不接受外链或本机路径')
        elif key in LIST_FIELDS:
            if not isinstance(item, list) or len(item) > 100:
                raise PackError('角色列表字段格式不正确')
            for part in item:
                _text(part, key, 4000)
        elif key == 'customFields':
            if not isinstance(item, list) or len(item) > 100:
                raise PackError('自定义词条格式不正确')
            for part in item:
                if not isinstance(part, dict) or set(part) != {'label', 'value'}:
                    raise PackError('自定义词条只允许 label 和 value')
                _text(part['label'], '词条名称', 100, True)
                _text(part['value'], '词条内容', 20000)
        elif key == 'forms':
            if form or not isinstance(item, list) or len(item) > 20:
                raise PackError('角色形态格式不正确')
            seen = set()
            for part in item:
                if not isinstance(part, dict) or set(part) != {'id', 'name', 'fields'}:
                    raise PackError('形态需要 id、name 和 fields')
                identifier = _text(part['id'], '形态 ID', 80, True)
                if not ID.fullmatch(identifier) or identifier in seen:
                    raise PackError('形态 ID 重复或无效')
                seen.add(identifier)
                _text(part['name'], '形态名称', 100, True)
                _profile(part['fields'], image_ids, form=True)
        else:
            _text(item, key, 50000 if key in ('about', 'greeting') else 4000)
        result[key] = item
    if not form:
        if not ID.fullmatch(_text(result.get('id'), '角色 ID', 80, True)):
            raise PackError('角色 ID 无效')
        _text(result.get('name'), '角色名称', 100, True)
    return result


def parse(content: bytes) -> tuple[dict, dict[str, bytes]]:
    if not content or len(content) > MAX_ARCHIVE:
        raise PackError('角色包不能为空，且不能超过 64 MB')
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            entries = archive.infolist()
            if len(entries) > 100 or sum(i.file_size for i in entries) > MAX_EXPANDED:
                raise PackError('角色包文件数量或展开体积超限')
            names = set()
            for entry in entries:
                path = PurePosixPath(entry.filename)
                mode = entry.external_attr >> 16
                if (entry.filename.casefold() in names or '\\' in entry.filename or ':' in entry.filename
                        or path.is_absolute() or '..' in path.parts or entry.flag_bits & 1
                        or stat.S_ISLNK(mode) or entry.is_dir()
                        or (entry.filename != 'manifest.json' and not re.fullmatch(r'assets/[a-f0-9]{64}\.(png|jpg|webp|gif)', entry.filename))):
                    raise PackError('角色包含重复路径、危险路径或不支持的文件')
                names.add(entry.filename.casefold())
            manifest_entry = archive.getinfo('manifest.json')
            if manifest_entry.file_size > 1024 * 1024:
                raise PackError('角色包清单不能超过 1 MB')
            manifest = json.loads(archive.read(manifest_entry).decode('utf-8-sig'))
            required = {'format', 'format_version', 'id', 'name', 'version', 'author', 'license', 'description', 'characters', 'assets'}
            if not isinstance(manifest, dict) or set(manifest) != required:
                raise PackError('角色包清单字段不完整或包含未知字段')
            if manifest['format'] != 'character-pack' or type(manifest['format_version']) is not int or manifest['format_version'] != 1:
                raise PackError('不支持的角色包格式版本')
            if not ID.fullmatch(_text(manifest['id'], '包 ID', 80, True)):
                raise PackError('角色包 ID 无效')
            for field, limit in [('name',100),('version',40),('author',200),('license',4000),('description',4000)]:
                _text(manifest[field], field, limit, True)
            if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?', manifest['version']):
                raise PackError('版本应为 1.0.0 形式')
            declarations = manifest['assets']
            if not isinstance(declarations, dict) or len(declarations) > 64:
                raise PackError('资源清单格式不正确或数量超限')
            pictures = {}
            declared_names = {'manifest.json'}
            for identifier, value in declarations.items():
                if not re.fullmatch(r'[a-f0-9]{64}', identifier) or not isinstance(value, dict) or set(value) != {'path', 'sha256'}:
                    raise PackError('资源声明格式不正确')
                if value['sha256'] != identifier or not isinstance(value['path'], str):
                    raise PackError('资源校验声明无效')
                entry = archive.getinfo(value['path'])
                if entry.file_size > assets.MAX_BYTES:
                    raise PackError('单张图片不能超过 20 MB')
                image = archive.read(entry)
                _, extension = assets.inspect_image(image)
                if hashlib.sha256(image).hexdigest() != identifier or value['path'] != f'assets/{identifier}.{extension}':
                    raise PackError('资源内容、格式或 SHA-256 不匹配')
                pictures[identifier] = image
                declared_names.add(value['path'])
            if {entry.filename for entry in entries} != declared_names:
                raise PackError('角色包包含未声明的资源')
            characters = manifest['characters']
            if not isinstance(characters, list) or not 1 <= len(characters) <= 32:
                raise PackError('每包需要 1 至 32 个角色')
            manifest['characters'] = [_profile(character, pictures) for character in characters]
            identifiers = [c['id'] for c in manifest['characters']]
            if len(set(identifiers)) != len(identifiers):
                raise PackError('角色 ID 不得重复')
            return manifest, pictures
    except PackError:
        raise
    except (zipfile.BadZipFile, KeyError, UnicodeError, ValueError, TypeError, RuntimeError, NotImplementedError) as error:
        raise PackError('无法读取角色包，请检查 ZIP、清单和图片格式') from error


def _staging_path(token):
    if not re.fullmatch(r'[a-f0-9]{32}', token):
        raise PackError('预览编号无效')
    folder = db.DATA_DIR / 'character-pack-previews'
    if folder.is_symlink() or (folder / f'{token}.zip').is_symlink():
        raise PackError('预览目录异常')
    return folder / f'{token}.zip'


def _read_preview(token):
    path = _staging_path(token)
    if not path.is_file() or time.time() - path.stat().st_mtime > PREVIEW_TTL:
        raise PackError('预览已过期，请重新选择角色包')
    return path.read_bytes()


def character_id(pack_id, template_id):
    return 'pack-' + hashlib.sha256(f'{pack_id}:{template_id}'.encode()).hexdigest()[:24]


def summary(manifest, conn):
    initialize(conn)
    installed = conn.execute('SELECT version,installed FROM character_packs WHERE id=?', (manifest['id'],)).fetchone()
    rows = []
    for character in manifest['characters']:
        member = conn.execute('SELECT character_id FROM character_pack_members WHERE pack_id=? AND template_id=?',
                              (manifest['id'], character['id'])).fetchone()
        identifier = member['character_id'] if member else character_id(manifest['id'], character['id'])
        existing = conn.execute('SELECT 1 FROM characters WHERE id=?', (identifier,)).fetchone() is not None
        rows.append(dict(template_id=character['id'], name=character['name'], about=character.get('about', ''),
                         existing=existing, action='保留已有角色及个人修改' if existing else '新增角色'))
    return {key: manifest[key] for key in ('id','name','version','author','license','description')} | {
        'characters': rows, 'asset_count': len(manifest['assets']),
        'installed_version': installed['version'] if installed and installed['installed'] else None}


def stage(content):
    manifest, _ = parse(content)
    token = uuid.uuid4().hex
    path = _staging_path(token)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Bounded temporary storage; expired previews never become installed packages.
    for old in path.parent.glob('*.zip'):
        if not old.is_symlink() and time.time() - old.stat().st_mtime > PREVIEW_TTL:
            old.unlink(missing_ok=True)
    if sum(p.stat().st_size for p in path.parent.glob('*.zip') if not p.is_symlink()) + len(content) > 256 * 1024 * 1024:
        raise PackError('待确认角色包占用过多，请稍后重试')
    path.write_bytes(content)
    with db._tx() as conn:
        result = summary(manifest, conn)
    return {'api_version':1, 'token':token, 'sha256':hashlib.sha256(content).hexdigest(), **result}


def _apply_images(value, urls):
    if isinstance(value, dict):
        return {k: urls[v[6:]] if k in ('avatar','portrait') and isinstance(v,str) and v.startswith('asset:')
                else _apply_images(v, urls) for k,v in value.items()}
    if isinstance(value,list):
        return [_apply_images(v,urls) for v in value]
    return value


def install(token):
    content = _read_preview(token)
    manifest, pictures = parse(content)
    created, preserved = [], []
    with db._tx() as conn:
        # Acquire the write lock before checking existence and assigning membership.
        conn.execute('BEGIN IMMEDIATE')
        initialize(conn)
        conn.execute(assets.SCHEMA)
        urls = {identifier: assets.register(conn, db.DATA_DIR, image, 'character-pack-import')['url']
                for identifier,image in pictures.items()}
        for character in manifest['characters']:
            identifier = character_id(manifest['id'], character['id'])
            member = conn.execute('SELECT character_id FROM character_pack_members WHERE pack_id=? AND template_id=?',
                                  (manifest['id'],character['id'])).fetchone()
            if member:
                identifier = member['character_id']
            exists = conn.execute('SELECT 1 FROM characters WHERE id=?',(identifier,)).fetchone()
            if exists:
                preserved.append(identifier)
                continue
            from ..seed_profiles import neutral_profile
            profile = neutral_profile(identifier, character['name'])
            # `imported` is the legacy tavern-card flag and hides cards when
            # tavern is disabled. Native packages must not depend on that plugin.
            profile.update(_apply_images(character,urls), id=identifier, characterPackId=manifest['id'])
            conn.execute('INSERT INTO characters(id,data) VALUES (?,?)', (identifier,json.dumps(profile,ensure_ascii=False)))
            conn.execute('INSERT INTO character_pack_members(pack_id,template_id,character_id,imported_version) VALUES (?,?,?,?) ON CONFLICT(pack_id,template_id) DO UPDATE SET character_id=excluded.character_id,imported_version=excluded.imported_version',
                         (manifest['id'],character['id'],identifier,manifest['version']))
            created.append(identifier)
        metadata = {k:manifest[k] for k in ('id','name','version','author','license','description')}
        conn.execute('INSERT INTO character_packs(id,version,name,metadata,archive_hash,installed) VALUES (?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET version=excluded.version,name=excluded.name,metadata=excluded.metadata,archive_hash=excluded.archive_hash,installed=1,updated_at=datetime(\'now\')',
                     (manifest['id'],manifest['version'],manifest['name'],json.dumps(metadata,ensure_ascii=False),hashlib.sha256(content).hexdigest()))
    _staging_path(token).unlink(missing_ok=True)
    return {'api_version':1,'id':manifest['id'],'created':created,'preserved':preserved,
            'message':f'已新增 {len(created)} 个角色，保留 {len(preserved)} 个已有角色及个人修改。'}


def listing():
    with db._tx() as conn:
        initialize(conn)
        result=[]
        for row in conn.execute('SELECT * FROM character_packs ORDER BY updated_at DESC,id'):
            item=json.loads(row['metadata'])
            item.update(installed=bool(row['installed']), characters=[dict(member) for member in conn.execute(
                'SELECT m.template_id,m.character_id,m.imported_version,CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS available FROM character_pack_members m LEFT JOIN characters c ON c.id=m.character_id WHERE pack_id=?',(row['id'],))])
            result.append(item)
        return {'api_version':1,'items':result}


def uninstall(pack_id):
    with db._tx() as conn:
        initialize(conn)
        if not conn.execute('SELECT 1 FROM character_packs WHERE id=?',(pack_id,)).fetchone():
            raise PackError('角色包不存在')
        conn.execute("UPDATE character_packs SET installed=0,updated_at=datetime('now') WHERE id=?",(pack_id,))
    return {'api_version':1,'message':'角色包已卸载。已导入角色、个人修改、图片、聊天和记忆保留。'}


def remove_character(identifier):
    """Explicitly remove a package-created profile, retaining history and assets."""
    with db._tx() as conn:
        initialize(conn)
        if not conn.execute('SELECT 1 FROM character_pack_members WHERE character_id=?', (identifier,)).fetchone():
            raise PackError('该档案不属于角色包，不能通过此入口移除')
        if not conn.execute('DELETE FROM characters WHERE id=?', (identifier,)).rowcount:
            raise PackError('角色档案不存在')
    return {'api_version':1, 'message':'角色档案已移除，图片、聊天和记忆保留；重新导入角色包可恢复同一档案 ID。'}
