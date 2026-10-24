"""Versioned resource inventory and upload contract for core and plugins."""
import base64
import binascii
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import db
from ..local_access import local_dashboard
from ..services import assets

router = APIRouter(prefix='/assets', tags=['assets'])


@router.get('', dependencies=[Depends(local_dashboard)])
def listing():
    with db._tx() as conn:
        return {'api_version': 1, 'items': assets.inventory(conn, db.DATA_DIR),
                'legacy': assets.legacy_inventory(conn)}


class Assignment(BaseModel):
    kind: Literal['characters', 'profiles']
    owner_id: str = Field(min_length=1, max_length=128)
    field: Literal['avatar', 'portrait']
    asset_id: str
    expected_url: str | None = None


@router.put('/assignment', dependencies=[Depends(local_dashboard)])
def assign(body: Assignment):
    with db._tx() as conn:
        resource = conn.execute('SELECT * FROM user_assets WHERE id=?', (body.asset_id,)).fetchone()
        if resource is None or not assets.asset_path(db.DATA_DIR, body.asset_id, resource['extension']).is_file():
            raise HTTPException(404, '资源文件不存在')
        row = conn.execute(f'SELECT data FROM {body.kind} WHERE id=?', (body.owner_id,)).fetchone()
        if row is None:
            raise HTTPException(404, '档案不存在')
        data = json.loads(row['data'])
        if data.get(body.field) != body.expected_url:
            raise HTTPException(409, '图片已被其他操作修改，请刷新后重试')
        data[body.field] = assets.resource_url(body.asset_id, resource['mime'])
        conn.execute(f"UPDATE {body.kind} SET data=?,updated_at=datetime('now') WHERE id=?",
                     (json.dumps(data, ensure_ascii=False), body.owner_id))
    return {'api_version': 1, 'url': data[body.field]}


class Upload(BaseModel):
    data: str = Field(min_length=1, max_length=28_000_000)


@router.post('', dependencies=[Depends(local_dashboard)])
def upload(body: Upload):
    """Import image bytes. No remote fetch, arbitrary local path or executable asset."""
    try:
        header, encoded = body.data.split(',', 1)
        if header not in ('data:image/png;base64', 'data:image/jpeg;base64',
                          'data:image/webp;base64', 'data:image/gif;base64'):
            raise ValueError('请使用图片的 base64 data URL')
        content = base64.b64decode(encoded, validate=True)
        with db._tx() as conn:
            item = assets.register(conn, db.DATA_DIR, content, 'user-upload')
        return {'api_version': 1, **item}
    except (ValueError, binascii.Error) as error:
        raise HTTPException(422, str(error)) from error


@router.post('/preserve-legacy', dependencies=[Depends(local_dashboard)])
def preserve_legacy():
    # Serialize the snapshot and migration with ordinary database writes.
    with db._lock:
        assets.backup_before_migration(db.DB_PATH, db.DATA_DIR)
    with db._tx() as conn:
        return {'api_version': 1, **assets.preserve_profile_art(conn, db.DATA_DIR)}


@router.get('/{identifier}/content')
def content(identifier: str):
    with db._tx() as conn:
        row = conn.execute('SELECT * FROM user_assets WHERE id=?', (identifier,)).fetchone()
    if row is None:
        raise HTTPException(404, '资源不存在')
    try:
        path = assets.asset_path(db.DATA_DIR, identifier, row['extension'])
    except ValueError as error:
        raise HTTPException(404, '资源不存在') from error
    if not path.is_file():
        raise HTTPException(404, '资源文件缺失，请从备份恢复')
    return FileResponse(path, media_type=row['mime'], headers={
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600'})
