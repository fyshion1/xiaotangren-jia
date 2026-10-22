"""Explicit opt-in QQ smoke: real model/owner DM, withdraw test output and delete test rows."""
import argparse
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'features/qq-bridge'))
from qqbridge import config
from qqbridge.brain import BrainClient
from qqbridge.bridge import Bridge, AccountRunner
from qqbridge.onebot import Event


async def main(text):
    brain = BrainClient(str((config.load().get('brain') or {}).get('base_url') or 'http://127.0.0.1:8000'))
    bridge = Bridge(brain)
    bridge.settings.pull(quiet=True)
    cfg = config.load()
    owner = str(cfg.get('owner', {}).get('qq') or '')
    if not owner.isdigit():
        raise RuntimeError('No configured owner')
    ids, platform_ids, assistant_ids = [], [], []
    failures = []
    def log(message):
        print(message, flush=True)
        if any(value in message for value in ('⚠ 本轮回复未完成', '⚠ 本轮等待已中断', '本轮没有发送角色回复')):
            failures.append(message)
    bridge.log = log
    original_inbound, original_delivered, original_finish = brain.qq_inbound, brain.qq_delivered, brain.qq_finish
    def inbound(payload):
        result = original_inbound(payload)
        ids.extend(result.get('message_ids', []))
        return result
    def delivered(payload):
        result = original_delivered(payload)
        ids.extend(result.get('message_ids', []))
        assistant_ids.extend(result.get('message_ids', []))
        return result
    brain.qq_inbound, brain.qq_delivered = inbound, delivered
    brain.qq_finish = lambda session, auto_memory=True: original_finish(session, False)
    with tempfile.TemporaryDirectory(prefix='qq-smoke-') as folder:
        config.STATE_DIR = Path(folder)
        runner = AccountRunner(bridge, cfg, config.accounts(cfg)[0], 0)
        runner.refresh_roster()
        # Receive no live traffic in this second connection; inject only the test turn.
        async def ignore(event):
            pass
        runner.client.on_event = ignore
        runner.client.on_notice = None
        original_send = runner.client.send
        async def send(event, segments):
            if event.is_group or event.user_id != owner:
                raise RuntimeError('Smoke must only send owner DM')
            result = await original_send(event, segments)
            mid = (result.get('data') or {}).get('message_id')
            if mid is not None:
                platform_ids.append(str(mid))
            return result
        runner.client.send = send
        task = asyncio.create_task(runner.client.run_forever())
        started = time.monotonic()
        try:
            await asyncio.wait_for(runner.client.connected.wait(), 15)
            event = Event(kind='private', user_id=owner, self_id=str(runner.account['self_id']),
                          message_id='smoke-' + uuid.uuid4().hex, nickname='主人链路测试',
                          segments=[{'type': 'text', 'data': {'text': text}}])
            await runner.flow.accept(event)
            async with asyncio.timeout(180):
                while runner.flow.tasks or runner.flow.sending:
                    await asyncio.sleep(.2)
            print(json.dumps({'elapsed_seconds': round(time.monotonic()-started, 2),
                              'sent': len(platform_ids), 'test_rows': len(ids)}, ensure_ascii=False), flush=True)
            if not assistant_ids or failures:
                raise RuntimeError('Reply incomplete or no confirmed assistant output')
        finally:
            for mid in platform_ids:
                result = await runner.client.call('delete_msg', {'message_id': mid})
                print('withdraw', mid, result.get('status'), result.get('retcode'), flush=True)
            if ids:
                result = await asyncio.to_thread(brain._request, '/api/messages/delete', {'ids': ids})
                print('cleanup', json.dumps(result, ensure_ascii=False), flush=True)
            await runner.flow.close()
            runner.client.stop()
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', required=True)
    parser.add_argument('--text', default='【链路测试，稍后自动清理】小糖人晚上好呀，请用一句简短的话回应我。')
    args = parser.parse_args()
    asyncio.run(main(args.text))
