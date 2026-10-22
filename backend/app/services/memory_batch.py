"""自动整理防抖：安静 30 秒或首条等待 120 秒后处理；原文始终先落库。"""
import asyncio
import logging
import time

_pending = {}
_tasks = set()
QUIET_SECONDS = 30
MAX_SECONDS = 120


async def stop():
    tasks = list(_tasks)
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    _pending.clear()


def enqueue(key, callback, *args):
    clock = time.monotonic()
    if key in _pending:
        state = _pending[key]
        state.update(last=clock, callback=callback, args=args)
        return
    state = dict(first=clock, last=clock, callback=callback, args=args)
    _pending[key] = state

    async def run():
        try:
            while True:
                delay = min(state['last'] + QUIET_SECONDS, state['first'] + MAX_SECONDS) - time.monotonic()
                if delay <= 0:
                    break
                await asyncio.sleep(delay)
            _pending.pop(key, None)
            await state['callback'](*state['args'])
        except Exception:
            logging.getLogger(__name__).exception('合批记忆整理失败；原文已保存，可手动重新整理')
        finally:
            if _pending.get(key) is state:
                _pending.pop(key, None)

    task = asyncio.create_task(run())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
