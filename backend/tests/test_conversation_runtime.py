import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db
from app.services import conversation_runtime as runtime, media_context


class SharedRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_wait_progress_at_30_and_60_seconds_and_cancel_cleanup(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(db, 'DB_PATH', Path(temp) / 'test.db'), patch.object(db, 'DATA_DIR', Path(temp)):
            db.init_db()
            events = []
            now = [0]
            async def sleep(seconds):
                now[0] += seconds
            async def emit(event):
                events.append(event)
                if len(events) == 2:
                    raise asyncio.CancelledError()
            with patch.object(runtime.asyncio, 'sleep', sleep), patch.object(runtime.time, 'monotonic', lambda: now[0]):
                state = runtime.Progress({'persona_id': 'me', 'session_id': 'one'}, 'request', 'core', emit)
                with self.assertRaises(asyncio.CancelledError):
                    await state.heartbeat()
            self.assertEqual([e['elapsed_seconds'] for e in events], [30, 60])
            self.assertIn('仍在等待', events[1]['text'])
            with db._tx() as conn:
                self.assertEqual(conn.execute("SELECT count(*) FROM conversation_events WHERE stage='waiting'").fetchone()[0], 2)

    def test_summary_metadata_never_leaks_across_arbitrary_chunk_boundaries(self):
        text = '角色回复。' + media_context.START + '{"image_summaries":[]}' + media_context.END
        for size in range(1, len(text)):
            parser = media_context.SummaryStream(True)
            visible = ''.join(parser.feed(text[i:i+size]) for i in range(0, len(text), size)) + parser.finish()
            self.assertEqual(visible, '角色回复。')
            self.assertEqual(parser.summaries(), [])
        parser = media_context.SummaryStream(True)
        self.assertEqual(parser.feed('角色回复。<media_') + parser.finish(), '角色回复。')

    async def test_initialization_failure_wakes_stream_consumer(self):
        async def consume():
            return [event async for event in runtime.transient_stream([], 'fake', 'http://unused')]
        with patch.object(runtime, 'record', side_effect=OSError('disk unavailable')):
            with self.assertRaisesRegex(OSError, 'disk unavailable'):
                await asyncio.wait_for(consume(), timeout=1)
