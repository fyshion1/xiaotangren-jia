"""Character default adapter; authored characters belong to the optional theme."""
from . import theme_feature
from .seed_profiles import neutral_profile
SEED_CHARACTERS = (theme_feature.load("characters").SEED_CHARACTERS if theme_feature.installed()
                   else [neutral_profile("assistant", "助手")])
