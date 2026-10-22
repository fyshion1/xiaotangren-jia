import asyncio
import json
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from pydantic import Field
from xiaotangren_tools import (
    Arguments,
    Tool,
    ToolContext,
    ToolExecutor,
    ToolPolicy,
    ToolRegistry,
    ToolTransientError,
    web_search,
    lyrics_search,
)
from xiaotangren_tools.local_files import LocalFiles


class Query(Arguments):
    query: str = Field(min_length=1, max_length=20)


class ExecutorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.events = []
        self.calls = []
        self.registry = ToolRegistry()

        def handler(args, context):
            self.calls.append((args.query, context.actor_id))
            return args.query

        self.registry.register(Tool("lookup", "Read data", Query, handler))
        self.context = ToolContext("owner", "owner", "conversation", "call1")
        self.policy = ToolPolicy(enabled=True, allowed_names=frozenset({"lookup"}))
        self.executor = ToolExecutor(self.registry, self.policy, self.events.append)


    async def test_typed_dispatch_and_audit_without_data(self):
        result = await self.executor.execute("lookup", '{"query":"private text"}', self.context)
        self.assertTrue(result.ok)
        self.assertEqual(result.attempts, 1)
        self.assertEqual(self.calls, [("private text", "owner")])
        self.assertEqual(len(self.events), 1)
        self.assertEqual(self.events[0].call_id, "call1")
        self.assertNotIn("private text", repr(self.events))

    async def test_defaults_deny_everything(self):
        executor = ToolExecutor(self.registry, ToolPolicy(), self.events.append)
        result = await executor.execute("lookup", {"query": "x"}, self.context)
        self.assertEqual(result.code, "denied")
        self.assertEqual(executor.schemas(self.context), [])
        self.assertEqual(self.calls, [])

    async def test_identity_checked_at_execution_and_schema(self):
        for context in (ToolContext(), ToolContext("other", "owner"), ToolContext("owner", "")):
            self.assertEqual(self.executor.schemas(context), [])
            result = await self.executor.execute("lookup", {"query": "x"}, context)
            self.assertEqual(result.code, "denied")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.executor.schemas(self.context)[0]["function"]["name"], "lookup")

    async def test_owner_can_disable_tools(self):
        executor = ToolExecutor(self.registry, ToolPolicy(
            enabled=True, allowed_names={"lookup"}, owner_tools_enabled=False))
        self.assertEqual((await executor.execute("lookup", {}, self.context)).code, "denied")

    async def test_whitelist_and_unknown_names(self):
        result = await self.executor.execute("unregistered", {}, self.context)
        self.assertEqual(result.code, "denied")
        executor = ToolExecutor(self.registry, ToolPolicy(
            enabled=True, allowed_names={"unregistered"}))
        self.assertEqual((await executor.execute("unregistered", {}, self.context)).code, "unknown_tool")
        self.assertEqual(executor.schemas(self.context), [])

    async def test_invalid_json_missing_extra_wrong_type_and_oversize(self):
        for arguments in ("{", "[]", "null", {}, {"query": 7},
                          {"query": "x", "actor_id": "owner"},
                          {"query": "x" * 30}, {"query": "x" * 20000}):
            with self.subTest(arguments=str(arguments)[:60]):
                result = await self.executor.execute("lookup", arguments, self.context)
                self.assertEqual(result.code, "invalid_arguments")
        self.assertEqual(self.calls, [])

    async def test_truncation_is_bounded(self):
        self.registry.register(Tool("long", "Long", Arguments, lambda a, c: "x" * 500))
        executor = ToolExecutor(self.registry, ToolPolicy(
            enabled=True, allowed_names={"long"}, max_output_chars=100), self.events.append)
        result = await executor.execute("long", {}, self.context)
        self.assertTrue(result.truncated)
        self.assertLessEqual(len(result.content), 100)
        self.assertTrue(self.events[-1].truncated)

    async def test_async_timeout_not_retried(self):
        calls = []

        async def slow(args, context):
            calls.append(1)
            await asyncio.sleep(1)
            return "late"

        self.registry.register(Tool("slow", "slow", Arguments, slow,
                                    timeout_seconds=0.02, max_attempts=3))
        executor = ToolExecutor(self.registry, ToolPolicy(enabled=True, allowed_names={"slow"}))
        result = await executor.execute("slow", {}, self.context)
        self.assertEqual(result.code, "timeout")
        self.assertEqual(calls, [1])

    async def test_sync_handler_does_not_block_event_loop(self):
        def slow(args, context):
            time.sleep(0.15)
            return "done"

        self.registry.register(Tool("slow", "slow", Arguments, slow))
        executor = ToolExecutor(self.registry, ToolPolicy(enabled=True, allowed_names={"slow"}))
        task = asyncio.create_task(executor.execute("slow", {}, self.context))
        await asyncio.sleep(0.01)
        self.assertFalse(task.done())
        self.assertTrue((await task).ok)

    async def test_only_explicit_transient_errors_retry(self):
        calls = []

        def transient(args, context):
            calls.append(1)
            if len(calls) == 1:
                raise ToolTransientError("upstream")
            return "ok"

        self.registry.register(Tool("retry", "retry", Arguments, transient, max_attempts=2))
        executor = ToolExecutor(self.registry, ToolPolicy(enabled=True, allowed_names={"retry"}))
        result = await executor.execute("retry", {}, self.context)
        self.assertTrue(result.ok)
        self.assertEqual(result.attempts, 2)

    async def test_unexpected_failure_does_not_leak_or_retry(self):
        def broken(args, context):
            self.calls.append(1)
            raise RuntimeError("secret-api-key")

        self.registry.register(Tool("broken", "broken", Arguments, broken, max_attempts=3))
        executor = ToolExecutor(self.registry, ToolPolicy(enabled=True, allowed_names={"broken"}))
        result = await executor.execute("broken", {}, self.context)
        self.assertEqual(result.code, "execution_error")
        self.assertNotIn("secret", result.content)
        self.assertEqual(self.calls, [1])

    async def test_audit_failure_does_not_repeat_completed_call(self):
        def audit(event):
            raise RuntimeError("sink unavailable")

        executor = ToolExecutor(self.registry, self.policy, audit)
        result = await executor.execute("lookup", {"query": "x"}, self.context)
        self.assertTrue(result.ok)
        self.assertEqual(len(self.calls), 1)

    async def test_exhausted_transient_retry_is_bounded(self):
        async def unavailable(args, context):
            raise ToolTransientError("private upstream error")

        self.registry.register(Tool("unavailable", "unavailable", Arguments,
                                    unavailable, max_attempts=2))
        executor = ToolExecutor(self.registry, ToolPolicy(
            enabled=True, allowed_names={"unavailable"}), self.events.append)
        result = await executor.execute("unavailable", {}, self.context)
        self.assertEqual(result.code, "transient_error")
        self.assertEqual(result.attempts, 2)
        self.assertEqual(len(self.events), 1)
        self.assertNotIn("private", result.content)

    async def test_cancellation_propagates_and_is_audited(self):
        entered = asyncio.Event()

        async def pending(args, context):
            entered.set()
            await asyncio.Event().wait()

        self.registry.register(Tool("pending", "pending", Arguments, pending))
        executor = ToolExecutor(self.registry, ToolPolicy(
            enabled=True, allowed_names={"pending"}), self.events.append)
        task = asyncio.create_task(executor.execute("pending", {}, self.context))
        await entered.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.events[-1].code, "cancelled")

    async def test_sync_timeout_returns_before_worker_finishes(self):
        release, finished = threading.Event(), threading.Event()

        def slow(args, context):
            release.wait(1)
            finished.set()
            return "late"

        self.registry.register(Tool("slow", "slow", Arguments, slow,
                                    timeout_seconds=0.01, max_attempts=3))
        executor = ToolExecutor(self.registry, ToolPolicy(
            enabled=True, allowed_names={"slow"}), self.events.append)
        try:
            result = await executor.execute("slow", {}, self.context)
            self.assertEqual(result.code, "timeout")
            self.assertEqual(result.attempts, 1)
            self.assertFalse(finished.is_set())
        finally:
            release.set()
        self.assertTrue(await asyncio.to_thread(finished.wait, 1))

    def test_registration_rejects_duplicates_unknown_risk_and_unbounded_limits(self):
        for tool in (Tool("lookup", "duplicate", Query, lambda a, c: ""),
                     Tool("write", "write", Query, lambda a, c: "", risk="unsupported"),
                     Tool("bad", "bad", Query, lambda a, c: "", max_attempts=10),
                     Tool("bad", "bad", Query, lambda a, c: "", timeout_seconds=float("nan"))):
            with self.assertRaises(ValueError):
                self.registry.register(tool)

    async def test_writes_require_opt_in_and_cannot_retry(self):
        invoked = []
        self.registry.register(Tool('save_cost', 'save', Arguments, lambda a, c: invoked.append(True) or 'saved', risk='write'))
        denied = ToolExecutor(self.registry, ToolPolicy(enabled=True, allowed_names={'save_cost'}))
        self.assertEqual(denied.schemas(self.context), [])
        self.assertEqual((await denied.execute('save_cost', {}, self.context)).code, 'denied')
        self.assertEqual(invoked, [])
        allowed = ToolExecutor(self.registry, ToolPolicy(enabled=True, allow_writes=True, allowed_names={'save_cost'}))
        self.assertTrue((await allowed.execute('save_cost', {}, self.context)).ok)
        self.assertEqual(invoked, [True])
        with self.assertRaises(ValueError):
            self.registry.register(Tool('retry_write', 'bad', Arguments, lambda a, c: '', risk='write', max_attempts=2))

    def test_policy_rejects_invalid_limits(self):
        for value in (True, 1, 100.5, "8000", 70000):
            with self.assertRaises(ValueError):
                ToolPolicy(max_output_chars=value)
            with self.assertRaises(ValueError):
                ToolPolicy(max_argument_bytes=value)


class LyricsSearchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.registry = ToolRegistry()
        self.registry.register(lyrics_search.tool())
        self.registry.register(lyrics_search.read_tool())
        self.context = ToolContext("owner", "owner", "conversation", "lyrics-call")
        self.executor = ToolExecutor(self.registry, ToolPolicy(enabled=True,
            allowed_names=frozenset({"lyrics_search", "lyrics_read"}), max_output_chars=4000))

    async def test_read_pages_reconstruct_full_lyrics_without_silent_truncation(self):
        text = '正文测试\n' * 501
        row = {'id': 42, 'trackName': 'Song', 'artistName': 'Singer', 'plainLyrics': text}
        offset, chunks = 0, []
        with patch.object(lyrics_search, 'fetch_candidate', return_value=row):
            while True:
                result = await self.executor.execute('lyrics_read', {
                    'candidate_id': 42, 'title': 'Song', 'artist': 'Singer', 'offset': offset}, self.context)
                self.assertTrue(result.ok)
                self.assertFalse(result.truncated)
                payload = json.loads(result.content)
                chunks.append(payload['lyrics'])
                if payload['complete']:
                    self.assertIsNone(payload['next_offset'])
                    break
                self.assertGreater(payload['next_offset'], offset)
                offset = payload['next_offset']
        self.assertEqual(''.join(chunks), text)

    async def test_read_rejects_wrong_singer_and_out_of_range_offset(self):
        row = {'id': 42, 'trackName': 'Song', 'artistName': 'Singer', 'plainLyrics': 'short'}
        with patch.object(lyrics_search, 'fetch_candidate', return_value=row):
            for artist, offset in [('Wrong singer', 0), ('Singer', 999)]:
                result = await self.executor.execute('lyrics_read', {
                    'candidate_id': 42, 'title': 'Song', 'artist': artist, 'offset': offset}, self.context)
                self.assertEqual(result.code, 'denied')

    async def test_exact_metadata_returns_bounded_excerpt_and_source(self):
        row = {"id": 123, "trackName": "Thank You!", "artistName": "765 MILLIONSTARS",
               "albumName": "THE IDOLM@STER LIVE THE@TER PERFORMANCE", "duration": 251,
               "plainLyrics": "A" * 500}
        with patch.object(lyrics_search, "lookup", return_value=[row]):
            result = await self.executor.execute("lyrics_search", {
                "title": "Thank You!", "artist": "765 MILLIONSTARS"}, self.context)
        self.assertTrue(result.ok)
        payload = json.loads(result.content)
        self.assertEqual(payload["status"], "candidates")
        self.assertEqual(payload["candidates"][0]["id"], 123)
        self.assertEqual(len(payload["candidates"][0]["excerpt"]), 80)
        self.assertEqual(payload["candidates"][0]["source_url"], "https://lrclib.net/api/get/123")

    async def test_wrong_artist_is_rejected_then_google_only_fallback(self):
        row = {"id": 123, "trackName": "Thank You!", "artistName": "Another Singer",
               "plainLyrics": "wrong lyrics"}
        with patch.object(lyrics_search, "lookup", return_value=[row]), \
             patch.object(lyrics_search.web_search, "run_search", return_value={"results": []}) as search:
            result = await self.executor.execute("lyrics_search", {
                "title": "Thank You!", "artist": "765 MILLIONSTARS"}, self.context)
        payload = json.loads(result.content)
        self.assertEqual(payload["status"], "not_found")
        self.assertEqual(payload["candidates"], [])
        self.assertEqual(search.call_args.args[1], ["google"])
        self.assertEqual(search.call_args.args[2], 3)

    async def test_provider_failure_is_reported_without_retry(self):
        with patch.object(lyrics_search, "lookup", side_effect=TimeoutError), \
             patch.object(lyrics_search.web_search, "run_search", side_effect=web_search.ToolDenied("unavailable")) as search:
            result = await self.executor.execute("lyrics_search", {"title": "Missing"}, self.context)
        payload = json.loads(result.content)
        self.assertEqual(payload["status"], "not_found")
        self.assertIn("未重试", payload["provider_issue"])
        self.assertEqual(search.call_count, 1)

    async def test_case_sensitive_artist_api_query_falls_back_to_title_then_filters_exactly(self):
        correct = {'id': 42, 'trackName': 'Thank You!', 'artistName': '765 MILLIONSTARS',
                   'plainLyrics': '歌词正文'}
        with patch.object(lyrics_search, 'lookup', side_effect=[[], [correct]]) as lookup:
            payload = json.loads(lyrics_search.search(lyrics_search.LyricsArguments(
                title='Thank You!', artist='765millionstars'), self.context))
        self.assertEqual(lookup.call_count, 2)
        self.assertEqual(lookup.call_args_list[1].args[0].artist, '765 MILLIONSTARS')
        self.assertEqual(payload['status'], 'candidates')
        self.assertEqual(payload['candidates'][0]['artist'], '765 MILLIONSTARS')


class LocalFilesTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "sandbox"
        self.root.mkdir()
        (self.root / "note.txt").write_text("hello 牛奶", encoding="utf-8")
        self.files = LocalFiles(self.root, max_bytes=100)
        self.context = ToolContext("owner", "owner")
        self.executor = ToolExecutor(self.files.registry(), ToolPolicy(
            enabled=True, allowed_names={"local_dir", "local_read", "local_find", "local_info"}))

    async def test_four_tools(self):
        for name, arguments, expected in (
            ("local_read", {"path": "note.txt"}, "牛奶"),
            ("local_dir", {}, "note.txt"),
            ("local_find", {"name": "note"}, "note.txt"),
            ("local_info", {}, "100 字节"),
        ):
            result = await self.executor.execute(name, arguments, self.context)
            self.assertTrue(result.ok, result)
            self.assertIn(expected, result.content)

    async def test_parent_and_absolute_escapes(self):
        secret = self.root.parent / "secret.txt"
        secret.write_text("private", encoding="utf-8")
        for path in ("../secret.txt", str(secret), "x | cat", "a; cmd", "a > b"):
            result = await self.executor.execute("local_read", {"path": path}, self.context)
            self.assertEqual(result.code, "denied")

    async def test_symlink_escape_in_read_list_and_find(self):
        outside = self.root.parent / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("private", encoding="utf-8")
        try:
            (self.root / "escape").symlink_to(outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"Symlink permission unavailable: {exc}")
        result = await self.executor.execute("local_read", {"path": "escape/secret.txt"}, self.context)
        self.assertEqual(result.code, "denied")
        listing = await self.executor.execute("local_dir", {}, self.context)
        self.assertNotIn("escape", listing.content)
        found = await self.executor.execute("local_find", {"name": "secret"}, self.context)
        self.assertNotIn("secret.txt", found.content)

    async def test_byte_limit_and_binary_rejection(self):
        (self.root / "big.txt").write_text("糖" * 100, encoding="utf-8")
        result = await self.executor.execute("local_read", {"path": "big.txt"}, self.context)
        self.assertTrue(result.ok)
        self.assertIn("截断", result.content)
        self.assertLess(result.content.count("糖"), 100)
        (self.root / "binary").write_bytes(b"hello\x00world")
        result = await self.executor.execute("local_read", {"path": "binary"}, self.context)
        self.assertEqual(result.code, "denied")

    async def test_provisioning_waits_for_authorized_call(self):
        new_root = self.root / "new_sandbox"
        registry = LocalFiles(new_root).registry()
        executor = ToolExecutor(registry, ToolPolicy(
            enabled=True, allowed_names={"local_info"}))
        await executor.execute("local_info", {}, ToolContext("other", "owner"))
        self.assertFalse(new_root.exists())
        result = await executor.execute("local_info", {}, self.context)
        self.assertTrue(result.ok)
        self.assertTrue(new_root.is_dir())


