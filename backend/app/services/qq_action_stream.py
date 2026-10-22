"""Read only complete objects from the leading actions array, never nested text."""
import json
import re


class ActionStream:
    def __init__(self, *, defer_prefix=False):
        self.defer_prefix = defer_prefix
        self.buffer = ''
        self.cursor = None
        self.closed = False
        self.need_comma = False

    def feed(self, text):
        self.buffer += text
        if len(self.buffer) > 200000:
            raise ValueError('流式回复过长')
        if self.cursor is None:
            match = re.match(r'\s*\{\s*"actions"\s*:\s*\[', self.buffer)
            if not match:
                if len(self.buffer) > 200 and not self.defer_prefix:
                    raise ValueError('流式回复必须以 actions 数组开始')
                return []
            self.cursor = match.end()
        result = []
        while not self.closed:
            while self.cursor < len(self.buffer) and self.buffer[self.cursor].isspace():
                self.cursor += 1
            if self.cursor == len(self.buffer):
                break
            char = self.buffer[self.cursor]
            if char == ']':
                self.closed = True
                break
            if self.need_comma:
                if char != ',':
                    raise ValueError('流式动作之间缺少逗号')
                self.cursor += 1
                self.need_comma = False
                continue
            if char != '{':
                raise ValueError('流式动作必须是完整对象')
            try:
                item, end = json.JSONDecoder().raw_decode(self.buffer, self.cursor)
            except ValueError:
                break
            result.append(item)
            self.cursor = end
            self.need_comma = True
        return result
