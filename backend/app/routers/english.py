"""英语学习（features_registry 里的 `english_study`，§feature）。

**为什么这个功能在本体内（`folder: ""`）而不是独立仓库**：按 §9.6 的划分，功能有两种形态 ——
① 独立进程 / 采集端（逛 B站、QQ 桥），各自一个 git 仓库，靠 HTTP 反调大脑；
② 交互式界面 + 用户自己的数据（互动小家、Gemini 同步）。英语学习是后者：
它没有自己的循环，要的正是小窝的大脑 —— 人格（例句要有小糖人味）、模型、TTS（发音）、
生图（插图）、附件库（插图落盘）。

所以：表建在 `db.py`，逻辑在 `services/vocab.py`，路由在这儿，面板在小窝里。

需求对应：
- ① 导入旧单词表          → `POST /english/import`（xlsx / csv / txt，列名靠猜 + 手动订正）
- ② 自己加例句和插图      → `POST /english/words/{id}/examples` + 前端走 `/api/images/generate`
                            不懂语法问小糖人 → `POST /english/words/{id}/ask`
- ③ 记录成绩和薄弱点      → `POST /english/exams` + `GET /english/analysis`
"""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from .. import db
from ..features_registry import get_feature
from ..providers import openai
from ..services import vocab as vocab_svc
from ..services.prompt.forms import resolve_form
from .nest import _effective_config

router = APIRouter(prefix="/english", tags=["english"])

FEATURE_ID = "english_study"

# 插图的附件落到哪个会话目录（§9.6.4：功能不许自己另建静态目录）。
# 前端调 `/api/images/generate` 时把 `session_id` 填成这个，图就落在同一个文件夹里。
ATTACHMENT_SESSION = "english-vocab"


def _require_feature() -> None:
    """注册表里查得到才给用 —— 防止功能被摘掉了路由还挂着。"""
    if get_feature(FEATURE_ID) is None:
        raise HTTPException(503, f"功能 {FEATURE_ID} 不在注册表里（features_registry.py）")


def _brain() -> dict:
    """这份功能生效的大脑配置（全局默认 + 本功能覆盖）。没配就 409，别偷偷借用聊天那份。"""
    provider = _effective_config(FEATURE_ID)
    if not provider.get("base_url") or not provider.get("api_key") or not provider.get("model"):
        raise HTTPException(409, "还没配小窝大脑 API —— 先去小窝的「小窝大脑 API」填一份")
    return provider


# ---- 总览与词表 ----


@router.get("/overview")
async def overview() -> dict:
    _require_feature()
    return {
        "stats": db.vocab_stats(),
        "quiz": db.quiz_summary(),
        "tags": db.vocab_tags(),
        "attachment_session": ATTACHMENT_SESSION,
        "exams": db.list_vocab_exams(limit=5),
    }


@router.get("/words")
async def list_words(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    tag: str | None = Query(None, max_length=80),
    stage: int | None = Query(None, ge=0, le=3),
    keyword: str = Query("", max_length=80),
    due_only: bool = Query(False),
    order: str = Query("due", pattern="^(due|new|alpha|recent)$"),
) -> dict:
    items = db.list_vocab_words(limit=limit, offset=offset, tag=tag, stage=stage,
                               keyword=keyword, due_only=due_only, order=order)
    examples = db.list_examples_for_words([w["id"] for w in items])
    for w in items:
        w["examples"] = examples.get(w["id"], [])
    return {"items": items, "total": db.count_vocab_words(tag=tag, due_only=due_only, stage=stage),
            "offset": offset, "limit": limit}


class WordIn(BaseModel):
    word: str = Field(min_length=1, max_length=120)
    meaning: str = Field(default="", max_length=2000)
    pos: str = Field(default="", max_length=60)
    phonetic: str = Field(default="", max_length=120)
    tag: str = Field(default="", max_length=80)
    note: str = Field(default="", max_length=2000)


