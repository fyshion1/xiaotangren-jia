"""Local dashboard package management; importing never executes package code."""
import asyncio

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ..local_access import local_dashboard
from ..services import character_packs as packs, pack_catalog

router=APIRouter(prefix='/character-packs',tags=['character-packs'],dependencies=[Depends(local_dashboard)])
lock=asyncio.Lock()


@router.get('')
def listing():
    return packs.listing()


@router.get('/catalog')
def catalog():
    return pack_catalog.entries()


@router.post('/preview')
async def preview(file:UploadFile=File(...)):
    content=bytearray()
    try:
        while chunk:=await file.read(1024*1024):
            if len(content)+len(chunk)>packs.MAX_ARCHIVE:
                raise HTTPException(413,'角色包不能超过 64 MB')
            content.extend(chunk)
        async with lock:
            return await asyncio.to_thread(packs.stage,bytes(content))
    except packs.PackError as error:
        raise HTTPException(422,str(error)) from error
    finally:
        await file.close()


@router.post('/catalog/{catalog_id}/preview')
async def preview_catalog(catalog_id:str):
    try:
        async with lock:
            return await pack_catalog.preview(catalog_id)
    except packs.PackError as error:
        raise HTTPException(422,str(error)) from error
    except (httpx.HTTPError,OSError) as error:
        raise HTTPException(502,'发行文件下载失败，请检查连接后重试') from error


class Install(BaseModel):
    token:str=Field(pattern=r'^[a-f0-9]{32}$')


@router.post('/install')
async def install(body:Install):
    try:
        async with lock:
            return await asyncio.to_thread(packs.install,body.token)
    except packs.PackError as error:
        raise HTTPException(422,str(error)) from error


@router.post('/{pack_id}/uninstall')
async def uninstall(pack_id:str):
    try:
        async with lock:
            return await asyncio.to_thread(packs.uninstall,pack_id)
    except packs.PackError as error:
        raise HTTPException(404,str(error)) from error


@router.delete('/characters/{character_id}')
async def remove_character(character_id:str):
    try:
        async with lock:
            return await asyncio.to_thread(packs.remove_character,character_id)
    except packs.PackError as error:
        raise HTTPException(404,str(error)) from error
