"""成果巡检（任务①）路由：待确认卡片列表 + 收录/忽略/改日期 + 监测目录设置。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..services import harvest

router = APIRouter(prefix="/patrol", tags=["patrol"])


class WatchDirsBody(BaseModel):
    watch_dirs: list[str]


class ConfirmBody(BaseModel):
    date_done: str | None = None
    title: str | None = None


class DateBody(BaseModel):
    date_done: str


@router.get("/status")
def patrol_status() -> dict:
    return harvest.status()


@router.get("/events")
def list_events(status: str | None = None) -> list[dict]:
    return db.list_harvest_events(status=status)


@router.post("/confirm/{event_id}")
def confirm_event(event_id: str, body: ConfirmBody) -> dict:
    try:
        return harvest.confirm_event(event_id, body.date_done, body.title)
    except ValueError as exc:
        raise HTTPException(400, str(exc))


@router.post("/ignore/{event_id}")
def ignore_event(event_id: str) -> dict:
    event = db.get_harvest_event(event_id)
    if event is None:
        raise HTTPException(404, "event not found")
    db.update_harvest_event(event_id, status="ignored")
    return db.get_harvest_event(event_id)


@router.put("/events/{event_id}/date")
def set_event_date(event_id: str, body: DateBody) -> dict:
    event = db.get_harvest_event(event_id)
    if event is None:
        raise HTTPException(404, "event not found")
    if event["status"] != "pending":
        raise HTTPException(400, "only pending events can be edited")
    import re
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", (body.date_done or "").strip()):
        raise HTTPException(400, "date_done 需要 YYYY-MM-DD")
    db.update_harvest_event(event_id, date_done=body.date_done.strip())
    return db.get_harvest_event(event_id)


@router.get("/watch-dirs")
def get_watch_dirs() -> dict:
    return {"watch_dirs": harvest.get_watch_dirs()}


@router.put("/watch-dirs")
def set_watch_dirs(body: WatchDirsBody) -> dict:
    return {"watch_dirs": harvest.set_watch_dirs(body.watch_dirs)}