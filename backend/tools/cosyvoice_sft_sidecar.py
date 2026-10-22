"""Run with a separately installed CosyVoice-300M-SFT environment.

Example: python cosyvoice_sft_sidecar.py --model-dir path/to/CosyVoice-300M-SFT
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException
from fastapi.responses import StreamingResponse

app = FastAPI()
model = None


@app.get('/speakers')
def speakers():
    if model is None:
        raise HTTPException(503, 'model not loaded')
    return {'speakers': model.list_available_spks(), 'sample_rate': model.sample_rate}


@app.post('/inference_sft_stream')
def inference_sft_stream(tts_text: str = Form(), spk_id: str = Form()):
    if model is None:
        raise HTTPException(503, 'model not loaded')
    if spk_id not in model.list_available_spks():
        raise HTTPException(400, 'unknown speaker')

    def audio():
        import numpy as np
        for result in model.inference_sft(tts_text, spk_id, stream=True):
            yield (result['tts_speech'].numpy() * 32767).astype(np.int16).tobytes()

    return StreamingResponse(audio(), media_type='application/octet-stream')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--cosyvoice-dir', required=True)
    parser.add_argument('--fp16', action='store_true')
    args = parser.parse_args()
    root = Path(args.cosyvoice_dir).resolve()
    sys.path.insert(0, str(root))
    sys.path.insert(0, str(root / 'third_party' / 'Matcha-TTS'))
    from cosyvoice.cli.cosyvoice import AutoModel
    import uvicorn

    model = AutoModel(model_dir=args.model_dir, fp16=args.fp16)
    if model.sample_rate != 22050 or not model.list_available_spks():
        raise SystemExit('需要 CosyVoice-300M-SFT，采样率 22050 Hz，且具有预置音色')
    uvicorn.run(app, host='127.0.0.1', port=50000)
