"""成果自动收录（任务①）：后台低频轮询一批「成果」目录，发现新文件就生成待确认卡片。

只做「检测到新文件 → 弹卡」，**不做内容推断**（账单等敏感推断另说，见待确认设计文档）。
- 监测目录默认 `个人数据库/成果/`，可在设置里自己换、可多选。
- 指纹 = 相对路径 + 大小 + mtime；只有「首次出现」才弹卡；改过的旧文件不再重复弹。
- ✓ 收录 = 在 `02_AI工作层/成果/{年份}/` 写一张成果卡 + 往 `成果索引_{年份}.md` 追加一行；
  ✗ 忽略 = 记入已知清单，不再提醒。
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime
from pathlib import Path

from .. import db
from ..config import get_settings

_PROJECT_ROOT = Path(__file__).resolve().parents[3]
from ..data_paths import personal_database_root

_ROOT = personal_database_root()
_HIDDEN_DIRS = {".versions", ".archive", ".obsidian", ".trash"}

_CONFIG_KEY = "harvest_watch_dirs"
_DEFAULT_WATCH = ["成果"]

# 哪些扩展名算「成果文件」。xlsx/csv 等表格用户说了暂时不管，不进监测。
_WATCH_EXTS = {
    ".md", ".txt", ".pdf", ".html",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg",
    ".mp4", ".mov", ".mkv", ".mp3", ".wav", ".flac", ".ogg",
    ".psd", ".xcf", ".kra", ".clip", ".sai", ".csp", ".zip", ".rar", ".7z",
}

_stop = threading.Event()
_worker = None
_worker_lock = threading.Lock()
_last_scan = ""
_last_error = ""


def _safe_join(rel: str) -> Path:
    p = (_ROOT / rel).resolve()
    if not p.is_relative_to(_ROOT) or any(part in _HIDDEN_DIRS for part in p.relative_to(_ROOT).parts):
        raise ValueError(f"path outside workspace: {rel}")
    return p


def get_watch_dirs() -> list[str]:
    raw = db.get_settings().get(_CONFIG_KEY, "")
    rels: list[str] = []
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                rels = [str(x).strip() for x in parsed if str(x).strip()]
        except (ValueError, TypeError):
            rels = []
    return rels or list(_DEFAULT_WATCH)


def set_watch_dirs(rels: list[str]) -> list[str]:
    cleaned = [str(x).strip().strip("/\\") for x in rels if str(x).strip()]
    # 只留能落到数据库内部的合法目录，防止指到库外。
    valid: list[str] = []
    for rel in cleaned:
        try:
            _safe_join(rel)
            valid.append(rel)
        except ValueError:
            continue
    db.set_settings({_CONFIG_KEY: json.dumps(valid, ensure_ascii=False)})
    return valid


def _fingerprint(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_size}:{int(stat.st_mtime)}"


def scan() -> int:
    """扫一遍监测目录，新文件生成待确认事件。返回本次新增的事件数。"""
    global _last_scan, _last_error
    from .. import personal_space
    if not personal_space.enabled('personal_database'):
        return 0
    now = datetime.now()
    try:
        known = {k["path"] for k in db.list_harvest_known()}
        new_count = 0
        for rel in get_watch_dirs():
            try:
                d = _safe_join(rel)
            except ValueError:
                continue
            if not d.is_dir():
                continue
            for current, dirs, files in os.walk(d, followlinks=False):
                dirs[:] = sorted(x for x in dirs if x not in _HIDDEN_DIRS and not (Path(current) / x).is_symlink())
                base = Path(current)
                for name in sorted(files):
                    p = base / name
                    if p.suffix.lower() not in _WATCH_EXTS:
                        continue
                    rel_path = p.relative_to(_ROOT).as_posix()
                    if rel_path not in known:
                        db.add_harvest_event(
                            kind="achievement",
                            source_path=rel_path,
                            title=p.stem,
                            date_done=now.strftime("%Y-%m-%d"),
                            detected_at=now.strftime("%Y-%m-%d %H:%M:%S"),
                        )
                        new_count += 1
                    db.set_harvest_known(rel_path, _fingerprint(p))
        _last_scan = now.strftime("%Y-%m-%d %H:%M:%S")
        _last_error = ""
        return new_count
    except Exception as exc:  # 巡检不能把后端带崩，记下来继续跑。
        _last_error = str(exc)
        return 0


def _loop(interval: int) -> None:
    while not _stop.is_set():
        scan()
        _stop.wait(max(1, interval))


def start() -> None:
    global _worker
    from .. import personal_space
    if not personal_space.enabled('personal_database'):
        return
    settings = get_settings()
    if not settings.harvest_enabled:
        return
    with _worker_lock:
        if _worker is not None and _worker.is_alive():
            return
        _stop.clear()
        _worker = threading.Thread(target=_loop, args=(settings.harvest_interval,), name="harvest-watcher", daemon=True)
        _worker.start()


def stop() -> bool:
    _stop.set()
    worker = _worker
    if worker is not None and worker is not threading.current_thread():
        worker.join(timeout=5)
        return not worker.is_alive()
    return True


def status() -> dict:
    settings = get_settings()
    from .. import personal_space
    return {
        "enabled": settings.harvest_enabled and personal_space.enabled('personal_database'),
        "interval": settings.harvest_interval,
        "watch_dirs": get_watch_dirs(),
        "last_scan": _last_scan,
        "last_error": _last_error,
    }


def _slug(text: str) -> str:
    s = re.sub(r"[^\w一-鿿-]+", "-", text.strip()).strip("-")
    return s or "未命名"


def _clean_title(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip() or "未命名"


def confirm_event(event_id: str, date_done: str | None = None, title: str | None = None) -> dict:
    """✓ 收录：写成果卡 + 追加年表索引，事件落成 confirmed。幂等：只收 pending 的事件。"""
    event = db.get_harvest_event(event_id)
    if event is None:
        raise ValueError("event not found")
    if event["status"] != "pending":
        raise ValueError(f"event already {event['status']}")
    done = (date_done or event["date_done"]).strip()
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", done):
        raise ValueError("date_done 需要 YYYY-MM-DD")
    year = done[:4]
    final_title = _clean_title(title or event["title"])
    slug = _slug(final_title)

    card_rel = f"02_AI工作层/成果/{year}/{slug}.md"
    card = _safe_join(card_rel)
    card.parent.mkdir(parents=True, exist_ok=True)
    if card.exists():  # 同名成果卡已在，文件名避让。
        i = 2
        while card.exists():
            card_rel = f"02_AI工作层/成果/{year}/{slug}-{i}.md"
            card = _safe_join(card_rel)
            i += 1
    today = datetime.now().strftime("%Y-%m-%d")
    card.write_text(
        "---\n"
        f"title: {final_title}\n"
        "type: fact\n"
        "status: current\n"
        f"date_done: {done}\n"
        f"source: {event['source_path']}\n"
        f"updated_at: {today}\n"
        "sensitivity: private\n"
        "inject: false\n"
        "visible_to: all\n"
        "review_status: pending\n"
        "---\n\n"
        "## 做了什么\n"
        "（待补充：一句话说清这个成果。）\n\n"
        "## 交付物 / 痕迹\n"
        f"- 原文件：`{event['source_path']}`\n",
        encoding="utf-8",
    )

    # 追加年表索引一行（无则先建表头）。
    index_rel = f"02_AI工作层/成果/成果索引_{year}.md"
    index = _safe_join(index_rel)
    index.parent.mkdir(parents=True, exist_ok=True)
    if index.exists():
        index.write_text(
            index.read_text(encoding="utf-8").rstrip("\n")
            + f"\n| {done} | {final_title} | — | `{card_rel}`（原：`{event['source_path']}`） |\n",
            encoding="utf-8",
        )
    else:
        index.write_text(
            f"# 成果索引 {year}\n\n"
            "| 完成日期 | 成果 | 来源计划 | 链接 |\n"
            "|---|---|---|---|\n"
            f"| {done} | {final_title} | — | `{card_rel}`（原：`{event['source_path']}`） |\n",
            encoding="utf-8",
        )

    db.update_harvest_event(event_id, status="confirmed", date_done=done, title=final_title)
    return {
        **db.get_harvest_event(event_id),
        "card": card_rel,
        "index": index_rel,
    }
