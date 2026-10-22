"""私人空间的中性身份模板。

仅补种缺失档案，不覆盖用户编辑；稳定 ID 保留既有会话和记忆关联。
未填写的个人资料不代表用户的真实信息，用户可在私人空间自行补充。
"""

MAIN_PERSONA_ID = "dalaoda"


def _profile(profile_id: str, name: str, alias: str, emoji: str, as_character: bool) -> dict:
    profile = dict.fromkeys((
        "jp", "birthday", "age", "height", "bloodType", "constellation",
        "catchphrase", "bodyType", "eyeColor", "hairstyle", "hairColor",
        "bust", "hip", "clothing", "occupation", "relationships",
        "specialFeatures", "weight", "measurements", "secret", "weakPoint", "privateWish",
    ), "")
    profile.update({
        "id": profile_id,
        "name": name,
        "alias": alias,
        "emoji": emoji,
        "about": "这是你在小糖人之家使用的身份。你可以自行设置称呼、个人介绍、兴趣和交流偏好。未填写的资料不作预设。",
        "personality": [],
        "likes": [],
        "dislikes": [],
        "relation": "你是小糖人之家的成员，与大家平等交流。具体称呼、关系和相处方式由你自行设定。",
        "asCharacter": as_character,
        "baseFormName": "日常",
        "forms": [],
        "hiddenFields": ["bust", "hip", "measurements"],
    })
    return profile


SEED_PROFILES: list[dict] = [
    _profile("dalaoda", "主人", "默认身份 · 可自定义", "🐻", True),
    _profile("xizi", "自定义身份", "备用身份 · 可自定义", "🌊", False),
]
