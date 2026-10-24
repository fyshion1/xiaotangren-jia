"""Check tracked release paths without opening local runtime files or secrets."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_NAMES = {'规划探讨.md', '角色设定.md', '项目坑点总结.md', '项目要求.txt', 'ui-preview.html'}
PRIVATE_PREFIXES = (
    'doc/', 'docs/plans/', 'docs/product/', 'docs/research/', 'docs/evaluations/',
    'docs/desktop-pet-review/', 'assets/酒馆角色卡/', '个人数据库/', '个人记忆库/',
    'backend/data/', 'backend/logs/', 'local-backups/', 'frontend/artifacts/',
)
EVAL_OUTPUTS = {'runs', 'model-plans', 'model-runs', 'validations', 'workflow-runs', 'topic-drift-runs'}


def violations(paths):
    errors = []
    for name in paths:
        parts = Path(name).parts
        if (name in PRIVATE_NAMES or name.startswith(PRIVATE_PREFIXES)
                or name in {'evals/memory/pilot-config.json', 'backend/config/runtime.json'}
                or (name.startswith('evals/memory/') and len(parts) > 2 and parts[2] in EVAL_OUTPUTS)
                or (name.startswith('docs/') and any('evidence' in part for part in parts))):
            errors.append(name)
    return errors


def main():
    result = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, check=True, capture_output=True)
    paths = [p for p in result.stdout.decode('utf-8').split('\0') if p]
    errors = violations(paths)
    if errors:
        print('Private or internal files must not be published:\n' + '\n'.join(errors))
        return 1
    print(f'PASS: public source boundary ({len(paths)} tracked paths). This is not a full secret or Git-history audit.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
