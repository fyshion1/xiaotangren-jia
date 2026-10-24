"""Compatibility facade for the optional tavern feature."""
from .. import tavern_feature


def __getattr__(name):
    if name.startswith("__"):
        raise AttributeError(name)
    return getattr(tavern_feature.load("card_import"), name)
