"""英语学习 · 词库逻辑层（SM-2 复习 + 薄弱点分析 + 词表导入）。

**为什么这一类放在本体里**：它不是「在外面跑循环的采集端」，而是**交互式界面 + 用户自己的学习数据**。
按 §9.6 的划分，功能可以是独立仓库（B站 / QQ 桥那样），也可以在本体内（`folder: ""`，
和互动小家 / Gemini 同步一样）。英语学习属于后者 —— 它要的就是小窝的大脑（人格、模型、TTS、
生图、附件库），自己没有任何独立进程。

三件事在这里：

1. **复习调度（SM-2）**：作答复盘 → 重算 `ease / interval_days / due_at`。
   不自己发明算法，就为了以后想换 FSRS 时只动这一个函数。
2. **薄弱点分析**：全部从 `vocab_quiz_log` 现算（不另存汇总数，避免两份真相）。
   分四档：易忘词 / 拖后腿的分类 / 慢反应 / 只在某词性上摔跤。
3. **词表导入**：吃 xlsx / csv / txt。**列名靠猜**（英文表 / 中文表 / 只有一列都认），
   猜完把「认出了什么」回给用户看 —— 导入是覆盖不了的（`upsert_vocab_word` 只补空字段）。
"""

from __future__ import annotations

import csv
import io
import re
from datetime import datetime, timedelta, timezone

from .. import db

# ---- 复习调度（SM-2）----

# 三档作答 → SM-2 的 quality（0-5）。只给三档是刻意的：
# 让用户在一秒内点得下去（认识 / 模糊 / 忘了），而不是纠结「这算 4 还是 5 分」。
_QUALITY = {"known": 5, "fuzzy": 3, "forgot": 1}

# 阶段门限：interval 跨过几天算「认识 / 熟练」，给界面上的分档用。
_STAGE_SOLID_DAYS = 21.0
_STAGE_KNOWN_DAYS = 3.0

MIN_EASE = 1.3
MAX_EASE = 2.8


