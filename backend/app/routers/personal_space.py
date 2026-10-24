"""Metadata for optional personal-space panels; user data stays in the host."""
from fastapi import APIRouter
from .. import personal_space

router = APIRouter(prefix='/personal-space', tags=['personal-space'])


@router.get('/panels')
def panels():
    # No document names or content is returned. This is panel availability,
    # not an authorization check or a replacement for the document API.
    return {'api_version': 1, 'items': [personal_space.panel(identifier) for identifier in personal_space.PANELS]}
