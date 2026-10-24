"""Local plugin lifecycle: visibility, disable, reversible uninstall."""
import asyncio
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import plugin_state
from ..features_registry import all_features, get_feature, folder_has_payload
from ..local_access import local_dashboard

FEATURES_DIR = Path(__file__).resolve().parents[3] / 'features'
from ..data_paths import runtime_root

ARCHIVE_DIR = runtime_root() / 'uninstalled-plugins'
router = APIRouter(prefix='/plugins', tags=['plugins'], dependencies=[Depends(local_dashboard)])
lock = asyncio.Lock()


def paths(feature):
    root = FEATURES_DIR.resolve()
    target = root / feature['folder']
    archive = ARCHIVE_DIR / feature['folder']
    if target.is_symlink() or target.resolve().parent != root:
        raise HTTPException(409, '插件目录必须是 features 下的真实直接子目录')
    if archive.is_symlink() or archive.resolve().parent != ARCHIVE_DIR.resolve():
        raise HTTPException(409, '卸载备份目录异常')
    return target, archive


@router.get('')
async def listing():
    state = plugin_state.read()
    return {'items': [dict(id=f['id'], name=f['name'], folder=f['folder'],
                           installed=folder_has_payload(FEATURES_DIR / f['folder']),
                           archived=(ARCHIVE_DIR / f['folder']).is_dir(),
                           enabled=plugin_state.enabled(f['id']), hidden=not plugin_state.visible(f['id']),
                           **({'note': '开发服务会自动重载；生产部署需重新构建前端。已有角色、聊天与记忆保留。'}
                              if f['id'] in ('xiaotangren_theme', 'tavern') else
                              {'note': '关闭或卸载后暂停额外档案的读取和注入，身份、文件及原有注入勾选保留；原生长期记忆继续工作。'}
                              if f['id'] == 'personal_profile' else
                              {'note': '关闭或卸载后停止个人资料目录巡检及数据库条目读取，文件和挑选记录保留。普通聊天与长期记忆不受影响。'}
                              if f['id'] == 'personal_database' else {}))
                      for f in all_features() if f['folder'] and
                      (folder_has_payload(FEATURES_DIR / f['folder']) or (ARCHIVE_DIR / f['folder']).is_dir() or f['id'] in state)]}


class Action(BaseModel):
    action: str


class Change(BaseModel):
    id: str
    enabled: bool
    hidden: bool
    expected_enabled: bool
    expected_hidden: bool


class Changes(BaseModel):
    changes: list[Change] = Field(min_length=1, max_length=100)


@router.post('/apply')
async def apply_changes(body: Changes):
    async with lock:
        if len({change.id for change in body.changes}) != len(body.changes):
            raise HTTPException(422, '同一插件不能重复提交')
        # Validate the full batch before stopping processes or changing state.
        for change in body.changes:
            feature = get_feature(change.id)
            if not feature or not feature['folder']:
                raise HTTPException(404, '未知的独立插件')
            target, _ = paths(feature)
            if not target.is_dir():
                raise HTTPException(409, '插件安装状态已改变，请刷新后重试')
            if (plugin_state.enabled(change.id) != change.expected_enabled
                    or (not plugin_state.visible(change.id)) != change.expected_hidden):
                raise HTTPException(409, '插件状态已被其他页面修改，请刷新后重新选择')
        for change in body.changes:
            if change.expected_enabled and not change.enabled:
                await preserve_and_stop(change.id)
        plugin_state.update_many({change.id: dict(disabled=not change.enabled, hidden=change.hidden)
                                  for change in body.changes})
        if any(change.id == 'personal_database' and change.enabled and not change.expected_enabled for change in body.changes):
            from ..services import harvest
            from ..config import get_settings
            if get_settings().runtime_profile == 'full':
                harvest.start()
    return {'ok': True, 'message': '已应用全部修改。需要切换前端模块时页面会重载；已有用户数据保留。'}


async def preserve_and_stop(feature_id):
    if feature_id == 'personal_database':
        from ..services import harvest
        if not await asyncio.to_thread(harvest.stop):
            raise HTTPException(409, '资料巡检仍在结束当前扫描，请稍后重试')
    if feature_id == 'xiaotangren_theme':
        from .. import db
        from ..services import assets
        def preserve():
            assets.backup_before_migration(db.DB_PATH, db.DATA_DIR)
            with db._tx() as conn:
                return assets.preserve_profile_art(conn, db.DATA_DIR)
        result = await asyncio.to_thread(preserve)
        if result['unresolved']:
            raise HTTPException(409, '仍有角色图片未能保存，请在角色资源中检查缺失素材后重试')
    from . import nest
    if feature_id == 'autonomous_activity':
        from ..optional_plugins import stop_workers
        await stop_workers()
    if nest._running_pid(feature_id):
        result = await nest.stop_feature(feature_id)
        if not result.get('stopped'):
            raise HTTPException(409, '插件进程尚未停止；修改尚未保存，已停止的进程不会自动恢复，请检查后重试')


@router.post('/{feature_id}/manage')
async def manage(feature_id: str, body: Action):
    feature = get_feature(feature_id)
    if not feature or not feature['folder']:
        raise HTTPException(404, '未知的独立插件')
    if body.action not in ('hide', 'show', 'disable', 'enable', 'uninstall', 'restore'):
        raise HTTPException(422, '未知操作')
    async with lock:
        target, archive = paths(feature)
        if body.action == 'restore':
            if target.exists() or not archive.is_dir():
                raise HTTPException(409, '插件目录已存在或没有可恢复的备份')
            await asyncio.to_thread(shutil.move, str(archive), str(target))
            plugin_state.update(feature_id, disabled=True)
        elif not target.is_dir():
            raise HTTPException(404, '插件未安装')
        elif body.action in ('hide', 'show'):
            plugin_state.update(feature_id, hidden=body.action == 'hide')
        elif body.action == 'enable':
            plugin_state.update(feature_id, disabled=False)
            if feature_id == 'personal_database':
                from ..services import harvest
                from ..config import get_settings
                if get_settings().runtime_profile == 'full':
                    harvest.start()
        else:
            if body.action == 'uninstall' and archive.exists():
                raise HTTPException(409, '已有卸载备份，请先恢复；不会覆盖备份')
            await preserve_and_stop(feature_id)
            plugin_state.update(feature_id, disabled=True)
            if body.action == 'uninstall':
                ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
                await asyncio.to_thread(shutil.move, str(target), str(archive))
    return {'ok': True, 'message': '已保存。主题和酒馆在开发服务重载后生效；生产部署需重新构建前端。卸载保留全部用户数据，可恢复。'}
