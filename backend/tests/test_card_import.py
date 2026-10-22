"""酒馆角色卡导入：读卡 / 拼「关于」/ 抽词条解析 + 三个路由端点。

这里守的是三条铁规矩（用户拍板的），测试就是它们的看门人：
1. **原文一字不改** —— `build_about` 只能加小标题，正文逐字比对。
2. **开场白不自动发言** —— 存进档案但不进人设 / 抽取原文；只有明确勾选或点击才写进私聊。
3. **重名先问** —— 预览要把同名角色如实报出来（前端才好弹「跳过 / 新建第二张」）。

外加：自家种子角色**不能删**（删了也会被补种），只有 `imported: true` 的卡删得掉。
"""

import base64
import asyncio
import json
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db
from app.routers import imports
from app.services import attachments, card_import

# ---- 造卡的积木 ----


def _chunk(ctype: bytes, data: bytes) -> bytes:
    """一个 PNG 块：长度 + 类型 + 数据 + CRC（`_png_text_chunks` 不校验 CRC，但既然能算就写对）。"""
    return struct.pack(">I", len(data)) + ctype + data + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)


def make_png(chunks: list[tuple[bytes, bytes]]) -> bytes:
    """签名 + 若干文本块 + IEND。够 `_png_text_chunks` 走完全程。"""
    return b"\x89PNG\r\n\x1a\n" + b"".join(_chunk(t, d) for t, d in chunks) + _chunk(b"IEND", b"")


def text_chunk(keyword: str, text: str) -> tuple[bytes, bytes]:
    """tEXt（酒馆 v2 卡用的就是它）：关键字 \\0 明文。"""
    return b"tEXt", keyword.encode("latin-1") + b"\x00" + text.encode("latin-1")


def ztxt_chunk(keyword: str, text: str) -> tuple[bytes, bytes]:
    """zTXt：关键字 \\0 压缩方法 \\0 zlib 压缩后的 utf-8。"""
    return b"zTXt", keyword.encode("latin-1") + b"\x00\x00" + zlib.compress(text.encode("utf-8"))


def itxt_chunk(keyword: str, text: str, compressed: bool = False) -> tuple[bytes, bytes]:
    """iTXt：关键字 \\0 压缩标志 \\0 压缩方法 \\0 语言 \\0 译名 \\0 正文。"""
    payload = text.encode("utf-8")
    head = keyword.encode("latin-1") + b"\x00" + (b"\x01" if compressed else b"\x00") + b"\x00\x00\x00"
    return b"iTXt", head + (zlib.compress(payload) if compressed else payload)


def embed(card: dict) -> str:
    """卡 → base64（酒馆导出就是这么塞进 PNG 文本块的）。"""
    return base64.b64encode(json.dumps(card, ensure_ascii=False).encode("utf-8")).decode("ascii")


CARD_V2 = {
    "spec": "chara_card_v2",
    "spec_version": "2.0",
    "data": {
        "name": "南小鸟",
        "description": "音乃木坂学院的二年级生，μ's 的成员之一。",
        "personality": "温柔、怕生，熟了之后很黏人。",
        "scenario": "放学后的音乐教室。",
        "first_mes": "{{user}}，早上好呀……今天也一起加油吧！",
        "mes_example": "<START>\n{{char}}: 早上好。",
        "creator": "某位作者",
        "tags": ["lovelive", "idol"],
    },
}

CARD_V1 = {
    "name": "老卡角色",
    "description": "v1 平铺写法。",
    "personality": "安静",
    "scenario": "",
    "first_mes": "你好。",
}


def png_with_card(card: dict, keyword: str = "chara", style: str = "text") -> bytes:
    maker = {"text": text_chunk, "ztxt": ztxt_chunk, "itxt": itxt_chunk}[style]
    return make_png([maker(keyword, embed(card))])


# ---- 读卡 ----


class HeartbeatTests(unittest.IsolatedAsyncioTestCase):
    async def test_heartbeat_does_not_cancel_slow_model(self):
        async def slow():
            await asyncio.sleep(0.04)
            yield 'model result'
        stream = imports._with_ping(slow(), interval=0.005)
        chunks = [chunk async for chunk in stream]
        self.assertTrue(any('event: ping' in chunk for chunk in chunks))
        self.assertEqual(chunks[-1], 'model result')

    async def test_closing_stream_cancels_pending_model(self):
        closed = asyncio.Event()
        async def slow():
            try:
                await asyncio.sleep(30)
                yield 'unexpected'
            finally:
                closed.set()
        stream = imports._with_ping(slow(), interval=0.005)
        self.assertIn('event: ping', await anext(stream))
        await stream.aclose()
        self.assertTrue(closed.is_set())


