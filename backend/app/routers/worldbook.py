"""Optional worldbook routes, absent when the feature is uninstalled."""
from fastapi import APIRouter
from .. import tavern_feature

router = APIRouter()
if tavern_feature.installed():
    router.include_router(tavern_feature.load("worldbook").router)