@router.post("/words")
async def create_word(body: WordIn) -> dict:
    """手动加一个词（和导入走同一条 upsert：已存在就只补空字段，不覆盖你改过的释义）。"""
    _require_feature()
    try:
        word = db.upsert_vocab_word(
            body.word, meaning=body.meaning, pos=body.pos, phonetic=body.phonetic,
            tag=body.tag, source="manual", note=body.note,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    word["examples"] = db.list_vocab_examples(word["id"])
    return word


@router.get("/words/{word_id}")
async def get_word(word_id: str) -> dict:
    word = db.get_vocab_word(word_id)
    if word is None:
        raise HTTPException(404, "没这个词")
    word["examples"] = db.list_vocab_examples(word_id)
    word["questions"] = db.list_vocab_questions(word_id, limit=20)
    return word


class WordPatch(BaseModel):
    """手改一个词。**这里是真覆盖**（与导入时的「只补空」相反）。"""
    word: str | None = None
    meaning: str | None = None
    pos: str | None = None
    phonetic: str | None = None
    tag: str | None = None
    note: str | None = None
    stage: int | None = Field(default=None, ge=0, le=3)


@router.patch("/words/{word_id}")
async def patch_word(word_id: str, body: WordPatch) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(422, "没有要改的字段")
    word = db.update_vocab_word(word_id, patch)
    if word is None:
        raise HTTPException(404, "没这个词")
    word["examples"] = db.list_vocab_examples(word_id)
    return word


@router.delete("/words/{word_id}")
async def delete_word(word_id: str) -> dict:
    """删词。**作答历史保留** —— 成绩曲线不该因为删了一个词就断掉。"""
    if not db.delete_vocab_word(word_id):
        raise HTTPException(404, "没这个词")
    return {"ok": True, "id": word_id}


# ---- 复习队列与作答 ----


@router.get("/queue")
async def get_queue(
    limit: int = Query(30, ge=1, le=200),
    tag: str | None = Query(None, max_length=80),
    skip: int = Query(0, ge=0, le=5000),
) -> dict:
    """今天该复习的一队（到期的排前面，不够再补新词）。例句一起带上，前端一屏渲染完。

    `skip` 给「换一轮」用：从排好的队里跳过前 N 个，看下一批。
    """
    _require_feature()
    items = vocab_svc.queue(limit=limit, tag=tag, skip=skip)
    return {"items": items, "count": len(items), "skip": skip,
            "next_skip": skip + len(items), "stats": db.vocab_stats()}


class ReviewIn(BaseModel):
    word_id: str = Field(min_length=1, max_length=80)
    result: str = Field(pattern="^(known|fuzzy|forgot)$")
    mode: str = Field(default="recognize", pattern="^(recognize|spell|choice|listen|browse)$")
    elapsed_ms: int = Field(default=0, ge=0, le=600000)


@router.post("/review")
async def submit_review(body: ReviewIn) -> dict:
    """一次作答复盘：写回 SM-2 进度 + 记一条作答（成绩分析的原料）。"""
    try:
        return vocab_svc.review_word(body.word_id, body.result, mode=body.mode,
                                     elapsed_ms=body.elapsed_ms)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


# ---- 例句与插图 ----


class ExampleIn(BaseModel):
    text: str = Field(default="", max_length=2000)
    translation: str = Field(default="", max_length=2000)
    speaker: str = Field(default="", max_length=120)
    image: str = Field(default="", max_length=1000)
    image_thumb: str = Field(default="", max_length=1000)
    source: str = Field(default="manual", max_length=20)


@router.post("/words/{word_id}/examples")
async def add_example(word_id: str, body: ExampleIn) -> dict:
    if db.get_vocab_word(word_id) is None:
        raise HTTPException(404, "没这个词")
    if not body.text.strip() and not body.image.strip():
        raise HTTPException(422, "例句和插图至少要有一样")
    return db.add_vocab_example(
        word_id, body.text, body.translation, body.speaker,
        image=body.image, image_thumb=body.image_thumb, source=body.source,
    )


class ExamplePatch(BaseModel):
    text: str | None = None
    translation: str | None = None
    speaker: str | None = None
    image: str | None = None
    image_thumb: str | None = None


@router.patch("/examples/{example_id}")
async def patch_example(example_id: str, body: ExamplePatch) -> dict:
    patch = {k: v for k, v in body.model_dump().items() if v is not None}
    if not patch:
        raise HTTPException(422, "没有要改的字段")
    found = db.update_vocab_example(example_id, patch)
    if found is None:
        raise HTTPException(404, "没这条例句")
    return found


@router.delete("/examples/{example_id}")
async def delete_example(example_id: str) -> dict:
    if not db.delete_vocab_example(example_id):
        raise HTTPException(404, "没这条例句")
    return {"ok": True, "id": example_id}


# ---- 让小糖人写例句（需求②「例句要有小糖人人设味」）----
#
# 走小窝大脑那份配置 + 角色介绍，不是聊天页那份 —— 与功能会话隔离的规矩一致（§9.6）。
# 提示词里明确要求「用这个词、场景要是你自己的日常」——小糖人的日常就是家和主人，
# 顺着人设写出来的句子她念得出口，也顺便把词记进去了。

_EXAMPLE_RULES = (
    "你在帮主人背英语单词。给他写例句，要求：\n"
    "1. 必须用上这个词（用原形或该词性的自然变形都行）；\n"
    "2. 句子是你自己会说的话 —— 场景取自你的日常（家、主人、你的爱好），"
    "带上你的人设语气，别写课本里那种「Tom is a student」；\n"
    "3. 句子要短、口语、好记，12 个词以内；\n"
    "4. 给中文翻译。\n"
    '只输出一个 JSON 对象：{"examples":[{"en":"英文例句","zh":"中文翻译"}]}，不要 Markdown、不要解释。'
)


class GenerateIn(BaseModel):
    character_id: str = Field(min_length=1, max_length=120)
    count: int = Field(default=3, ge=1, le=6)
    save: bool = True


@router.post("/words/{word_id}/examples/generate")
async def generate_examples(word_id: str, body: GenerateIn) -> dict:
    """请一位小糖人给这个词写几句有她味道的例句。写好直接落库（`save=False` 只返回不落）。"""
    _require_feature()
    word = db.get_vocab_word(word_id)
    if word is None:
        raise HTTPException(404, "没这个词")
    character = db.get_character(body.character_id)
    if character is None:
        raise HTTPException(404, "没这位小糖人")
    provider = _brain()
    form = resolve_form(character)
    brief = f"你是{form.get('name', body.character_id)}。\n{form.get('about', '')}\n{_EXAMPLE_RULES}"
    ask = (f"单词：{word['word']}\n"
           f"词性：{word.get('pos') or '（未标）'}\n"
           f"释义：{word.get('meaning') or '（未填）'}\n"
           f"写 {body.count} 句。")
    messages = [{"role": "system", "content": brief}, {"role": "user", "content": ask}]
    try:
        raw = await openai.complete_chat(
            messages, provider["model"], provider["base_url"], provider["api_key"],
            max_tokens=1024, temperature=0.9,
        )
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc

    items = _parse_examples(raw)
    if not items:
        # 模型没按 JSON 回（有时会写成一整段），退化成「整段当一句例句」，别把结果丢了。
        text = raw.strip().strip("`")
        if text:
            items = [{"en": text, "zh": ""}]
    saved = []
    if body.save:
        for item in items:
            saved.append(db.add_vocab_example(
                word_id, item["en"], item["zh"], speaker=body.character_id, source="ai",
            ))
    return {"items": items, "saved": saved, "character_id": body.character_id,
            "word": word["word"], "raw": "" if saved or items else raw}


def _parse_examples(raw: str) -> list[dict]:
    """从模型回复里挖出例句。容忍 ```json 围栏和前后废话。"""
    import json
    import re

    text = (raw or "").strip()
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(text[start:end + 1])
            rows = obj.get("examples") if isinstance(obj, dict) else None
            if isinstance(rows, list):
                out = []
                for row in rows:
                    if isinstance(row, dict):
                        en = str(row.get("en") or row.get("english") or "").strip()
                        zh = str(row.get("zh") or row.get("chinese") or "").strip()
                        if en:
                            out.append({"en": en, "zh": zh})
                    elif isinstance(row, str) and row.strip():
                        out.append({"en": row.strip(), "zh": ""})
                return out
        except (ValueError, TypeError):
            pass
    return []


# ---- 不懂语法就问小糖人（需求②）----


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    character_id: str = Field(default="", max_length=120)


@router.post("/words/{word_id}/ask")
async def ask_about_word(word_id: str, body: AskIn) -> dict:
    """就这个词 / 这句话问小糖人（语法、用法、区别都行）。答完留档，下次翻得到。"""
    _require_feature()
    word = db.get_vocab_word(word_id)
    if word is None:
        raise HTTPException(404, "没这个词")
    examples = db.list_vocab_examples(word_id)
    provider = _brain()

    # 默认问第一个人（前端会显式传，这里是兜底）
    char_id = body.character_id
    if not char_id:
        rows = db.list_characters()
        char_id = rows[0]["id"] if rows else ""
    character = db.get_character(char_id) if char_id else None
    if character is None:
        raise HTTPException(404, "没这位小糖人")
    form = resolve_form(character)
    brief = (
        f"你是{form.get('name', char_id)}。\n{form.get('about', '')}\n"
        "主人正在背英语单词，会拿不懂的地方问你。\n"
        "回答要求：① 先把语法/用法讲清楚，讲得浅一点、像姐姐教他那样，别堆术语；\n"
        "② 该举例子就举，例子也用你会说的话；\n"
        "③ 最多 300 字，直接说，不输出 Markdown 标题或思考过程。\n"
    )
    lines = [f"单词：{word['word']}", f"词性：{word.get('pos') or '（未标）'}",
             f"释义：{word.get('meaning') or '（未填）'}"]
    if word.get("note"):
        lines.append(f"主人自己的备注：{word['note']}")
    for ex in examples[:5]:
        if ex.get("text"):
            lines.append(f"例句：{ex['text']}" + (f"（{ex['translation']}）" if ex.get("translation") else ""))
    lines.append(f"主人问：{body.question}")
    messages = [{"role": "system", "content": brief},
                {"role": "user", "content": "\n".join(lines)}]
    try:
        answer = await openai.complete_chat(
            messages, provider["model"], provider["base_url"], provider["api_key"],
            max_tokens=1024, temperature=0.7,
        )
    except RuntimeError as exc:
        raise HTTPException(502, str(exc)) from exc
    saved = db.add_vocab_question(body.question, answer, word_id=word_id,
                                  word=word["word"], character_id=char_id)
    return {**saved, "character_id": char_id,
            "character_name": form.get("name", char_id)}


@router.get("/questions")
async def list_questions(word_id: str | None = Query(None, max_length=80),
                         limit: int = Query(50, ge=1, le=200)) -> dict:
    return {"items": db.list_vocab_questions(word_id, limit)}


# ---- 成绩（需求③）----


class ExamIn(BaseModel):
    kind: str = Field(default="quiz", pattern="^(quiz|cet4|cet6|mock|other)$")
    title: str = Field(default="", max_length=200)
    score: float | None = None
    max_score: float | None = None
    total: int = Field(default=0, ge=0, le=100000)
    correct: int = Field(default=0, ge=0, le=100000)
    detail: dict = Field(default_factory=dict)
    taken_at: str = Field(default="", max_length=40)
    note: str = Field(default="", max_length=2000)


@router.post("/exams")
async def add_exam(body: ExamIn) -> dict:
    _require_feature()
    if body.correct > body.total and body.total:
        raise HTTPException(422, "答对数不能超过总题数")
    return db.add_vocab_exam(
        body.kind, body.title, body.score, body.max_score, body.total, body.correct,
        detail=body.detail, taken_at=body.taken_at, note=body.note,
    )


@router.get("/exams")
async def list_exams(kind: str | None = Query(None, max_length=20),
                     limit: int = Query(100, ge=1, le=500)) -> dict:
    return {"items": db.list_vocab_exams(kind, limit)}


@router.delete("/exams/{exam_id}")
async def delete_exam(exam_id: str) -> dict:
    if not db.delete_vocab_exam(exam_id):
        raise HTTPException(404, "没这条成绩")
    return {"ok": True, "id": exam_id}


# ---- 分析（需求③「给出分析」）----


@router.get("/analysis")
async def analysis(
    days: int = Query(30, ge=1, le=3650),
    limit: int = Query(10, ge=1, le=100),
) -> dict:
    """薄弱点分析 + 逐日曲线。全部从作答历史现算，没有第二份真相。"""
    _require_feature()
    report = vocab_svc.analyze(days=days, limit=limit)
    report["daily"] = vocab_svc.daily_stats(days=days)
    report["exams"] = db.list_vocab_exams(limit=30)
    return report


# ---- 导入旧词表（需求①）----


@router.post("/import")
async def import_wordlist(
    file: UploadFile = File(...),  # noqa: B008 - FastAPI 的上传签名就是这样
    tag: str = Form(""),
    source: str = Form(""),
    dry_run: bool = Form(False),
    has_header: str = Form(""),
    word_col: str = Form(""),
    meaning_col: str = Form(""),
    pos_col: str = Form(""),
    phonetic_col: str = Form(""),
    tag_col: str = Form(""),
) -> dict:
    """吃一张词表（xlsx / csv / txt）。

    **先 `dry_run=true` 看一眼猜得对不对**：返回里 `columns` 是「我把哪列认成了什么」，
    `sample` 是前 10 行解析结果 —— 认错了就把列号传回来重导（或点 `has_header`）。
    重复的词不覆盖已有释义：旧词表互相打架时先到的赢，你自己改过的永远赢。
    """
    _require_feature()
    raw = await file.read()
    columns: dict = {}
    for key, value in (("word", word_col), ("meaning", meaning_col), ("pos", pos_col),
                       ("phonetic", phonetic_col), ("tag", tag_col)):
        if (value or "").strip():
            try:
                columns[key] = int(value)
            except ValueError:
                raise HTTPException(422, f"{key}_col 要填列号（从 0 开始）") from None
    flag = (has_header or "").strip().lower()
    header_arg = True if flag == "true" else (False if flag == "false" else None)
    try:
        return vocab_svc.import_wordlist(
            raw, file.filename or "", tag=tag, source=source,
            columns=columns or None, has_header=header_arg, dry_run=dry_run,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc