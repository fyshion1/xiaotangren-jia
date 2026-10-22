"""Compatibility access to the optional knowledge tool bindings."""
def __getattr__(name):
    if name.startswith('__'):
        raise AttributeError(name)
    from .. import tool_feature
    return getattr(tool_feature.load('knowledge_tools'), name)