class ReadCardTests(unittest.TestCase):
    def test_reads_v2_card_from_png_text_chunk(self):
        card = card_import.read_card(png_with_card(CARD_V2), "南小鸟.png")
        self.assertEqual(card["name"], "南小鸟")
        self.assertEqual(card["personality"], "温柔、怕生，熟了之后很黏人。")
        self.assertEqual(card["spec"], "chara_card_v2")
        self.assertEqual(card["tags"], ["lovelive", "idol"])
        self.assertEqual(card["source"], "png")

    def test_ccv3_wins_over_chara(self):
        """新版卡两个块都写，`ccv3` 更新 —— 必须优先取它。"""
        v3 = {**CARD_V2, "spec": "chara_card_v3", "data": {**CARD_V2["data"], "name": "新版名字"}}
        raw = make_png([text_chunk("chara", embed(CARD_V2)), text_chunk("ccv3", embed(v3))])
        self.assertEqual(card_import.read_card(raw, "x.png")["name"], "新版名字")

    def test_reads_ztxt_and_itxt_chunks(self):
        """不同导出工具用不同块型 —— tEXt / zTXt / iTXt 三种都得认。"""
        for style in ("ztxt", "itxt"):
            with self.subTest(style=style):
                card = card_import.read_card(png_with_card(CARD_V2, style=style), "x.png")
                self.assertEqual(card["name"], "南小鸟")

    def test_reads_compressed_itxt(self):
        chunk = itxt_chunk("chara", embed(CARD_V2), compressed=True)
        self.assertEqual(card_import.read_card(make_png([chunk]), "x.png")["name"], "南小鸟")

    def test_reads_v1_flat_card(self):
        card = card_import.read_card(png_with_card(CARD_V1), "老卡.png")
        self.assertEqual(card["spec"], "chara_card_v1")  # 没有 data → 判成 v1
        self.assertEqual(card["scenario"], "")

    def test_reads_plain_json_card(self):
        raw = json.dumps(CARD_V2, ensure_ascii=False).encode("utf-8")
        card = card_import.read_card(raw, "南小鸟.json")
        self.assertEqual(card["name"], "南小鸟")
        self.assertEqual(card["source"], "json")

    def test_png_without_card_raises(self):
        """一张普通 PNG（没有 chara / ccv3 块）要明确报「这不是酒馆卡」。"""
        raw = make_png([text_chunk("Comment", "just a picture")])
        with self.assertRaises(ValueError) as ctx:
            card_import.read_card(raw, "photo.png")
        self.assertIn("没有角色卡数据", str(ctx.exception))

    def test_broken_json_raises(self):
        with self.assertRaises(ValueError):
            card_import.read_card(b"{not json at all", "x.json")

    def test_json_array_raises(self):
        with self.assertRaises(ValueError) as ctx:
            card_import.read_card(b'[{"name": "x"}]', "x.json")
        self.assertIn("顶层得是一个对象", str(ctx.exception))


# ---- 拼「关于」 ----


class BuildAboutTests(unittest.TestCase):
    def test_original_text_is_verbatim_under_chinese_headings(self):
        about, warnings = card_import.build_about(card_import.read_card(png_with_card(CARD_V2), "x.png"))
        self.assertEqual(warnings, [])
        # 正文逐字照搬，只加小标题
        self.assertIn("【角色设定】\n音乃木坂学院的二年级生，μ's 的成员之一。", about)
        self.assertIn("【性格】\n温柔、怕生，熟了之后很黏人。", about)
        self.assertIn("【场景】\n放学后的音乐教室。", about)
        self.assertIn("【对话示例】\n<START>\n{{char}}: 早上好。", about)

    def test_greeting_never_enters_about(self):
        """开场白多是一整段模板 / 广告，位置又在聊天记录里 —— 不进人设。"""
        card = card_import.read_card(png_with_card(CARD_V2), "x.png")
        about, _ = card_import.build_about(card)
        self.assertNotIn("早上好呀", about)

    def test_greeting_and_example_stay_out_of_extract_text(self):
        card = card_import.read_card(png_with_card(CARD_V2), "x.png")
        text = card_import.card_text_for_extract(card)
        self.assertIn("音乃木坂学院", text)
        self.assertNotIn("早上好呀", text)  # first_mes
        self.assertNotIn("<START>", text)  # mes_example

    def test_empty_sections_are_skipped(self):
        card = card_import.read_card(png_with_card(CARD_V1), "x.png")
        about, warnings = card_import.build_about(card)
        self.assertEqual(warnings, [])
        self.assertEqual(about, "【角色设定】\nv1 平铺写法。\n\n【性格】\n安静")  # scenario 是空的

    def test_blank_card_yields_nothing(self):
        about, warnings = card_import.build_about({"description": "", "personality": "  "})
        self.assertEqual(about, "")
        self.assertTrue(any("未找到角色介绍" in w for w in warnings))

    def test_overlong_section_is_truncated_and_reported(self):
        """超长只截断 + 如实提醒（回原卡看全文），不悄悄改写内容。"""
        body = "字" * (card_import.SECTION_LIMIT + 500)
        about, warnings = card_import.build_about({"description": body})
        self.assertEqual(len(warnings), 1)
        self.assertIn("已截断", warnings[0])
        self.assertTrue(about.endswith("…"))
        self.assertEqual(len(about), 20000)

    def test_description_over_old_limit_is_preserved(self):
        body = '人设' * 9000
        about, warnings = card_import.build_about({'description': body})
        self.assertIn(body, about)
        self.assertEqual(warnings, [])

    def test_combined_sections_share_twenty_thousand_character_budget(self):
        about, warnings = card_import.build_about({
            'description': '甲' * 14000, 'personality': '乙' * 14000,
        })
        self.assertEqual(len(about), 20000)
        self.assertIn('甲' * 14000, about)
        self.assertEqual(len(warnings), 1)

    def test_lore_and_other_setting_fields_fill_missing_description(self):
        card = card_import.read_card(json.dumps({'spec': 'chara_card_v3', 'data': {
            'name': 'Hidden', 'description': '', 'system_prompt': '系统人设',
            'extensions': {'depth_prompt': {'prompt': '深度人设'}},
            'character_book': {'entries': [
                {'comment': '外貌', 'content': '银发蓝眼', 'enabled': True},
                {'content': '禁用内容', 'enabled': False},
            ]},
        }}).encode(), 'card.json')
        about, warnings = card_import.build_about(card)
        self.assertIn('系统人设', about)
        self.assertIn('深度人设', about)
        self.assertIn('银发蓝眼', about)
        self.assertNotIn('禁用内容', about)
        self.assertIn('银发蓝眼', card_import.card_text_for_extract(card))
        self.assertEqual(warnings, [])


# ---- 抽词条解析 ----


