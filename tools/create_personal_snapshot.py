"""Local-only snapshot; no application imports, Git mutations, or service startup."""
from __future__ import annotations

import hashlib
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import time
from datetime import datetime, timezone
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def git(folder: Path, *args: str) -> bytes:
    return subprocess.check_output(['git', '-C', str(folder), *args])


def main() -> None:
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    destination = ROOT.parent / (ROOT.name + '-local-backups')
    destination.mkdir(exist_ok=True)
    archive = destination / f'personal-snapshot-{stamp}.partial'
    files: dict[str, Path] = {}
    manifest = {'created_utc': stamp, 'root': str(ROOT), 'repositories': [],
                'files': [], 'missing': [], 'changed_during_read': [],
                'excluded': ['backend/data/models', 'backend/data/tts',
                             'Git-ignored files except explicitly selected private data/config',
                             'Git history; dependencies; external feature runtime data'],
                'limitations': 'Live per-file snapshot; no cross-file transaction consistency.'}

    def source_repo(folder: Path, prefix: str) -> None:
        revision = subprocess.run(['git', '-C', str(folder), 'rev-parse', '--verify', 'HEAD'],
                                  capture_output=True)
        manifest['repositories'].append({
            'path': prefix or '.', 'head': revision.stdout.decode().strip() if revision.returncode == 0 else None,
            'status': git(folder, '-c', 'core.quotepath=false', 'status', '--porcelain').decode('utf-8'),
        })
        names = git(folder, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')
        for raw in names.split(b'\0'):
            if not raw:
                continue
            relative = raw.decode('utf-8')
            path = folder / relative
            if path.is_file() and not path.is_symlink():
                files[f'workspace/{prefix}{relative}'] = path

    source_repo(ROOT, '')
    for feature in (ROOT / 'features').iterdir():
        if feature.is_dir() and (feature / '.git').exists():
            source_repo(feature, f'features/{feature.name}/')

    def tree(folder: Path, prefix: str, exclude: set[str] | None = None) -> None:
        if not folder.exists():
            manifest['missing'].append(str(folder))
            return
        for current, dirs, names in os.walk(folder, followlinks=False):
            base = Path(current)
            dirs[:] = [d for d in dirs if not (base / d).is_symlink()
                       and not (base == folder and d in (exclude or set()))]
            for name in names:
                path = base / name
                if not path.is_symlink():
                    files[prefix + path.relative_to(folder).as_posix()] = path

    tree(ROOT / 'backend/data', 'workspace/backend/data/', {'models', 'tts'})
    # Read only these path settings; never execute .env or print its contents.
    env_paths = {}
    for env_file in (ROOT / '.env', ROOT / 'backend/.env'):
        if env_file.is_file():
            files['workspace/' + env_file.relative_to(ROOT).as_posix()] = env_file
            for line in env_file.read_text(encoding='utf-8-sig').splitlines():
                key, sep, value = line.partition('=')
                if sep and key.strip() in {'PERSONAL_DATABASE_ROOT', 'PERSONAL_MEMORY_ROOT'}:
                    env_paths[key.strip()] = value.strip().strip('\"\'')
    for key, default in [('PERSONAL_DATABASE_ROOT', '个人数据库'),
                         ('PERSONAL_MEMORY_ROOT', '个人记忆库')]:
        value = os.environ.get(key) or env_paths.get(key)
        path = Path(value).expanduser() if value else ROOT / default
        if not path.is_absolute():
            raise RuntimeError(f'{key} is relative; specify its actual absolute runtime path before backup')
        tree(path, f'workspace/{default}/')

    with tempfile.TemporaryDirectory() as temporary, zipfile.ZipFile(
            archive, 'x', compression=zipfile.ZIP_DEFLATED) as output:
        print(f'Snapshotting {len(files)} files', flush=True)
        for index, (name, source) in enumerate(sorted(files.items())):
            if index % 100 == 0:
                print(f'Files processed: {index}', flush=True)
            if name.endswith(('-wal', '-shm', '-journal')):
                continue
            before = source.stat()
            if source.suffix.lower() in {'.db', '.sqlite', '.sqlite3'}:
                copied = Path(temporary) / 'backup.sqlite'
                started = time.monotonic()
                def progress(status, remaining, total):
                    if time.monotonic() - started > 45:
                        raise TimeoutError('SQLite backup exceeded 45 seconds')
                with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)) as origin:
                    with closing(sqlite3.connect(copied)) as backup:
                        origin.backup(backup, pages=128, progress=progress)
                        if backup.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                            raise RuntimeError(f'Database integrity check failed: {name}')
                data = copied.read_bytes()
                copied.unlink()
            else:
                data = source.read_bytes()
            after = source.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                manifest['changed_during_read'].append(name)
            output.writestr(name, data)
            manifest['files'].append({'path': name, 'bytes': len(data),
                                      'sha256': hashlib.sha256(data).hexdigest()})
        output.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(archive) as check:
        if check.testzip() is not None:
            raise RuntimeError('ZIP verification failed')
        for entry in manifest['files']:
            if hashlib.sha256(check.read(entry['path'])).hexdigest() != entry['sha256']:
                raise RuntimeError('Snapshot hash mismatch')
    complete = archive.with_suffix('.zip')
    archive.rename(complete)
    archive = complete
    print(json.dumps({'archive': str(archive), 'files': len(manifest['files']),
                      'bytes': archive.stat().st_size, 'repositories': len(manifest['repositories']),
                      'missing': manifest['missing'],
                      'changed_during_read': manifest['changed_during_read'],
                      'verification': 'zip CRC, per-file SHA-256, SQLite integrity_check passed'},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
