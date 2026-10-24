"""Fixed host contract for the optional Gemini integration; no sync implementation."""
import importlib
import importlib.util
import json
import sys
import types

from fastapi import HTTPException
from .data_paths import PROJECT_ROOT
from . import plugin_state

FEATURES_DIR=PROJECT_ROOT/'features'
PACKAGE='gemini_sync_plugin'


def installed():
    folder=FEATURES_DIR/'gemini-sync'
    try:
        manifest=folder/'plugin.json'
        if manifest.stat().st_size>16384:
            return False
        data=json.loads(manifest.read_text(encoding='utf-8-sig'))
        return (isinstance(data,dict) and data.get('id')=='gemini_sync'
                and data.get('kind')=='integration' and type(data.get('host_api')) is int
                and data['host_api']==1 and (folder/PACKAGE/'__init__.py').is_file())
    except (OSError,ValueError):
        return False


def require_enabled():
    if not installed():
        raise HTTPException(404,'Gemini 同步插件未安装')
    if not plugin_state.enabled('gemini_sync'):
        raise HTTPException(409,'Gemini 同步插件已关闭')


def load(name):
    if not installed():
        raise HTTPException(404,'Gemini 同步插件未安装')
    if PACKAGE not in sys.modules:
        from . import db
        folder=FEATURES_DIR/'gemini-sync'/PACKAGE
        spec=importlib.util.spec_from_file_location(PACKAGE,folder/'__init__.py',submodule_search_locations=[str(folder)])
        package=importlib.util.module_from_spec(spec)
        host=types.ModuleType(PACKAGE+'.host')
        host.db=db
        host.require_enabled=require_enabled
        sys.modules[PACKAGE]=package
        sys.modules[PACKAGE+'.host']=host
        try:
            spec.loader.exec_module(package)
        except BaseException:
            sys.modules.pop(PACKAGE,None)
            sys.modules.pop(PACKAGE+'.host',None)
            raise
    return importlib.import_module(PACKAGE+'.'+name)


def mount(app):
    # Mount installed code even when disabled, allowing runtime toggles without restart.
    if installed():
        app.include_router(load('router').router,prefix='/api')
