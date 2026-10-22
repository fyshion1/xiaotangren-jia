"""Probe the shared local intent gate without generating replies or running tools."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.services.intent_router import classify


def main():
    parser = argparse.ArgumentParser(description='本地意图检测：不调用付费模型，不执行工具，不写入聊天或记忆。')
    parser.add_argument('text', nargs='+', help='要检测的文本，可传多条以比较首次与后续耗时')
    args = parser.parse_args()
    for text in args.text:
        print(json.dumps(classify(text).payload(), ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
