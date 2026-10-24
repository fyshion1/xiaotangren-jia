"""Neutral defaults; stable legacy identity IDs preserve sessions and memory."""
from . import theme_feature
MAIN_PERSONA_ID = "dalaoda"

def neutral_profile(profile_id, name):
    profile = dict.fromkeys((
        "jp", "birthday", "age", "height", "bloodType", "constellation",
        "catchphrase", "bodyType", "eyeColor", "hairstyle", "hairColor",
        "bust", "hip", "clothing", "occupation", "relationships",
        "specialFeatures", "weight", "measurements", "secret", "weakPoint", "privateWish",
    ), "")
    profile.update(id=profile_id, name=name, alias="可自定义", emoji="💬",
                   about="", relation="", personality=[], likes=[], dislikes=[],
                   asCharacter=False, baseFormName="默认", forms=[],
                   hiddenFields=["bust", "hip", "measurements"])
    return profile

SEED_PROFILES = (theme_feature.load("profiles").SEED_PROFILES if theme_feature.installed()
                 else [neutral_profile(MAIN_PERSONA_ID, "用户")])