class WebSearchTests(unittest.IsolatedAsyncioTestCase):
    """The adapter shells out to omnireach; everything here is about the boundary."""

    def setUp(self):
        self.events = []
        self.commands = []
        self.registry = ToolRegistry()
        self.registry.register(web_search.tool())
        self.context = ToolContext("owner", "owner", "conversation", "call1")
        self.executor = ToolExecutor(self.registry, ToolPolicy(
            enabled=True, allowed_names={"web_search"}), self.events.append)
        p = patch.object(web_search, "find_cli", return_value=Path("C:/fake/omnireach.exe"))
        p.start()
        self.addCleanup(p.stop)

    def fake_cli(self, payload, returncode=0):
        def run(command, **kwargs):
            self.commands.append((command, kwargs))
            stdout = payload.encode("utf-8") if isinstance(payload, str) else json.dumps(payload).encode("utf-8")
            return subprocess.CompletedProcess(command, returncode, stdout, b"")
        return patch.object(web_search.subprocess, "run", side_effect=run)

    async def test_results_become_plain_text_with_snippet_fallback(self):
        payload = {"results": [
            {"source": "google", "title": "标题", "url": "https://a.test/x", "content": "正文"},
            {"source": "hackernews", "title": "讨论", "url": "https://b.test/y", "content": "",
             "raw": {"snippet": "摘要兜底"}},
        ], "errors": []}
        with self.fake_cli(payload):
            result = await self.executor.execute("web_search", {"query": "牛奶 价格"}, self.context)
        self.assertTrue(result.ok)
        self.assertIn("[google] 标题", result.content)
        self.assertIn("摘要兜底", result.content)
        command, kwargs = self.commands[0]
        self.assertEqual(command[1:4], ["search", "--on", ",".join(web_search.SOURCES)])
        self.assertEqual(command[-2:], ["--", "牛奶 价格"])
        self.assertEqual(kwargs["env"]["PYTHONUTF8"], "1")
        self.assertEqual(len(self.events), 1)
        self.assertNotIn("牛奶 价格", repr(self.events))

    async def test_explicit_sources_and_limit_reach_the_cli(self):
        with self.fake_cli({"results": [{"source": "github", "title": "t", "url": "u", "content": "c"}]}):
            await self.executor.execute("web_search", {"query": "q", "sources": "GitHub, bilibili", "limit": 2}, self.context)
        command = self.commands[0][0]
        self.assertEqual(command[3], "github,bilibili")
        self.assertEqual(command[5], "2")

    async def test_empty_results_and_errors_say_so_instead_of_inventing(self):
        with self.fake_cli({"results": [], "errors": ["google: 429"]}):
            result = await self.executor.execute("web_search", {"query": "q"}, self.context)
        self.assertTrue(result.ok)
        self.assertIn("没有查到结果", result.content)
        self.assertIn("google: 429", result.content)

    async def test_unknown_source_timeout_and_missing_cli_are_denied_not_invented(self):
        result = await self.executor.execute("web_search", {"query": "q", "sources": "weibo"}, self.context)
        self.assertEqual(result.code, "denied")
        self.assertIn("weibo", result.content)
        self.assertEqual(self.commands, [])

        def timeout(command, **kwargs):
            raise subprocess.TimeoutExpired(command, kwargs.get("timeout"))
        with patch.object(web_search.subprocess, "run", side_effect=timeout):
            result = await self.executor.execute("web_search", {"query": "q"}, self.context)
        self.assertEqual(result.code, "denied")
        self.assertIn("超时", result.content)

        with patch.object(web_search, "find_cli", return_value=None):
            result = await self.executor.execute("web_search", {"query": "q"}, self.context)
        self.assertEqual(result.code, "denied")
        self.assertIn("omnireach", result.content)

    async def test_nonzero_exit_and_garbage_json_are_denied(self):
        with self.fake_cli("not json", returncode=2):
            result = await self.executor.execute("web_search", {"query": "q"}, self.context)
        self.assertEqual(result.code, "denied")
        self.assertIn("返回错误", result.content)
        with self.fake_cli("<html>oops</html>"):
            result = await self.executor.execute("web_search", {"query": "q"}, self.context)
        self.assertEqual(result.code, "denied")
        self.assertIn("无法解析", result.content)


if __name__ == "__main__":
    unittest.main()