def _now() -> str:
    """写库时间统一用 UTC，和全库 datetime('now') 同口径。"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def review(word: dict, result: str) -> dict:
    """一次作答复盘。返回要写回的字段（调用方拿去 `update_vocab_word`）。

    三档的规矩（**在 SM-2 上做了一处刻意的偏离，见下**）：

    · `known`（认识）→ 走 SM-2 的台阶：1 天 → 6 天 → 上次 × ease。
    · `fuzzy`（模糊）→ **间隔减半**，不往前走台阶，stage 掉回「认识」。
    · `forgot`（忘了）→ 间隔归零 +1 天，reps 清零重爬，lapses +1。

    为什么偏离：SM-2 原教旨把 q=3 当「及格」，答「模糊」也会让间隔乘以 ease ——
    实测 16 天的词答一次模糊能跳到 45 天，那等于把没记住的词推得更远，是反效果。
    背单词时「模糊」的正确含义就是「还得再看」，所以让它缩不让你涨。
    ease 仍然按 SM-2 公式调（q=3 → -0.14），所以反复模糊的词会越调越难、间隔涨得越慢。
    """
    r = (result or "").strip().lower()
    if r not in _QUALITY:
        raise ValueError(f"result 只能是 known / fuzzy / forgot，收到 {result!r}")
    q = _QUALITY[r]
    ease = float(word.get("ease") or 2.5)
    interval = float(word.get("interval_days") or 0)
    reps = int(word.get("reps") or 0)
    lapses = int(word.get("lapses") or 0)

    if q < 3:
        # 忘了：回到起点重新爬台阶
        reps = 0
        interval = 1.0
        lapses += 1
    elif q == 3:
        # 模糊：缩一半，原地踏步（reps 不动，下回「认识」才继续爬）
        interval = max(1.0, round(interval * 0.5, 2)) if interval > 0 else 1.0
    else:
        if reps == 0:
            interval = 1.0
        elif reps == 1:
            interval = 6.0
        else:
            interval = max(1.0, round(interval * ease, 2))
        reps += 1

    # ease 更新（SM-2 公式），夹在 [1.3, 2.8] 里 —— 超过 2.8 会让间隔炸得太快。
    ease = ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))
    ease = round(min(MAX_EASE, max(MIN_EASE, ease)), 3)

    stage = 0
    if r == "fuzzy":
        stage = 1 if interval < _STAGE_SOLID_DAYS else 2
    elif q >= 3:
        stage = 3 if interval >= _STAGE_SOLID_DAYS else (2 if interval >= _STAGE_KNOWN_DAYS else 1)

    due = datetime.now(timezone.utc) + timedelta(days=interval)
    return {
        "ease": ease,
        "interval_days": interval,
        "due_at": due.strftime("%Y-%m-%d %H:%M:%S"),
        "reps": reps,
        "lapses": lapses,
        "stage": stage,
        "last_result": r,
    }


def review_word(word_id: str, result: str, mode: str = "recognize", elapsed_ms: int = 0) -> dict:
    """复盘一个词 + 记一条作答。返回 `{word, patch}`。"""
    word = db.get_vocab_word(word_id)
    if word is None:
        raise ValueError("词不存在")
    patch = review(word, result)
    updated = db.update_vocab_word(word_id, patch)
    db.add_quiz_log(
        word_id, word["word"], patch["last_result"], mode=mode,
        pos=word.get("pos", ""), tag=word.get("tag", ""), elapsed_ms=elapsed_ms,
    )
    return {"word": updated, "patch": patch, "due_at": patch["due_at"]}


# ---- 复习队列 ----

def queue(limit: int = 30, tag: str | None = None, include_new: bool = True) -> list[dict]:
    """今天该复习的一队：**到期的排前面**，不够再补新词（新词优先补）。

    「到期」= `due_at <= now`。新词（stage=0、reps=0）的 due_at 就是建词时间，
    所以本来就在到期集合里 —— 这里显式排后面，是为了让「复习」永远先于「学新词」。
    """
    due = db.list_vocab_words(limit=limit, tag=tag, due_only=True, order="due")
    picks = [w for w in due if int(w.get("reps") or 0) > 0]
    fresh = [w for w in due if int(w.get("reps") or 0) == 0]
    out = picks + fresh
    if include_new and len(out) < limit:
        # 到期的拿不满，再补一批没到期的（按词频/加入顺序倒序，最新的先上手）。
        have = {w["id"] for w in out}
        extra = db.list_vocab_words(limit=limit * 2, tag=tag, order="new")
        for w in extra:
            if len(out) >= limit:
                break
            if w["id"] not in have:
                out.append(w)
                have.add(w["id"])
    out = out[: max(1, min(int(limit or 30), 200))]
    # 一次把例句全带上（前端一屏 30 个词，别一个个请求）。
    examples = db.list_examples_for_words([w["id"] for w in out])
    for w in out:
        w["examples"] = examples.get(w["id"], [])
    return out


# ---- 薄弱点分析 ----


def analyze(days: int = 30, limit: int = 10) -> dict:
    """从作答历史现算薄弱点。四档：

    ① **易忘词**：答错次数多、或答对也不牢（ease 低）的词 —— 优先再刷。
    ② **拖后腿的分类**：按 tag 算正确率，最低的那几个。
    ③ **慢反应**：答对但耗时明显偏长的词（认得，但不熟，考试会来不及）。
    ④ **总览**：正确率、连学几天、进度分布。

    `days` 只收窄「近期作答」这一段；词本身的态（ease/stage）看的是全生命周期。
    """
    since = (datetime.now(timezone.utc) - timedelta(days=max(1, int(days or 30)))).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    logs = db.list_quiz_logs(limit=2000)
    recent = [r for r in logs if (r.get("created_at") or "") >= since]
    stats = db.vocab_stats()
    summary = db.quiz_summary()

    # ① 易忘词：错一次记 2 分，模糊记 1 分；再叠上词自身的 lapse 数。
    miss: dict[str, dict] = {}
    for row in recent:
        key = row.get("word") or ""
        if not key:
            continue
        item = miss.setdefault(key, {"word": key, "wrong": 0, "fuzzy": 0, "seen": 0,
                                     "ms": 0, "tag": row.get("tag") or "",
                                     "pos": row.get("pos") or "", "word_id": row.get("word_id") or ""})
        item["seen"] += 1
        item["ms"] += int(row.get("elapsed_ms") or 0)
        if row.get("result") == "forgot":
            item["wrong"] += 1
        elif row.get("result") == "fuzzy":
            item["fuzzy"] += 1
    weak_words: list[dict] = []
    for item in miss.values():
        score = item["wrong"] * 2 + item["fuzzy"]
        if score <= 0:
            continue
        word = db.get_vocab_word(item["word_id"]) if item["word_id"] else None
        item["miss_score"] = score
        item["accuracy"] = round((item["seen"] - item["wrong"]) / item["seen"], 3) if item["seen"] else 0
        item["avg_ms"] = int(item["ms"] / item["seen"]) if item["seen"] else 0
        item["ease"] = float(word["ease"]) if word else None
        item["stage"] = int(word["stage"]) if word else None
        item["meaning"] = (word or {}).get("meaning", "")
        weak_words.append(item)
    weak_words.sort(key=lambda x: (-x["miss_score"], x["accuracy"], -x["avg_ms"]))

    # ② 拖后腿的分类
    by_tag: dict[str, dict] = {}
    for row in recent:
        tag = (row.get("tag") or "").strip() or "（未分类）"
        item = by_tag.setdefault(tag, {"tag": tag, "seen": 0, "known": 0, "forgot": 0})
        item["seen"] += 1
        if row.get("result") == "known":
            item["known"] += 1
        elif row.get("result") == "forgot":
            item["forgot"] += 1
    weak_tags = [
        {**v, "accuracy": round(v["known"] / v["seen"], 3) if v["seen"] else 0}
        for v in by_tag.values() if v["seen"] >= 3
    ]
    weak_tags.sort(key=lambda x: (x["accuracy"], -x["seen"]))

    # ③ 慢反应：只算答对的（答错本来就会快，不说明问题）
    slow = [
        w for w in weak_words
        if w["wrong"] == 0 and w["avg_ms"] >= 6000
    ]
    slow.sort(key=lambda x: -x["avg_ms"])

    # ④ 进度分布
    buckets = {"fresh": 0, "learning": 0, "known": 0, "solid": 0}
    for w in db.list_vocab_words(limit=1000, order="due"):
        stage = int(w.get("stage") or 0)
        buckets["fresh" if stage == 0 else
                "solid" if stage >= 3 else
                "known" if stage == 2 else "learning"] += 1

    return {
        "window_days": int(days or 30),
        "overview": {
            **stats,
            **summary,
            "recent_answered": len(recent),
            "accuracy": round(summary["known"] / summary["answered"], 3) if summary["answered"] else 0,
        },
        "buckets": buckets,
        "weak_words": weak_words[: max(1, min(int(limit or 10), 100))],
        "weak_tags": weak_tags[: max(1, min(int(limit or 10), 100))],
        "slow_words": slow[: max(1, min(int(limit or 10), 100))],
    }


def daily_stats(days: int = 30) -> list[dict]:
    """逐日作答曲线（前端画个小柱子就够了，不引图表库）。"""
    since = (datetime.now(timezone.utc) - timedelta(days=max(1, int(days or 30)))).strftime(
        "%Y-%m-%d %H:%M:%S"
    )
    logs = [r for r in db.list_quiz_logs(limit=2000) if (r.get("created_at") or "") >= since]
    by_day: dict[str, dict] = {}
    for row in logs:
        day = (row.get("created_at") or "")[:10]
        if not day:
            continue
        item = by_day.setdefault(day, {"date": day, "answered": 0, "known": 0, "forgot": 0})
        item["answered"] += 1
        if row.get("result") == "known":
            item["known"] += 1
        elif row.get("result") == "forgot":
            item["forgot"] += 1
    out = sorted(by_day.values(), key=lambda x: x["date"])
    for item in out:
        item["accuracy"] = round(item["known"] / item["answered"], 3) if item["answered"] else 0
    return out


# ---- 词表导入 ----
#
# 大老大手上那些旧词表（可打印英语单词表 / 名词表 / 动词表…）形状各不相同，
# 所以这里**不要求固定列名**，靠猜：
#   ① 有表头就用表头的名字匹配（中英文都认）；
#   ② 没表头（或表头认不出）就看内容猜哪列是英文哪列是中文。
# 猜完把结果原样回给前端「这几列我认成了什么」，让人一眼看出猜错没有 ——
# 猜错时用户可以点名列，不用回来改代码。

_EN_COL = re.compile(r"(\bword\b|\benglish\b|单词|英文|词汇|\bterm\b|\bspell)", re.I)
_CN_COL = re.compile(r"(translat|meaning|中文|释义|意思|翻译|解释|词义)", re.I)
_POS_COL = re.compile(r"(\bpos\b|part of speech|词性|类型)", re.I)
_PHON_COL = re.compile(r"(phonetic|pronunc|音标|发音|\bipa\b)", re.I)
_TAG_COL = re.compile(r"(\btag\b|category|\bbook\b|分类|标签|词表|级别|等级|\bgroup\b)", re.I)

_ALL_COLS = (_EN_COL, _CN_COL, _POS_COL, _PHON_COL, _TAG_COL)

# 词性缩写归一（旧表里五花八门：n / n. / noun / 名词）
_POS_MAP = {
    "n": "n.", "noun": "n.", "名词": "n.",
    "v": "v.", "verb": "v.", "动词": "v.", "vt": "vt.", "vi": "vi.",
    "adj": "adj.", "adjective": "adj.", "形容词": "adj.",
    "adv": "adv.", "adverb": "adv.", "副词": "adv.",
    "prep": "prep.", "preposition": "prep.", "介词": "prep.",
    "conj": "conj.", "conjunction": "conj.", "连词": "conj.",
    "pron": "pron.", "pronoun": "pron.", "代词": "pron.",
    "num": "num.", "numeral": "num.", "数词": "num.",
    "art": "art.", "article": "art.", "冠词": "art.",
}

_ASCII_WORD = re.compile(r"^[A-Za-z][A-Za-z'’\-\. ]{0,60}$")
_HAS_CJK = re.compile(r"[一-鿿]")


def _norm_pos(value: str) -> str:
    """词性归一：'noun' / '名词' / 'n.' 都变成 'n.'；认不出的原样留着（宁可不认出，不乱改）。"""
    raw = (value or "").strip().strip("[]【】()（）").lower().rstrip(".")
    if not raw:
        return ""
    parts = re.split(r"[/、,，;；|]+", raw)
    out: list[str] = []
    for part in parts:
        key = part.strip().rstrip(".")
        if not key:
            continue
        out.append(_POS_MAP.get(key, part.strip() if "." in part.strip() else f"{key}."))
    return " / ".join(dict.fromkeys(out))


def _is_data_row(row: list[str]) -> bool:
    """这一行像不像数据行（而不是表头）。"""
    en = sum(1 for c in row if _ASCII_WORD.match((c or "").strip()))
    cn = sum(1 for c in row if _HAS_CJK.search(c or ""))
    return en >= 1 or cn >= 1


def _looks_like_header(rows: list[list[str]]) -> bool:
    """第一行是不是表头。

    判据：**这一行里过半的非空单元格都长得像列名**（命中那五组关键词之一）。

    试过两版都不行，记下来别再踩：
    · 「第一行没有中文」→ `单词 / 音标 / 词性 / 中文释义` 满行中文，被判成数据行，
      四个表头词当成单词导了进去；
    · 「第二行比第一行更像数据」→ 只有 `word | pos` 两列的英文表，第二行是 `benefit | n.`，
      而 `n.` 恰好也符合 ASCII 单词的形状，于是「第二行不像数据」，表头又没认出来。
    「过半单元格是列名」对这两种形状都成立：中文表头 4/4 命中，`word|pos` 2/2 命中，
    真正的数据行（`abandon | 放弃`）0/2 命中。
    """
    if not rows:
        return False
    first = [(c or "").strip() for c in rows[0] if (c or "").strip()]
    if not first:
        return False
    hit = sum(1 for c in first if any(rex.search(c) for rex in _ALL_COLS))
    return hit * 2 >= len(first)


def _guess_columns(rows: list[list[str]], header: list[str] | None) -> dict:
    """猜列。返回 `{"word": i, "meaning": i, ...}`（-1 = 没猜到）。

    两轮：① 有表头就按**列名关键词**认（最稳）；② 认不出（或没表头）再按**内容**猜。
    第二轮把表头行的词排除在外 —— 那是列名，不是单词。
    """
    mapping = {"word": -1, "meaning": -1, "pos": -1, "phonetic": -1, "tag": -1}
    if header:
        for idx, name in enumerate(header):
            text = (name or "").strip()
            if not text:
                continue
            # 按顺序判，且**每列只认一次**：先到先得，避免「单词释义」同时命中两列。
            for key, rex in (("word", _EN_COL), ("meaning", _CN_COL), ("pos", _POS_COL),
                             ("phonetic", _PHON_COL), ("tag", _TAG_COL)):
                if mapping[key] < 0 and rex.search(text):
                    mapping[key] = idx
                    break
    if mapping["word"] >= 0:
        return mapping
    # 表头认不出（或压根没表头）→ 按内容猜：英文多的那列是词，中文多的那列是释义。
    # 表头行本身要剔掉，否则「单词」两个字会被算进中文列。
    body = [r for r in rows[1:] if _is_data_row(r)] if _looks_like_header(rows) else rows
    if not body:
        body = rows
    width = max((len(r) for r in body), default=0)
    en_score = [0] * width
    cn_score = [0] * width
    for row in body[:200]:
        for idx in range(min(width, len(row))):
            cell = (row[idx] or "").strip()
            if not cell:
                continue
            if _HAS_CJK.search(cell):
                cn_score[idx] += 1
            elif _ASCII_WORD.match(cell):
                en_score[idx] += 1
    if en_score:
        mapping["word"] = en_score.index(max(en_score))
    if cn_score and max(cn_score) > 0:
        # 别把英文列又当释义列；平票时取第一列（释义一般挨着单词）。
        order = sorted(range(width), key=lambda i: (-cn_score[i], i))
        for idx in order:
            if idx != mapping["word"] and cn_score[idx] > 0:
                mapping["meaning"] = idx
                break
    return mapping


def _read_rows(raw: bytes, filename: str) -> tuple[list[list[str]], str]:
    """读 xlsx / csv / txt → 二维字符串表 + 说明。"""
    name = (filename or "").lower()
    if name.endswith((".xlsx", ".xlsm")):
        try:
            import openpyxl
        except ImportError as exc:  # pragma: no cover - 依赖里已有
            raise ValueError("后端没装 openpyxl，读不了 xlsx") from exc
        wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        rows: list[list[str]] = []
        for ws in wb.worksheets:
            for row in ws.iter_rows(values_only=True):
                rows.append(["" if c is None else str(c).strip() for c in row])
            if rows:
                break  # 只吃第一张有内容的表（旧词表一般就一张）
        return rows, "xlsx"
    text = raw.decode("utf-8-sig", errors="replace")
    # 分隔符：制表符优先（tab 分隔的 txt 很常见），其次逗号
    sample = text[:2000]
    delim = "\t" if sample.count("\t") >= sample.count(",") else ","
    rows = [[(c or "").strip() for c in r] for r in csv.reader(io.StringIO(text), delimiter=delim)]
    return rows, ("csv" if name.endswith(".csv") else "txt")


def import_wordlist(
    raw: bytes, filename: str = "", tag: str = "", source: str = "",
    columns: dict | None = None, has_header: bool | None = None, dry_run: bool = False,
) -> dict:
    """导入一张词表。返回**认出什么、导了多少、跳过什么** —— 前端要原样展示给用户。

    `columns` / `has_header` 是「猜错了的手动订正」：前端把用户点名的列传回来即可。
    重复的词**不覆盖已有释义**（见 `db.upsert_vocab_word`）—— 旧词表互相打架时，
    先到的赢，用户自己改过的永远赢。
    """
    if not raw:
        raise ValueError("文件是空的")
    if len(raw) > 20 * 1024 * 1024:
        raise ValueError("文件超过 20 MB —— 词表不至于这么大，先确认是不是传错了")
    rows, kind = _read_rows(raw, filename)
    rows = [r for r in rows if any((c or "").strip() for c in r)]
    if not rows:
        raise ValueError("表里没有内容")

    header: list[str] | None = None
    body = rows
    if has_header is None:
        has_header = _looks_like_header(rows)
    if has_header:
        header, body = rows[0], rows[1:]

    mapping = _guess_columns(body, header)
    if columns:
        # 手动订正：只接受声明里的键，值必须是整数下标。
        for key in ("word", "meaning", "pos", "phonetic", "tag"):
            if key in columns and columns[key] is not None:
                try:
                    mapping[key] = int(columns[key])
                except (TypeError, ValueError):
                    continue
    if mapping["word"] < 0:
        raise ValueError("认不出哪一列是英文单词 —— 请在前端点名「单词列」再导一次")

    parsed: list[dict] = []
    skipped: list[str] = []
    seen: set[str] = set()
    for row in body:
        def cell(idx: int) -> str:
            return (row[idx] or "").strip() if 0 <= idx < len(row) else ""

        word = cell(mapping["word"])
        if not word:
            continue
        # 英文列里混进中文的（错列 / 表尾注）→ 跳过，别把中文当单词存进去。
        if _HAS_CJK.search(word) and not _ASCII_WORD.match(word):
            skipped.append(word)
            continue
        key = word.lower()
        if key in seen:
            continue
        seen.add(key)
        parsed.append({
            "word": word,
            "meaning": cell(mapping["meaning"]),
            "pos": _norm_pos(cell(mapping["pos"])),
            "phonetic": cell(mapping["phonetic"]),
            "tag": cell(mapping["tag"]) or tag or "",
            "source": source or (filename or kind),
        })

    # 认列的结果原样回给用户看（前端显示成「我认成了：单词=A列，释义=B列」）
    guessed = {
        "word": mapping["word"],
        "meaning": mapping["meaning"],
        "pos": mapping["pos"],
        "phonetic": mapping["phonetic"],
        "tag": mapping["tag"],
        "header": header,
        "has_header": bool(has_header),
        "format": kind,
    }
    if dry_run:
        return {"dry_run": True, "columns": guessed, "parsed": len(parsed),
                "skipped": len(skipped), "sample": parsed[:10],
                "skipped_sample": skipped[:10]}

    created = updated = 0
    for item in parsed:
        before = db.find_vocab_word(item["word"])
        saved = db.upsert_vocab_word(
            item["word"], meaning=item["meaning"], pos=item["pos"],
            phonetic=item["phonetic"], tag=item["tag"], source=item["source"],
        )
        if before is None:
            created += 1
        elif saved and (saved.get("meaning") != before.get("meaning")
                        or saved.get("pos") != before.get("pos")
                        or saved.get("tag") != before.get("tag")):
            updated += 1
    return {"dry_run": False, "columns": guessed, "parsed": len(parsed), "created": created,
            "filled": updated, "skipped": len(skipped), "sample": parsed[:10],
            "skipped_sample": skipped[:10], "total_now": db.count_vocab_words()}