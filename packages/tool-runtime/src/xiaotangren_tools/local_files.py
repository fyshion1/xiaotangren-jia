"""Four bounded read tools. Sandbox config is trusted process-local data."""
from __future__ import annotations

import os
import stat
from itertools import islice
from pathlib import Path

from pydantic import Field

from .base import Arguments, Tool, ToolDenied
from .registry import ToolRegistry

FORBIDDEN = frozenset({
    "rm", "del", "erase", "rd", "rmdir", "format", "diskpart", "mkfs",
    "shutdown", "reboot", "poweroff", "halt", "reg", "regedit", "sc",
    "taskkill", "kill", "wmic", "netsh", "net", "attrib", "icacls", "takeown",
    "curl", "wget", "powershell", "pwsh", "cmd", "bash", "sh", "python", "python3",
    "pip", "npm", "node", "git", "ssh", "scp", "certutil", "bitsadmin",
})
_FORBIDDEN_HINTS = ("rm -", "del ", ">", "|", "&&", ";", "`", "$(", "sudo", "chmod", "chown")


def detect_dangerous(text: str) -> str:
    for hint in _FORBIDDEN_HINTS:
        if hint in text.lower():
            return "只允许只读文件路径，不允许命令、管道或重定向"
    return ""


class DirectoryArguments(Arguments):
    path: str = Field(default=".", max_length=2048)


class ReadArguments(Arguments):
    path: str = Field(min_length=1, max_length=2048)


class FindArguments(Arguments):
    name: str = Field(min_length=1, max_length=256)


class LocalFiles:
    def __init__(self, root: Path, max_bytes: int = 8000):
        self.root = root.expanduser().resolve()
        if type(max_bytes) is not int or not 100 <= max_bytes <= 60000:
            raise ValueError("max_bytes must be in [100, 60000]")
        self.max_bytes = max_bytes

    def safe_path(self, raw: str) -> Path:
        text = raw.strip() or "."
        reason = detect_dangerous(text)
        if reason or "\x00" in text:
            raise ToolDenied(reason or "路径包含无效字符")
        # NTFS alternate streams/device namespaces are not ordinary text files.
        candidate = Path(text)
        if os.name == "nt" and (":" in text[2:] or text.startswith(("\\\\", "//"))):
            raise ToolDenied("不允许设备路径、网络路径或备用数据流")
        target = (candidate if candidate.is_absolute() else self.root / candidate).resolve()
        if target != self.root and self.root not in target.parents:
            raise ToolDenied("越界了：路径不在允许的目录里")
        return target

    def directory(self, args: DirectoryArguments, context) -> str:
        self.root.mkdir(parents=True, exist_ok=True)
        target = self.safe_path(args.path)
        if not target.exists():
            raise ToolDenied("没有这个路径")
        if target.is_file():
            return f"{target.name} 是个文件（{target.stat().st_size} 字节）"
        rows = []
        with os.scandir(target) as entries:
            batch = list(islice(entries, 2001))
        for item in sorted(batch[:2000], key=lambda entry: entry.name):
            try:
                path = self.safe_path(str(Path(item.path)))
                rows.append(f"{'📁' if path.is_dir() else '📄'} {item.name}")
            except (ToolDenied, OSError, ValueError):
                continue
            if len(rows) == 80:
                break
        more = "\n…（目录结果已限制）" if len(batch) > 80 else ""
        return f"{target.relative_to(self.root)} 的目录项：\n" + "\n".join(rows) + more

    def read(self, args: ReadArguments, context) -> str:
        self.root.mkdir(parents=True, exist_ok=True)
        target = self.safe_path(args.path)
        if not target.is_file() or not stat.S_ISREG(target.stat().st_mode):
            raise ToolDenied("没有这个普通文件")
        with target.open("rb") as stream:
            raw = stream.read(self.max_bytes + 1)
        truncated = len(raw) > self.max_bytes
        raw = raw[:self.max_bytes]
        if b"\x00" in raw:
            raise ToolDenied("只支持 UTF-8 文本，不能读取二进制文件")
        return raw.decode("utf-8", errors="replace") + (
            f"\n…（截断：最多读取 {self.max_bytes} 字节）" if truncated else "")

    def find(self, args: FindArguments, context) -> str:
        self.root.mkdir(parents=True, exist_ok=True)
        keyword = args.name.strip().lower()
        if not keyword:
            raise ToolDenied("要找什么？把名字给我")
        pending, hits, scanned = [self.root], [], 0
        while pending and scanned < 5000 and len(hits) < 60:
            directory = self.safe_path(str(pending.pop()))
            with os.scandir(directory) as entries:
                for item in entries:
                    scanned += 1
                    try:
                        path = self.safe_path(item.path)
                        # Never descend into symlinks/junctions (including in-root
                        # links): avoid cycles and filesystem-boundary escapes.
                        junction = getattr(Path(item.path), "is_junction", lambda: False)()
                        if item.is_symlink() or junction:
                            continue
                        if item.is_dir(follow_symlinks=False):
                            pending.append(path)
                        if keyword in item.name.lower():
                            hits.append(str(Path(item.path).relative_to(self.root)))
                    except (ToolDenied, OSError, ValueError):
                        continue
                    if scanned >= 5000 or len(hits) >= 60:
                        break
        note = "\n…（搜索范围或结果已限制）" if scanned >= 5000 or len(hits) >= 60 else ""
        return ("找到：\n" + "\n".join(hits) if hits else "未找到匹配的文件名") + note

    def info(self, args: Arguments, context) -> str:
        self.root.mkdir(parents=True, exist_ok=True)
        return (f"允许目录：{self.root}\n单次最多读取 {self.max_bytes} 字节。\n"
                "仅支持目录、文本读取、文件名搜索和边界信息；不执行命令或写入文件。")

    def registry(self) -> ToolRegistry:
        registry = ToolRegistry()
        for name, description, arguments, handler in (
            ("local_dir", "列出允许目录的内容（只读）", DirectoryArguments, self.directory),
            ("local_read", "读取允许目录的 UTF-8 文本（按字节限制）", ReadArguments, self.read),
            ("local_find", "在允许目录内按文件名搜索（只读）", FindArguments, self.find),
            ("local_info", "查询本地文件工具的边界", Arguments, self.info),
        ):
            registry.register(Tool(name, description, arguments, handler))
        return registry
