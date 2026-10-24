"""Build a declarative character ZIP from a source JSON and local images.

Run with backend/.venv/Scripts/python.exe tools/build_character_pack.py source.json output.zip.
Image fields in source.json are relative to that JSON file. No database is read.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from app.services import assets, character_packs


def build(source: Path) -> bytes:
    manifest = json.loads(source.read_text(encoding='utf-8-sig'))
    if not isinstance(manifest, dict) or manifest.get('assets') not in (None, {}):
        raise ValueError('源清单 assets 应为空；资源由打包工具生成')
    files = {}
    declarations = {}
    root = source.resolve().parent

    def convert(value):
        if isinstance(value, list):
            return [convert(item) for item in value]
        if not isinstance(value, dict):
            return value
        output = {}
        for key, item in value.items():
            if key in ('avatar', 'portrait') and item:
                if not isinstance(item, str):
                    raise ValueError('图片路径应为字符串')
                path = (root / item).resolve()
                if Path(item).is_absolute() or not path.is_relative_to(root):
                    raise ValueError('图片必须位于源清单所在目录内')
                if path.stat().st_size > assets.MAX_BYTES:
                    raise ValueError('图片超过 20 MB')
                content = path.read_bytes()
                _, extension = assets.inspect_image(content)
                sha = hashlib.sha256(content).hexdigest()
                name = f'assets/{sha}.{extension}'
                files[name] = content
                declarations[sha] = dict(path=name, sha256=sha)
                output[key] = 'asset:' + sha
            else:
                output[key] = convert(item)
        return output

    manifest['characters'] = convert(manifest['characters'])
    manifest['assets'] = declarations
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
        for name, content in sorted(files.items()):
            archive.writestr(name, content)
    content = stream.getvalue()
    character_packs.parse(content)
    return content


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error('输出文件已存在；请明确移走旧包或选择新文件名')
    try:
        content = build(args.source)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('xb') as output:
            output.write(content)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.exit(1, f'打包失败：{error}\n')
    print(f'已生成 {args.output.name}，{len(content)} bytes')
    print('SHA-256: ' + hashlib.sha256(content).hexdigest())


if __name__ == '__main__':
    main()
