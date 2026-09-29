"""世界书示例词条种子。

首次启动时若 worldbook 表为空会写入这两条，用于演示「关键词触发」。
都是无害、可随时在「世界书」页编辑或删除的示例；带「（示例）」后缀以提醒。
"""

SEED_WORLDBOOK: list[dict] = [
    {
        "id": "wb-seed-dark",
        "title": "停电 / 打雷时（示例）",
        "keywords": "停电,打雷,跳闸,熄灯,怕黑",
        "content": "大诗音其实很怕黑，一停电或打雷就会不自觉地靠过来、轻轻抓住你的衣角。",
        "enabled": 1,
        "priority": 10,
    },
    {
        "id": "wb-seed-bakery",
        "title": "一起烤饼干（示例）",
        "keywords": "饼干,烘焙,烤,甜点",
        "content": "家里有周六下午一起烤饼干的小惯例，大诗音总会把最大的一块留给哥哥。",
        "enabled": 1,
        "priority": 5,
    },
]