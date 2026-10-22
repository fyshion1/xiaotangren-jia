"""Run a trusted installed feature with the local host SDK in its own process."""
import asyncio
import signal

from . import db, optional_plugins


async def run():
    db.init_db()
    if not optional_plugins.available():
        raise SystemExit('专家模式未启用或插件未安装')
    plugin = optional_plugins.load()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    def request_stop(*_):
        loop.call_soon_threadsafe(stop.set)
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    if hasattr(signal, 'SIGBREAK'):
        signal.signal(signal.SIGBREAK, request_stop)
    plugin.start()
    try:
        while optional_plugins.available() and not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=1)
            except asyncio.TimeoutError:
                pass
    finally:
        await plugin.stop()


if __name__ == '__main__':
    asyncio.run(run())
