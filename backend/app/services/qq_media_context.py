"""Compatibility alias: storage and policy now belong to the shared media service."""
import sys
from . import media_context
sys.modules[__name__] = media_context
