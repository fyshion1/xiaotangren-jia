"""Offline Mandarin keyword spotter; audio is never stored or sent upstream."""
from array import array
from pathlib import Path

MODEL = Path(__file__).resolve().parents[2] / 'data/asr/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01'
SUFFIX = 'epoch-99-avg-1-chunk-16-left-64.int8.onnx'


def ready():
    return all((MODEL / name).is_file() for name in ['tokens.txt', *(f'{part}-{SUFFIX}' for part in ('encoder', 'decoder', 'joiner'))])


class Spotter:
    def __init__(self):
        import sherpa_onnx
        if not ready():
            raise RuntimeError('keyword-model-missing')
        self.engine = sherpa_onnx.KeywordSpotter(tokens=str(MODEL / 'tokens.txt'),
            encoder=str(MODEL / f'encoder-{SUFFIX}'), decoder=str(MODEL / f'decoder-{SUFFIX}'),
            joiner=str(MODEL / f'joiner-{SUFFIX}'), num_threads=1,
            keywords_file=str(Path(__file__).with_name('pet_wake_keywords.txt')), keywords_score=1.5, keywords_threshold=0.3, num_trailing_blanks=2)
        self.stream = self.engine.create_stream()

    def feed(self, data):
        samples = array('h')
        samples.frombytes(data)
        self.stream.accept_waveform(16000, [x / 32768 for x in samples])
        while self.engine.is_ready(self.stream):
            self.engine.decode_stream(self.stream)
            result = self.engine.get_result(self.stream)
            if result:
                self.engine.reset_stream(self.stream)
                return result
        return ''
