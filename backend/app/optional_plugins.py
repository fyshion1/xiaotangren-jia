"""Optional feature host: SDK injection, route mounting and worker lifetime only.

Feature implementations live in their own repositories, outside the core tree.
The local SDK exposes existing host services; no feature code is copied here.
"""
import importlib
import importlib.util
import sys
import types

from fastapi import Depends, HTTPException

PACKAGE = 'autonomous_activity'


class HostSDK(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith('__'):
            raise AttributeError(name)
        if name == 'repo':
            from .data_paths import PROJECT_ROOT
            return PROJECT_ROOT
        if name == 'features_dir':
            return expert_mode.FEATURES_DIR
        if name == 'expert_enabled':
            return expert_mode.enabled
        if name == 'expert_enabled_in':
            return expert_mode.enabled_in
        if name == 'local_dashboard':
            from .local_access import local_dashboard
            return local_dashboard
        if name == 'effective_config':
            from .routers.nest import _effective_config
            return _effective_config
        path = {'db': 'app.db', 'openai': 'app.providers.openai'}.get(name, 'app.services.' + name)
        return importlib.import_module(path)


# Define the SDK before expert_mode imports db -> tavern_feature -> this module.
from . import expert_mode


def load():
    if not expert_mode.plugin_installed():
        raise HTTPException(404, '自主活动插件未安装')
    if PACKAGE not in sys.modules:
        folder = expert_mode.FEATURES_DIR / 'autonomous-activity' / PACKAGE
        spec = importlib.util.spec_from_file_location(PACKAGE, folder / '__init__.py',
                                                     submodule_search_locations=[str(folder)])
        package = importlib.util.module_from_spec(spec)
        sys.modules[PACKAGE] = package
        sys.modules[PACKAGE + '.host'] = HostSDK(PACKAGE + '.host')
        spec.loader.exec_module(package)
    return importlib.import_module(PACKAGE + '.plugin')


def available():
    return expert_mode.enabled() and expert_mode.plugin_installed()


def module(name: str):
    expert_mode.require_expert()
    load()
    return importlib.import_module(PACKAGE + '.services.' + name)


def mount(app):
    if expert_mode.plugin_installed():
        load().mount(app, Depends(expert_mode.require_expert))


async def stop_workers():
    if not expert_mode.plugin_installed():
        return
    load()
    plugin = sys.modules.get(PACKAGE + '.plugin')
    await plugin.stop()
    from .routers import nest
    if nest._running_pid('autonomous_activity'):
        await nest.stop_feature('autonomous_activity')
