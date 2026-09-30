"""把「人设种子」同步进已有数据库（改完 seed_characters.py 后跑一次）。

首次启动只在空库写种子，之后种子改动不会自动生效 —— 本脚本负责把四份人设
按 id 覆盖进现有库。覆盖前会先把库里的当前内容整份备份到
backend/data/characters_backup_<时间戳>.json，改坏了可以照着还原。

用法（在 backend/ 下）：
    .venv/Scripts/python.exe scripts/reseed_characters.py          # 备份 + 同步
    .venv/Scripts/python.exe scripts/reseed_characters.py --dry    # 只看会改什么
"""

from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Windows 控制台默认 GBK，中文会乱码
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app.db import DATA_DIR, DB_PATH  # noqa: E402
from app.seed_characters import SEED_CHARACTERS  # noqa: E402


def _diff(cur: dict, new: dict) -> list[str]:
    keys = sorted(set(cur) | set(new))
    out = []
    for k in keys:
        if cur.get(k) != new.get(k):
            out.append(f"    · {k}")
    return out


def main() -> int:
    dry = "--dry" in sys.argv
    if not DB_PATH.exists():
        print(f"没有数据库：{DB_PATH}（首次启动会自动写入新种子，无需本脚本）")
        return 0

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = {r["id"]: json.loads(r["data"]) for r in conn.execute("SELECT id, data FROM characters")}

    changes: list[tuple[str, dict, dict]] = []
    for seed in SEED_CHARACTERS:
        cur = rows.get(seed["id"])
        if cur is None:
            print(f"[新增] {seed['id']}")
            changes.append((seed["id"], {}, seed))
        elif cur != seed:
            changes.append((seed["id"], cur, seed))

    for cid, cur, new in changes:
        print(f"[{'将改' if dry else '改'}动] {cid}")
        for line in _diff(cur, new):
            print(line)

    if not changes:
        print("四份人设都已是最新，无需改动。")
        conn.close()
        return 0

    if dry:
        print("\n（--dry：未写库）")
        conn.close()
        return 0

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    backup = DATA_DIR / f"characters_backup_{datetime.now():%Y%m%d_%H%M%S}.json"
    backup.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n已备份原内容 → {backup}")

    for cid, _cur, new in changes:
        conn.execute(
            "INSERT INTO characters (id, data, updated_at) VALUES (?, ?, datetime('now')) "
            "ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
            (cid, json.dumps(new, ensure_ascii=False)),
        )
    conn.commit()
    conn.close()
    print(f"已同步 {len(changes)} 份人设。重启后端（或刷新前端）即可看到。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
