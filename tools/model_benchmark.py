"""Standalone latency CLI. Credentials via environment or local feature config only."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.services.model_benchmark import probe


async def main():
    parser = argparse.ArgumentParser(description='上游短文本测速，每项一次生成，无自动重试；可能计费。')
    parser.add_argument('--feature', help='读取本体现有功能配置，如 qq_bridge；不修改配置')
    parser.add_argument('--base-url', default=os.getenv('MODEL_BASE_URL', ''))
    parser.add_argument('--model', action='append', help='可重复指定，最多3个候选；默认当前模型')
    parser.add_argument('--mode', choices=['stream', 'complete', 'both'], default='stream')
    parser.add_argument('--timeout', type=float, default=45)
    parser.add_argument('--max-tokens', type=int, default=512, help='输出预算，含部分模型的思考token，32～1024')
    parser.add_argument('--output', type=Path, help='保存不含密钥和聊天内容的JSON报告')
    args = parser.parse_args()
    cfg = {}
    if args.feature:
        from app.routers.nest import _effective_config
        cfg = _effective_config(args.feature)
    base = args.base_url or cfg.get('base_url', '')
    key = os.getenv('MODEL_API_KEY') or cfg.get('api_key', '')
    models = list(dict.fromkeys(args.model or [cfg.get('model') or os.getenv('MODEL_CHAT', '')]))
    if not base or not all(models) or len(models) > 3 or not 1 <= args.timeout <= 120 or not 32 <= args.max_tokens <= 1024:
        parser.error('需要base-url和model，最多3个型号，timeout为1～120秒')
    results = []
    for model in models:
        for stream in ([True, False] if args.mode == 'both' else [args.mode == 'stream']):
            result = await probe(base, key, model, stream=stream, timeout=args.timeout, max_tokens=args.max_tokens)
            results.append(result)
            print(json.dumps(result, ensure_ascii=False), flush=True)
    report = {'prompt': '固定三句短文本，不含私人聊天', 'max_output_tokens_per_request': args.max_tokens,
              'requests': len(results), 'results': results,
              'note': '单次样本；非流式首字延迟不可测。吞吐量为输出token/总耗时，包含等待。'}
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')


if __name__ == '__main__':
    asyncio.run(main())
