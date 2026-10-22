"""Local semantic tool gate. Similarity is not probability or authorization."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import re
import threading
import time

from . import embedding


EXAMPLES = {
    "lyrics": ("找到这首歌的完整歌词，读完再聊喜欢哪一段", "Thank You! 765 MILLIONSTARS 的版本，读完整首歌词", "帮我找 TOKIMEKI Runners 的歌词"),
    "search": ("帮我了解今天发生了什么新闻", "去网上看看这件事有没有新的消息", "帮我找一下这部动画的资料", "明天的天气会不会下雨"),
    "memory": ("你还记得我上次说的事吗", "从知识库找一下我之前存的资料", "回忆一下我最近的作息", "我以前说过最喜欢哪一首歌"),
    "knowledge": ("把这段资料追加到个人知识库", "帮我保存这篇文章以后再看", "把这个加入知识库的待审核草稿"),
    "files": ("帮我读取本地文档", "看看这个文件夹里有什么", "打开这个路径下的配置文件"),
    "reminder": ("明天早上八点叫我起床", "半小时后提醒我喝水", "帮我安排一个定时提醒"),
    "records": ("记一下今天午饭吃了小炒", "今天花了三十块，帮我记账", "我最近睡眠记录怎么样", "今天跑步三公里，帮我记录"),
    "chat": ("晚上好呀，今天好想你们", "我到夜市吃西瓜啦，好甜", "你们喜欢听什么歌呀", "抱抱小糖人，陪我聊一会", "哈哈哈你太可爱了", "我今天有点累，想听你说说话", "晚安，我要睡啦", "我喜欢这首歌，你们呢", "嗯嗯，知道啦，谢谢你", "你们在干什么呀", "嗯嗯好的", "今天辛苦啦", "刚回到家，累死我了", "你最喜欢什么颜色呢", "坐过来陪陪我", "今天发生了一件好玩的事"),
}
_LABELS = [label for label, examples in EXAMPLES.items() for _ in examples]
_TEXTS = [text for examples in EXAMPLES.values() for text in examples]
_cache: dict[tuple[str, str], list[list[float]]] = {}
_lock = threading.Lock()
_retry_after: dict[tuple[str, str], float] = {}
# Explicit requests bypass loading; rules supplement rather than replace semantics.
_EXPLICIT = re.compile(r"文件|目录|路径|沙箱|本地|工具|读取|列出|搜索|查一下|查询|打开|新闻|联网|提醒|记账|费用|预算|记录|吃了|运动|跑步|骑车|local_|歌词|知识库|记忆库|搜|查", re.I)
_FOLLOWUP = re.compile(r"刚才|刚刚|上一[条首次]|那个版本|再读|继续找|接着找|读完|全文|整首|没找到|没拿到|再试")


@dataclass(frozen=True)
class Decision:
    needs_tools: bool
    intent: str
    method: str
    score: float = 0.0
    margin: float = 0.0
    elapsed_ms: float = 0.0

    def payload(self) -> dict:
        return asdict(self)


def classify(text: str) -> Decision:
    """Only confidently casual messages skip the tool assistant; no cloud vectors."""
    started = time.monotonic()

    def result(needs: bool, intent: str, method: str, score=0.0, margin=0.0):
        return Decision(needs, intent, method, round(score, 4), round(margin, 4),
                        round((time.monotonic() - started) * 1000, 1))

    text = text.strip()
    if not text:
        return result(False, "chat", "empty")
    if _EXPLICIT.search(text):
        return result(True, "tool_request", "explicit")
    if _FOLLOWUP.search(text) or len(text) > 1200:
        return result(True, "uncertain", "context_required")
    from ..config import get_settings
    from . import compute
    settings = get_settings()
    # Do not start a heavyweight model in lightweight mode or export text to a worker.
    if settings.runtime_profile == "lightweight" or compute.configuration().mode != "native":
        return result(True, "uncertain", "local_unavailable")
    model = settings.embed_local_model
    directory = Path(settings.embed_local_dir) if settings.embed_local_dir else embedding.DEFAULT_MODEL_DIR
    key = (model, str(directory.resolve()))
    try:
        with _lock:
            if time.monotonic() < _retry_after.get(key, 0):
                return result(True, "uncertain", "local_unavailable")
            prototypes = _cache.get(key)
            if prototypes is None:
                prototypes = embedding.embed_texts(_TEXTS, engine="local", local_model=model,
                                                  model_dir=directory, _delegate=False)
                _cache.clear()
                _cache[key] = prototypes
        # Chunk rather than silently truncating a long sentence at the tokenizer limit.
        chunks = [text[i:i + 300] for i in range(0, len(text), 300)]
        vectors = embedding.embed_texts(chunks, engine="local", local_model=model,
                                       model_dir=directory, _delegate=False)
        decisions = []
        for vector in vectors:
            scores = {label: max(embedding.cosine(vector, p) for p, name in zip(prototypes, _LABELS)
                                if name == label) for label in EXAMPLES}
            ordered = sorted(scores, key=scores.get, reverse=True)
            top = ordered[0]
            margin = scores[top] - scores[ordered[1]]
            # Conservative provisional thresholds; similarity is not calibrated confidence.
            decisions.append(result(top != "chat" or scores[top] < .68 or margin < .08,
                                    top, "local_embedding", scores[top], margin))
        selected = next((d for d in decisions if d.needs_tools), decisions[0])
        return result(selected.needs_tools, selected.intent, selected.method, selected.score, selected.margin)
    except embedding.EmbeddingError:
        with _lock:
            _retry_after.clear()
            _retry_after[key] = time.monotonic() + 60
        return result(True, "uncertain", "local_unavailable")
