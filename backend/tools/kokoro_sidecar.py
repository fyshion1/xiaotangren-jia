"""Isolated CPU Kokoro service; run using the D-drive kokoro environment."""
import argparse
import threading
from pathlib import Path
import numpy as np
from fastapi import FastAPI, Form, HTTPException
from fastapi.responses import Response

app = FastAPI()
model = g2p = None
lock = threading.Lock()
VOICES = ('zf_001', 'zf_002', 'zf_003', 'zf_004')

@app.get('/speakers')
def speakers():
    return {'speakers': list(VOICES), 'sample_rate': 24000}

@app.post('/inference')
def inference(tts_text: str = Form(max_length=16000), spk_id: str = Form()):
    if spk_id not in VOICES or not tts_text.strip():
        raise HTTPException(400, 'invalid voice or text')
    with lock:
        phonemes, _ = g2p(tts_text)
        samples, _ = model.create(phonemes, voice=spk_id, speed=1.0, is_phonemes=True)
    return Response((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes(), media_type='application/octet-stream')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    args = parser.parse_args()
    from misaki import zh
    from kokoro_onnx import Kokoro
    import uvicorn
    root = Path(args.model_dir)
    g2p = zh.ZHG2P(version='1.1')
    model = Kokoro(str(root / 'kokoro-v1.1-zh.fp16.onnx.verified'), str(root / 'voices-v1.1-zh.bin.verified'), vocab_config=str(root / 'config.json'))
    uvicorn.run(app, host='127.0.0.1', port=50001)