class ParseFieldsTests(unittest.TestCase):
    def test_parses_plain_json(self):
        fields = card_import.parse_fields('{"birthday": "9 月 12 日", "height": "159cm"}')
        self.assertEqual(fields, {"birthday": "9 月 12 日", "height": "159cm"})

    def test_strips_code_fences_and_prose(self):
        raw = '好的，结果如下：\n```json\n{"age": "17"}\n```\n希望有帮助。'
        self.assertEqual(card_import.parse_fields(raw), {"age": "17"})

    def test_list_from_string_or_list(self):
        fields = card_import.parse_fields('{"likes": "唱歌，跳舞、做衣服", "dislikes": ["苦瓜", "  ", "打雷"]}')
        self.assertEqual(fields["likes"], ["唱歌", "跳舞", "做衣服"])  # 中英文逗号 / 顿号 / 斜杠都切
        self.assertEqual(fields["dislikes"], ["苦瓜", "打雷"])  # 空白项丢掉

    def test_list_is_capped_at_eight(self):
        fields = card_import.parse_fields(json.dumps({"personality": [f"标签{i}" for i in range(20)]}))
        self.assertEqual(len(fields["personality"]), 8)

    def test_model_padding_words_count_as_empty(self):
        """模型爱用「无 / 未知 / N/A」表示原文没写 —— 一律当空，别把噪音存进档案。"""
        raw = json.dumps({"secret": "无", "weakPoint": "N/A", "privateWish": "未提及", "weight": "none"})
        self.assertEqual(card_import.parse_fields(raw), {})

    def test_trailing_period_trimmed(self):
        self.assertEqual(card_import.parse_fields('{"occupation": "学生。"}'), {"occupation": "学生"})

    def test_unknown_and_non_string_keys_ignored(self):
        fields = card_import.parse_fields('{"name": "小明", "height": 159, "age": "17"}')
        self.assertEqual(fields, {"age": "17"})  # name 不在抽取表里；height 不是字符串

    def test_broken_output_returns_empty(self):
        for raw in ("", "   ", "模型今天不想干活", "[1, 2, 3]"):
            with self.subTest(raw=raw):
                self.assertEqual(card_import.parse_fields(raw), {})


# ---- 开场白 / 译文的文本处理 ----
#
# 规则 2 的另一半：开场白**存下来但绝不自动发言** —— 这里测的正是「存」的那份
# （去标签、能直接塞进气泡），「不发言」由路由测试守门（见下面的 greeting 测试）。


class TextCleanupTests(unittest.TestCase):
    def test_plain_text_strips_tags_and_restores_entities(self):
        raw = "<p>你好&nbsp;<b>世界</b><br/>再见</p><li>第三行</li>"
        self.assertEqual(card_import.plain_text(raw), "你好 世界\n再见\n第三行")

    def test_plain_text_drops_script_and_style_blocks(self):
        raw = '正文<script>alert(1)</script><style>.x{}</style>尾巴'
        self.assertEqual(card_import.plain_text(raw), "正文尾巴")

    def test_plain_text_normalizes_blank_lines(self):
        self.assertEqual(card_import.plain_text("a\n\n\n\nb  \nc"), "a\n\nb\nc")

    def test_greeting_for_returns_plain_text(self):
        card = {"first_mes": "<p>早上好，&lt;user&gt;</p>"}
        self.assertEqual(card_import.greeting_for(card), "早上好，<user>")

    def test_greeting_for_empty_when_no_first_mes(self):
        self.assertEqual(card_import.greeting_for({}), "")
        self.assertEqual(card_import.greeting_for({"first_mes": "   "}), "")

    def test_greeting_for_is_capped(self):
        card = {"first_mes": "字" * (card_import.GREETING_LIMIT + 100)}
        self.assertEqual(len(card_import.greeting_for(card)), card_import.GREETING_LIMIT)

    def test_clean_translation_strips_fences(self):
        self.assertEqual(card_import.clean_translation("```text\n你好世界\n```"), "你好世界")
        self.assertEqual(card_import.clean_translation("好的：\n```\n你好\n```"), "你好")

    def test_clean_translation_strips_prefix(self):
        for raw in ("译文：你好", "翻译: 你好", "中文译文：你好"):
            with self.subTest(raw=raw):
                self.assertEqual(card_import.clean_translation(raw), "你好")

    def test_clean_translation_strips_unclosed_fence(self):
        """流式里围栏还没对端 —— 开头那行 ``` 也得剥掉，别把反引号显示出来。"""
        self.assertEqual(card_import.clean_translation("```text\n你好世界"), "你好世界")

    def test_clean_translation_keeps_plain_text(self):
        self.assertEqual(card_import.clean_translation("  你好世界  "), "你好世界")

    def test_blank_profile_has_display_only_and_greeting_keys(self):
        """`aboutZh` / `aboutHtml` 只给界面看、`greeting` 存而不发言 —— 都是档案里独立的一格。"""
        profile = card_import.blank_profile()
        self.assertIn("aboutZh", profile)
        self.assertIn("greeting", profile)
        self.assertIn("greetingHtml", profile)
        self.assertEqual(profile["imported"], True)
        self.assertEqual(profile["emoji"], "🎴")

    def test_parse_fields_partial_keeps_finished_keys(self):
        """连接断在半截 JSON 上：写全了的键照样能用，没写完的那个宁可不填。"""
        self.assertEqual(card_import.parse_fields_partial('{"height": "159cm", "sin'), {"height": "159cm"})
        self.assertEqual(card_import.parse_fields_partial('{"age": "17", "likes": ["唱'), {"age": "17", "likes": ["唱"]})
        self.assertEqual(card_import.parse_fields_partial('{"age": "17", "likes": ["唱'), {"age": "17", "likes": ["唱"]})
        # 完整的对象照常解析；说人话 / 一个键都没写全就返回空（不猜）。
        self.assertEqual(card_import.parse_fields_partial('{"age": "17"}'), {"age": "17"})
        self.assertEqual(card_import.parse_fields_partial('{"a": "x"'), {})
        self.assertEqual(card_import.parse_fields_partial("抱歉，这张卡我看不懂。"), {})
        # 模型把单值键包成数组（实测 gemini 就这么吐）：取第一个非空字符串，不是整键丢掉。
        self.assertEqual(
            card_import.parse_fields_partial('{"alias": ["星野爱"], "age": ["17"], "likes": ["偶像"]}'),
            {"alias": "星野爱", "age": "17", "likes": ["偶像"]},
        )
        # 严格版（落库用）不吃半截 JSON —— 补括号只是流式中途的兜底。
        self.assertEqual(card_import.parse_fields('{"height": "159cm", "sin'), {})


