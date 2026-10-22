"""Offline synthetic voice check. No microphone, LLM or cloud provider calls.

Run from backend: .venv/Scripts/python.exe tools/benchmark_local_voice.py
"""
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.local_voice import LocalRecognizer, PiperSynthesizer


async def main():
    import numpy as np

    text = '你好，我是小糖人，今天想和你聊天。'
    synth = PiperSynthesizer()
    runs = []
    pcm = b''
    for _ in range(2):
        started = time.perf_counter()
        chunks = []
        first = None
        async for chunk in synth(text, '', '', 'zh_CN-huayan-medium', ''):
            if first is None:
                first = time.perf_counter() - started
            chunks.append(chunk)
        pcm = b''.join(chunks)
        runs.append({'first_pcm_s': round(first, 3), 'total_s': round(time.perf_counter() - started, 3),
                     'chunks': len(chunks), 'audio_s': round(len(pcm) / 2 / synth.sample_rate, 3)})

    samples = np.frombuffer(pcm, dtype='<i2')
    size = round(len(samples) * 16000 / synth.sample_rate)
    audio = np.interp(np.arange(size) * synth.sample_rate / 16000, np.arange(len(samples)), samples).astype('<i2').tobytes()
    events = []
    started = time.perf_counter()
    async def heard(value, final, _utterance):
        events.append({'text': value, 'final': final, 'at_s': round(time.perf_counter() - started, 3)})
    recognizer = LocalRecognizer(heard)
    await recognizer.open()
    load_s = time.perf_counter() - started
    started = time.perf_counter()
    task = asyncio.create_task(recognizer.receive())
    try:
        # Include feature-window lookahead beyond the two-second endpoint threshold.
        stream = audio + b'\0' * 16000 * 2 * 4
        for offset in range(0, len(stream), 3200):
            await recognizer.audio(stream[offset:offset + 3200])
            await asyncio.sleep(.1)
        async with asyncio.timeout(5):
            while not any(event['final'] for event in events):
                await asyncio.sleep(.05)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await recognizer.close()
    result = {'input': text, 'tts_cold_warm': runs, 'asr_load_s': round(load_s, 3),
              'asr_audio_s': len(audio) / 32000, 'asr_events': events,
              'scope': 'synthetic audio, real-time paced PCM; no microphone or LLM'}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    asyncio.run(main())
