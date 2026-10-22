"""Extract optional user reply choices from the same generated answer."""
import json

START = '<reply_suggestions>'
END = '</reply_suggestions>'
INSTRUCTIONS = ('\n正常角色回复结束后，在同一次输出中附加 ' + START +
                '["候选一","候选二","候选三"]' + END +
                '。数组最多3个不同的简短中文回复，每个不超过60字，是用户下一句可能对你说的话，'
                '紧扣本轮对话、符合用户身份，不代替用户决定，不是角色继续说的话；不用HTML或Markdown。'
                '这是界面附录，不在正文解释。若另有图片摘要附录，两个附录分别完整闭合。')


def add_instructions(messages):
    if messages and messages[0].get('role') == 'system':
        messages[0]['content'] += INSTRUCTIONS
    else:
        messages.insert(0, {'role': 'system', 'content': INSTRUCTIONS.strip()})


class SuggestionStream:
    """Hide tagged metadata across arbitrary token boundaries, without buffering speech."""
    def __init__(self, enabled=False):
        self.enabled = enabled
        self.buffer = ''
        self.inside = False
        self.metadata = ''
        self.overflow = False
        self.candidates = []

    def collect(self, text):
        if len(self.metadata) + len(text) > 8192:
            self.overflow = True
        if not self.overflow:
            self.metadata += text

    def parse(self):
        if self.overflow:
            return
        try:
            values = json.loads(self.metadata)
        except (ValueError, TypeError):
            return
        if isinstance(values, list):
            for value in values:
                if isinstance(value, str) and value.strip():
                    value = value.strip()[:60]
                    if value not in self.candidates and len(self.candidates) < 3:
                        self.candidates.append(value)

    def feed(self, text):
        if not self.enabled:
            return text
        self.buffer += text
        visible = []
        while self.buffer:
            marker = END if self.inside else START
            pos = self.buffer.find(marker)
            if pos >= 0:
                prefix, self.buffer = self.buffer[:pos], self.buffer[pos + len(marker):]
                if self.inside:
                    self.collect(prefix)
                    self.parse()
                else:
                    visible.append(prefix)
                    self.metadata = ''
                    self.overflow = False
                self.inside = not self.inside
                continue
            keep = next((n for n in range(min(len(marker) - 1, len(self.buffer)), 0, -1)
                         if self.buffer.endswith(marker[:n])), 0)
            prefix = self.buffer[:-keep] if keep else self.buffer
            self.buffer = self.buffer[-keep:] if keep else ''
            if self.inside:
                self.collect(prefix)
            else:
                visible.append(prefix)
            break
        return ''.join(visible)

    def finish(self):
        tail, self.buffer = self.buffer, ''
        return '' if self.inside or (tail and START.startswith(tail)) else tail