class SanitizeTests(unittest.TestCase):
    """带格式的预览：只留白名单标签、无属性，脚本整块删 —— 前端才敢直接渲染。"""

    def test_keeps_whitelisted_tags_without_attributes(self):
        html = card_import.sanitize_html('<p class="x" style="color:red">你好 <b>世界</b></p>')
        self.assertEqual(html, "<p>你好 <b>世界</b></p>")

    def test_drops_script_and_iframe_with_content(self):
        html = card_import.sanitize_html("前<script>alert(1)</script>中<iframe src=x>广告</iframe>后")
        self.assertNotIn("alert", html)
        self.assertNotIn("广告", html)
        self.assertIn("前", html)
        self.assertIn("后", html)

    def test_escapes_stray_angle_brackets(self):
        self.assertEqual(card_import.sanitize_html("a <3 you & me"), "a &lt;3 you &amp; me")

    def test_block_tags_become_line_breaks(self):
        html = card_import.sanitize_html("<p>一</p><p>二</p><div>三</div>")
        for part in ("一", "二", "三"):
            self.assertIn(part, html)
        self.assertNotIn("<div>", html)

    def test_truncates_without_cutting_a_tag(self):
        html = card_import.sanitize_html("<b>" + "字" * 50 + "</b>", limit=20)
        self.assertTrue(html.endswith("…"))
        self.assertEqual(html.count("<b>"), html.count("</b>"))

    def test_about_html_only_when_markup_present(self):
        self.assertEqual(card_import.about_html("纯文本\n第二行"), "")
        self.assertEqual(card_import.about_html("<p>正文</p>"), "<p>正文</p>")

    def test_greeting_html_for(self):
        self.assertEqual(card_import.greeting_html_for({"first_mes": "纯文本"}), "")
        self.assertEqual(card_import.greeting_html_for({"first_mes": "<p>早上好<br>呀</p>"}), "<p>早上好<br>呀</p>")
        self.assertEqual(card_import.greeting_html_for({}), "")

    def test_is_mostly_chinese(self):
        self.assertTrue(card_import.is_mostly_chinese("她是一名学生，喜欢唱歌。"))
        self.assertFalse(card_import.is_mostly_chinese("She is a student at Otonokizaka Academy."))
        self.assertTrue(card_import.is_mostly_chinese(""))  # 没字 = 不用翻


# ---- 路由端点 ----


class TavernCardRouterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.path = patch.object(db, "DB_PATH", root / "test.db")
        self.path.start()
        self.addCleanup(self.path.stop)
        # 立绘落盘也挪进临时目录，别污染真实的 backend/data/attachments
        self.files = patch.object(attachments, "ATTACHMENTS_DIR", root / "attachments")
        self.files.start()
        self.addCleanup(self.files.stop)
        db.DATA_DIR.mkdir(parents=True, exist_ok=True)
        with db._tx() as conn:
            conn.executescript(db._SCHEMA)
            db._migrate(conn)
        app = FastAPI()
        app.include_router(imports.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def _preview(self, raw: bytes, filename: str = "南小鸟.png", **query):
        params = {"extract": "false", **query}
        return self.client.post(
            "/api/imports/tavern-card/preview",
            params=params,
            files={"file": (filename, raw, "image/png")},
        )

    def test_preview_reads_card_without_creating_it(self):
        """预览只出草稿 —— 这一步绝不能落库（用户还没点确认）。"""
        res = self._preview(png_with_card(CARD_V2))
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["status"], "preview")
        self.assertEqual(body["spec"], "chara_card_v2")
        self.assertEqual(body["creator"], "某位作者")
        self.assertTrue(body["has_greeting"])
        self.assertEqual(body["profile"]["name"], "南小鸟")
        self.assertIn("音乃木坂学院", body["profile"]["about"])
        self.assertTrue(body["profile"]["imported"])
        self.assertNotIn("早上好呀", body["profile"]["about"])
        self.assertEqual(body["duplicates"], [])
        self.assertEqual(db.list_characters(), [])

    def test_preview_saves_portrait_through_attachment_pipeline(self):
        profile = self._preview(png_with_card(CARD_V2)).json()["profile"]
        self.assertTrue(profile["portrait"].startswith("/api/files/characters/orig/"))
        self.assertTrue(profile["avatar"].startswith("/api/files/characters/thumb/"))

    def test_original_greeting_html_survives_preview_and_commit(self):
        source = '<style>.card{color:red}</style><div class="card">你好</div><script>window.card=1</script>'
        card = {"name": "HTML card", "description": "说明", "first_mes": source}
        profile = self._preview(json.dumps(card).encode(), filename="card.json").json()["profile"]
        self.assertEqual(profile["greetingSource"], source)
        self.assertNotIn('<script>', profile["greetingHtml"])
        self.assertNotIn('<style>', profile["greetingHtml"])
        self.assertEqual(profile["greeting"], "你好")
        saved = self.client.post('/api/imports/tavern-card/commit', json={
            "name": "HTML card", "fields": profile,
        }).json()
        self.assertEqual(saved["greetingSource"], source)
        self.assertEqual(db.get_character(saved["id"])["greetingSource"], source)
        self.assertEqual(db.count_messages(f"single-{saved['id']}"), 0)

    def test_display_rules_survive_import_without_entering_prompt(self):
        rules = [{"scriptName": "theme", "findRegex": "/(hello)/g",
                  "replaceString": '<div class="theme">$1</div><style>.theme{color:red}</style>',
                  "placement": [2], "markdownOnly": True}]
        card = {"name": "Rules card", "description": "角色原文", "first_mes": "hello",
                "extensions": {"regex_scripts": rules}}
        profile = self._preview(json.dumps(card).encode(), filename="rules.json").json()["profile"]
        self.assertEqual(profile["tavernRegexScripts"], rules)
        self.assertNotIn('theme', profile["about"])
        saved = self.client.post('/api/imports/tavern-card/commit', json={
            "name": "Rules card", "fields": profile,
        }).json()
        self.assertEqual(db.get_character(saved["id"])["tavernRegexScripts"], rules)

    def test_preview_warns_when_json_card_has_no_portrait(self):
        res = self._preview(json.dumps(CARD_V2, ensure_ascii=False).encode("utf-8"), "南小鸟.json")
        body = res.json()
        self.assertEqual(body["profile"]["portrait"], "")
        self.assertTrue(any("没有卡图" in w for w in body["warnings"]))

    def test_preview_reports_duplicates_by_name(self):
        """重名先问是前端的事，但名单得后端给 —— 按名字（去掉首尾空格）比。"""
        db.upsert_character("char-old", {"name": "南小鸟", "imported": True})
        body = self._preview(png_with_card(CARD_V2)).json()
        self.assertEqual(body["duplicates"], [{"id": "char-old", "name": "南小鸟"}])

    def test_preview_falls_back_to_filename_when_card_has_no_name(self):
        card = {**CARD_V2, "data": {**CARD_V2["data"], "name": "  "}}
        body = self._preview(png_with_card(card), "无名氏.png").json()
        self.assertEqual(body["profile"]["name"], "无名氏")
        self.assertTrue(any("文件名" in w for w in body["warnings"]))

    def test_preview_extracts_fields_from_model(self):
        reply = '{"birthday": "9 月 12 日", "personality": ["温柔", "怕生"]}'
        with patch.object(imports.openai, "complete_chat", new=AsyncMock(return_value=reply)):
            body = self._preview(png_with_card(CARD_V2), extract="true").json()
        self.assertEqual(body["profile"]["birthday"], "9 月 12 日")
        self.assertEqual(body["profile"]["personality"], ["温柔", "怕生"])

    def test_preview_survives_model_failure(self):
        """抽取失败不挡导入：降级成「只有 about」，并如实记一条提醒。"""
        with patch.object(imports.openai, "complete_chat", new=AsyncMock(side_effect=RuntimeError("上游挂了"))):
            body = self._preview(png_with_card(CARD_V2), extract="true").json()
        self.assertIn("音乃木坂学院", body["profile"]["about"])
        self.assertTrue(any("自动解析词条没成功" in w for w in body["warnings"]))

    def test_preview_rejects_empty_and_unreadable_files(self):
        res = self.client.post("/api/imports/tavern-card/preview", params={"extract": "false"},
                               files={"file": ("x.png", b"", "image/png")})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self._preview(b"not a card", "x.png").status_code, 400)

    def test_commit_creates_character_with_generated_id(self):
        body = {"name": "南小鸟", "fields": {"about": "原文", "imported": True}}
        saved = self.client.post("/api/imports/tavern-card/commit", json=body).json()
        self.assertTrue(saved["id"].startswith("char-"))
        self.assertEqual(saved["name"], "南小鸟")
        self.assertTrue(saved["imported"])
        # 落库了才算数
        self.assertEqual([c["id"] for c in db.list_characters()], [saved["id"]])

    def test_commit_twice_makes_a_second_card(self):
        """重名走「新建第二张」：id 留空就是新建，绝不覆盖同名的那位。"""
        first = self.client.post("/api/imports/tavern-card/commit", json={"name": "南小鸟", "fields": {}}).json()
        second = self.client.post("/api/imports/tavern-card/commit", json={"name": "南小鸟", "fields": {}}).json()
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(len(db.list_characters()), 2)

    def test_commit_rejects_nameless_draft(self):
        res = self.client.post("/api/imports/tavern-card/commit", json={"name": "   ", "fields": {}})
        self.assertEqual(res.status_code, 400)

    def test_commit_enforces_twenty_thousand_character_budget(self):
        ok = self.client.post('/api/imports/tavern-card/commit', json={
            'name': 'Long', 'fields': {'about': '字' * 20000},
        })
        self.assertEqual(ok.status_code, 200)
        too_long = self.client.post('/api/imports/tavern-card/commit', json={
            'name': 'Too long', 'fields': {'about': '字' * 20001},
        })
        self.assertEqual(too_long.status_code, 400)

    def test_commit_forces_imported_flag(self):
        """前端漏传 imported 也得是导入卡 —— 否则她就变成「删不掉的自家角色」了。"""
        saved = self.client.post("/api/imports/tavern-card/commit", json={"name": "x", "fields": {}}).json()
        self.assertTrue(saved["imported"])

    def test_extract_fills_fields_from_model(self):
        """第二步请求：模型从原文里抽词条（画面已经出来了，这是后填）。"""
        reply = '{"birthday": "9 月 12 日", "alias": "传说中的女仆", "likes": ["唱歌", "跳舞"]}'
        with patch.object(imports.openai, "complete_chat", new=AsyncMock(return_value=reply)):
            res = self.client.post("/api/imports/tavern-card/extract",
                                   files={"file": ("南小鸟.png", png_with_card(CARD_V2), "image/png")})
        body = res.json()
        self.assertEqual(res.status_code, 200)
        self.assertTrue(body["extracted"])
        self.assertEqual(body["fields"]["birthday"], "9 月 12 日")
        self.assertEqual(body["fields"]["alias"], "传说中的女仆")
        self.assertEqual(body["fields"]["likes"], ["唱歌", "跳舞"])
        self.assertEqual(body["warnings"], [])
        self.assertEqual(db.list_characters(), [])  # 抽取不建角色

    def test_extract_survives_model_failure(self):
        """抽取失败不挡导入：降级成空词条 + 如实记一条提醒。"""
        with patch.object(imports.openai, "complete_chat", new=AsyncMock(side_effect=RuntimeError("上游挂了"))):
            body = self.client.post("/api/imports/tavern-card/extract",
                                    files={"file": ("南小鸟.png", png_with_card(CARD_V2), "image/png")}).json()
        self.assertEqual(body["fields"], {})
        self.assertFalse(body["extracted"])
        self.assertTrue(any("自动解析词条没成功" in w for w in body["warnings"]))

    def test_extract_rejects_unreadable_file(self):
        self.assertEqual(self.client.post("/api/imports/tavern-card/extract",
                                          files={"file": ("x.png", b"not a card", "image/png")}).status_code, 400)

    def test_translate_returns_clean_translation(self):
        with patch.object(imports.openai, "complete_chat", new=AsyncMock(return_value="```\n音乃木坂学院的学生。\n```")):
            body = self.client.post("/api/imports/tavern-card/translate",
                                    json={"text": "A student at Otonokizaka."}).json()
        self.assertEqual(body["aboutZh"], "音乃木坂学院的学生。")
        self.assertEqual(body["warnings"], [])

    def test_translate_empty_text_does_not_call_model(self):
        """空正文不值得花一次模型调用 —— 直接返回空译文。"""
        with patch.object(imports.openai, "complete_chat", new=AsyncMock()) as mock:
            body = self.client.post("/api/imports/tavern-card/translate", json={"text": "   "}).json()
        self.assertEqual(body, {"aboutZh": "", "warnings": []})
        mock.assert_not_awaited()

    def test_translate_survives_model_failure(self):
        with patch.object(imports.openai, "complete_chat", new=AsyncMock(side_effect=RuntimeError("上游挂了"))):
            body = self.client.post("/api/imports/tavern-card/translate",
                                    json={"text": "A student."}).json()
        self.assertEqual(body["aboutZh"], "")
        self.assertTrue(any("中文译文没翻成" in w for w in body["warnings"]))

    def test_private_session_id_defaults_to_bare_single(self):
        """默认身份（大老大）不加前缀 —— 老库里的 `single-<charId>` 历史才接得上。"""
        self.assertEqual(imports._private_session_id("char-bird"), "single-char-bird")

    def test_private_session_id_prefixes_other_persona(self):
        db.upsert_profile("xizi", {"name": "小紫"})
        db.set_active_persona_id("xizi")
        try:
            self.assertEqual(imports._private_session_id("char-bird"), "xizi@single-char-bird")
        finally:
            db.set_active_persona_id(imports.db.MAIN_PERSONA_ID)

    def test_commit_with_greeting_seeds_first_message(self):
        """勾了才写：开场白进她私聊的第一条（她说的）。"""
        first = self.client.post("/api/imports/tavern-card/commit", json={
            "name": "南小鸟",
            "fields": {"about": "原文", "imported": True, "greeting": "早上好呀"},
            "greeting": True,
        }).json()
        self.assertEqual(first["greeting_session"], "single-" + first["id"])
        msgs = db.list_messages("single-" + first["id"])
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["role"], "assistant")
        self.assertEqual(msgs[0]["content"], "早上好呀")

    def test_seed_greeting_refuses_when_session_already_chatted(self):
        """开场白永远只在最前面 —— 会话已经有人就不写（重导想起那份是后补的，走插入按钮）。"""
        db.upsert_character("char-bird", {"imported": True, "greeting": "早上好呀"})
        with db._tx() as conn:
            conn.execute("INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)",
                         ("m1", "single-char-bird", "user", "在吗"))
        self.assertEqual(imports._seed_greeting("char-bird", {"greeting": "早上好呀"}), "")
        self.assertEqual(db.count_messages("single-char-bird"), 1)  # 原消息一字未动

    def test_seed_greeting_skips_blank_greeting(self):
        self.assertEqual(imports._seed_greeting("char-bird", {"greeting": "   "}), "")
        self.assertEqual(db.count_messages("single-char-bird"), 0)

    def test_commit_without_greeting_writes_nothing(self):
        """默认不勾：一个字都不写进私聊，开场白照样留在档案里。"""
        saved = self.client.post("/api/imports/tavern-card/commit", json={
            "name": "南小鸟",
            "fields": {"about": "原文", "imported": True, "greeting": "早上好呀"},
            "greeting": False,
        }).json()
        self.assertEqual(saved["greeting_session"], "")
        self.assertEqual(db.count_messages("single-" + saved["id"]), 0)
        self.assertEqual(db.get_character(saved["id"])["greeting"], "早上好呀")

    def test_commit_with_greeting_writes_to_active_persona_session(self):
        """当前身份不是默认的大老大 → 开场白写进 `<pid>@single-<charId>`。"""
        db.upsert_profile("xizi", {"name": "小紫"})
        db.set_active_persona_id("xizi")
        try:
            saved = self.client.post("/api/imports/tavern-card/commit", json={
                "name": "南小鸟",
                "fields": {"imported": True, "greeting": "早上好呀"},
                "greeting": True,
            }).json()
            self.assertEqual(saved["greeting_session"], "xizi@single-" + saved["id"])
            self.assertEqual(len(db.list_messages("xizi@single-" + saved["id"])), 1)
        finally:
            db.set_active_persona_id(imports.db.MAIN_PERSONA_ID)

    def test_insert_greeting_writes_first_message(self):
        """角色介绍页的「插入开场白」：档案里那份一直是躺着的，点了才写。"""
        db.upsert_character("char-bird", {"name": "南小鸟", "imported": True, "greeting": "早上好呀"})
        res = self.client.post("/api/imports/tavern-card/char-bird/greeting")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["ok"], True)
        self.assertEqual(body["session_id"], "single-char-bird")
        self.assertEqual(body["content"], "早上好呀")
        msgs = db.list_messages("single-char-bird")
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0]["role"], "assistant")

    def test_insert_greeting_unknown_character_is_404(self):
        self.assertEqual(self.client.post("/api/imports/tavern-card/nobody/greeting").status_code, 404)

    def test_insert_greeting_without_stored_greeting_is_400(self):
        db.upsert_character("char-bird", {"name": "南小鸟", "imported": True})  # 档案里没有开场白
        res = self.client.post("/api/imports/tavern-card/char-bird/greeting")
        self.assertEqual(res.status_code, 400)
        self.assertIn("没有开场白", res.json()["detail"])

    def test_insert_greeting_refuses_after_chatting(self):
        """会话已经聊过就 409 先问用户，不硬塞在中间；带着 `insert: true` 再来才真插。"""
        db.upsert_character("char-bird", {"name": "南小鸟", "imported": True, "greeting": "早上好呀"})
        with db._tx() as conn:
            conn.execute("INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)",
                         ("m1", "single-char-bird", "user", "在吗"))
        res = self.client.post("/api/imports/tavern-card/char-bird/greeting")
        self.assertEqual(res.status_code, 409)
        self.assertIn("已经有消息", res.json()["detail"])
        self.assertEqual(db.count_messages("single-char-bird"), 1)  # 原消息一字未动

        res = self.client.post("/api/imports/tavern-card/char-bird/greeting", json={"insert": True})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(db.count_messages("single-char-bird"), 2)

    def test_preview_carries_sanitized_html_previews(self):
        """带格式的卡：档案里多一份洗过的 aboutHtml / greetingHtml，原文与纯文本不动。"""
        card = {**CARD_V2, "data": {**CARD_V2["data"],
                                    "description": "<p>音乃木坂的<b>二年级生</b>。</p>",
                                    "first_mes": "<p>早上好呀<script>x()</script></p>"}}
        profile = self._preview(png_with_card(card)).json()["profile"]
        self.assertIn("音乃木坂", profile["about"])
        self.assertIn("<b>二年级生</b>", profile["aboutHtml"])
        self.assertEqual(profile["greeting"], "早上好呀")
        self.assertEqual(profile["greetingHtml"], "<p>早上好呀</p>")

    def test_plain_card_has_empty_html_previews(self):
        profile = self._preview(png_with_card(CARD_V2)).json()["profile"]
        self.assertEqual(profile["aboutHtml"], "")
        self.assertEqual(profile["greetingHtml"], "")

    # ---- 流式抽取 / 翻译 ----


    def _stream(self, path: str, fake, **kwargs) -> list[tuple[str, dict]]:
        """跑一遍 SSE 端点，把 `event: x` / `data: {...}` 拆成 [(事件名, 数据)]。"""
        with patch.object(imports.openai, "stream_chat_retry", new=fake):
            res = self.client.post(path, **kwargs)
        self.assertEqual(res.status_code, 200)
        events, name = [], ""
        for line in res.text.splitlines():
            if line.startswith("event: "):
                name = line[len("event: "):]
            elif line.startswith("data: "):
                events.append((name, json.loads(line[len("data: "):])))
        return events

    def test_extract_stream_tokens_and_done(self):
        reply = '{"birthday": "9 月 12 日", "likes": ["唱歌"]}'

        async def fake(messages, model, base_url, api_key="", **kwargs):
            for chunk in (reply[:10], reply[10:]):
                yield {"type": "text", "text": chunk}
            yield {"type": "done", "finish_reason": "stop"}

        events = self._stream("/api/imports/tavern-card/extract/stream", fake,
                              files={"file": ("南小鸟.png", png_with_card(CARD_V2), "image/png")})
        tokens = [d["text"] for n, d in events if n == "token"]
        self.assertEqual("".join(tokens), reply)
        final = [d for n, d in events if n == "done"][-1]
        self.assertEqual(final["fields"], {"birthday": "9 月 12 日", "likes": ["唱歌"]})
        self.assertTrue(final["extracted"])
        self.assertEqual(db.list_characters(), [])

    def test_extract_stream_retry_reports_status(self):
        async def fake(messages, model, base_url, api_key="", **kwargs):
            kwargs["on_retry"](1, {"message": "上游 503"})
            yield {"type": "text", "text": '{"age": "17"}'}
            yield {"type": "done", "finish_reason": "stop"}

        events = self._stream("/api/imports/tavern-card/extract/stream", fake,
                              files={"file": ("南小鸟.png", png_with_card(CARD_V2), "image/png")})
        status = [d for n, d in events if n == "status"]
        self.assertTrue(status and "重试 2/3" in status[0]["message"])
        self.assertEqual([d for n, d in events if n == "done"][-1]["fields"], {"age": "17"})

    def test_extract_stream_connection_drop_keeps_partial_fields(self):
        """连接中途断：已收到的半截 JSON 照样解析 —— 半份词条也比零份强。"""
        async def fake(messages, model, base_url, api_key="", **kwargs):
            yield {"type": "text", "text": '{"height": "159cm", "sin'}
            raise ConnectionResetError("Server disconnected")

        events = self._stream("/api/imports/tavern-card/extract/stream", fake,
                              files={"file": ("南小鸟.png", png_with_card(CARD_V2), "image/png")})
        self.assertEqual([n for n, _ in events][-1], "error")
        self.assertEqual([d for n, d in events if n == "error"][-1]["fields"], {"height": "159cm"})

    def test_extract_stream_skips_model_when_card_has_no_text(self):
        """没正文就不叫模型 —— 直接 done + 一条提醒。"""
        async def fake(*args, **kwargs):  # pragma: no cover  被调用就是失败
            raise AssertionError("不该叫模型")
            yield  # noqa: F704

        card = {**CARD_V2, "data": {**CARD_V2["data"], "description": "", "personality": "", "scenario": ""}}
        events = self._stream("/api/imports/tavern-card/extract/stream", fake,
                              files={"file": ("x.png", png_with_card(card), "image/png")})
        final = events[-1]
        self.assertEqual(final[0], "done")
        self.assertEqual(final[1]["reason"], "empty")

    def test_translate_stream_done(self):
        async def fake(messages, model, base_url, api_key="", **kwargs):
            yield {"type": "text", "text": "音乃木坂学院的学生。"}
            yield {"type": "done", "finish_reason": "stop"}

        events = self._stream("/api/imports/tavern-card/translate/stream", fake,
                              json={"text": "A student at Otonokizaka."})
        self.assertEqual(events[-1], ("done", {"aboutZh": "音乃木坂学院的学生。", "skipped": False, "reason": ""}))

    def test_translation_output_limit_preserves_partial_and_reports_error(self):
        async def fake(*args, **kwargs):
            yield {'type': 'text', 'text': '部分译文'}
            yield {'type': 'done', 'finish_reason': 'length'}
        events = self._stream('/api/imports/tavern-card/translate/stream', fake,
                              json={'text': 'A long English character description.'})
        self.assertEqual(events[-1][0], 'error')
        self.assertEqual(events[-1][1]['aboutZh'], '部分译文')
        self.assertIn('输出长度限制', events[-1][1]['message'])

    def test_long_translation_has_larger_output_budget(self):
        async def fake(*args, **kwargs):
            self.assertGreater(kwargs['max_tokens'], 4096)
            yield {'type': 'text', 'text': '完整译文'}
            yield {'type': 'done', 'finish_reason': 'stop'}
        events = self._stream('/api/imports/tavern-card/translate/stream', fake,
                              json={'text': 'English description. ' * 500})
        self.assertEqual(events[-1][0], 'done')

    def test_empty_translation_is_failure(self):
        async def fake(*args, **kwargs):
            yield {'type': 'done', 'finish_reason': 'stop'}
        events = self._stream('/api/imports/tavern-card/translate/stream', fake,
                              json={'text': 'English description.'})
        self.assertEqual(events[-1][0], 'error')
        self.assertIn('空译文', events[-1][1]['message'])

    def test_copied_english_is_not_reported_as_complete_translation(self):
        source = 'This character has silver hair and blue eyes and lives in a city surrounded by mountains. ' * 12
        async def fake(*args, **kwargs):
            yield {'type': 'text', 'text': source + '（银发蓝眼）'}
            yield {'type': 'done', 'finish_reason': 'stop'}
        events = self._stream('/api/imports/tavern-card/translate/stream', fake,
                              json={'text': source})
        self.assertEqual(events[-1][0], 'error')
        self.assertIn('未翻译的英文', events[-1][1]['message'])

    def test_translate_stream_skips_chinese_text(self):
        async def fake(*args, **kwargs):  # pragma: no cover
            raise AssertionError("中文不该再翻")
            yield  # noqa: F704

        events = self._stream("/api/imports/tavern-card/translate/stream", fake,
                              json={"text": "她是一名学生，喜欢唱歌。"})
        self.assertEqual(events[-1][0], "done")
        self.assertTrue(events[-1][1]["skipped"])

    def test_translate_stream_failure_is_not_fatal(self):
        async def fake(messages, model, base_url, api_key="", **kwargs):
            yield {"type": "error", "message": "上游挂了", "status": 400}

        events = self._stream("/api/imports/tavern-card/translate/stream", fake,
                              json={"text": "A student."})
        self.assertEqual(events[-1][0], "error")
        self.assertIn("中文译文没翻成", events[-1][1]["message"])

    def test_delete_refuses_seed_characters(self):
        db.upsert_character("dalaoda", {"name": "大老大"})  # 没有 imported 标记 = 种子数据
        res = self.client.delete("/api/imports/tavern-card/dalaoda")
        self.assertEqual(res.status_code, 400)
        self.assertIn("种子数据", res.json()["detail"])
        self.assertIsNotNone(db.get_character("dalaoda"))  # 一字未动

    def test_delete_missing_character_is_404(self):
        self.assertEqual(self.client.delete("/api/imports/tavern-card/nobody").status_code, 404)

    def test_delete_purges_sessions_memories_and_files(self):
        """删一张导入的卡：连她单独聊的记录、记忆、立绘一起清。"""
        db.upsert_character(
            "char-bird",
            {"name": "南小鸟", "imported": True, "portrait": "/api/files/characters/orig/a.png"},
        )
        with db._tx() as conn:
            conn.execute("INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)",
                         ("m1", "single-char-bird", "user", "在吗"))
        db.add_memory(bucket="personal", text="她喜欢唱《Snow halation》", char_id="char-bird")

        with db._tx() as conn:
            before = conn.execute("SELECT COUNT(*) AS n FROM memories WHERE char_id = ?", ("char-bird",)).fetchone()["n"]
        self.assertEqual(before, 1)

        body = self.client.delete("/api/imports/tavern-card/char-bird").json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["removed"]["sessions"], 1)
        self.assertEqual(body["removed"]["messages"], 1)
        self.assertEqual(body["removed"]["memories"], 1)
        self.assertIsNone(db.get_character("char-bird"))
        self.assertEqual(db.list_session_ids("single-char-bird"), [])

    def test_delete_without_purge_keeps_history(self):
        db.upsert_character("char-bird", {"name": "南小鸟", "imported": True})
        with db._tx() as conn:
            conn.execute("INSERT INTO messages (id, session_id, role, content) VALUES (?,?,?,?)",
                         ("m1", "single-char-bird", "user", "在吗"))
        body = self.client.delete("/api/imports/tavern-card/char-bird", params={"purge": "false"}).json()
        self.assertEqual(body["removed"]["messages"], 0)
        self.assertEqual(db.list_session_ids("single-char-bird"), ["single-char-bird"])
        self.assertIsNone(db.get_character("char-bird"))


if __name__ == "__main__":
    unittest.main()
