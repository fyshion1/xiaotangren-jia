"""Local packages plus explicitly configured, SHA-pinned GitHub downloads."""
import asyncio
import hashlib
import ipaddress
import json
import re
import socket
import time
from urllib.parse import urljoin, urlsplit

import httpx

from .. import db
from ..data_paths import features_root
from . import character_packs as packs

FEATURES_DIR = features_root()
HOSTS = {'github.com','raw.githubusercontent.com','objects.githubusercontent.com','release-assets.githubusercontent.com'}


def entries():
    items=[]
    errors=[]
    for path in FEATURES_DIR.glob('*/character-pack.zip'):
        if path.is_symlink() or path.parent.is_symlink():
            continue
        try:
            if path.stat().st_size > packs.MAX_ARCHIVE:
                raise packs.PackError('文件超过 64 MB')
            content=path.read_bytes()
            manifest,_=packs.parse(content)
            items.append({k:manifest[k] for k in ('id','name','version','author','license','description')} | {
                'catalog_id':'local.'+path.parent.name,'source':'local','sha256':hashlib.sha256(content).hexdigest(),
                'bytes':len(content),'character_count':len(manifest['characters'])})
        except (OSError,ValueError) as error:
            errors.append({'source':'local.'+path.parent.name,'message':str(error)})
    configuration=db.DATA_DIR / 'market-catalog.json'
    if configuration.is_file():
        try:
            if configuration.stat().st_size > 256*1024:
                raise ValueError('目录配置过大')
            data=json.loads(configuration.read_text(encoding='utf-8-sig'))
            if not isinstance(data,list) or len(data)>100:
                raise ValueError('目录配置应为不超过 100 项的列表')
            seen={item['catalog_id'] for item in items}
            for entry in data:
                if not isinstance(entry,dict) or entry.get('kind')!='character-pack':
                    raise ValueError('目前在线目录仅支持 character-pack')
                for key in ('id','name','version','author','license','description','url','sha256'):
                    if not isinstance(entry.get(key),str) or len(entry[key])>4000 or not entry[key].strip():
                        raise ValueError('目录项缺少必要文字字段')
                if not packs.ID.fullmatch(entry['id']) or not re.fullmatch(r'[a-f0-9]{64}',entry['sha256']):
                    raise ValueError('目录 ID 或 SHA-256 无效')
                validate_url(entry['url'])
                catalog_id='github.'+entry['id']
                if catalog_id in seen:
                    raise ValueError('目录 ID 重复')
                seen.add(catalog_id)
                items.append({k:entry[k] for k in ('id','name','version','author','license','description','url','sha256')} |
                             {'catalog_id':catalog_id,'source':'github'})
        except (OSError,ValueError) as error:
            errors.append({'source':'market-catalog.json','message':str(error)})
    return {'api_version':1,'items':items,'errors':errors,
            'note':'本机包与本机配置的 GitHub 发行目录；尚无公共中心市场服务。'}


def validate_url(url):
    try:
        parsed=urlsplit(url)
        port=parsed.port
    except ValueError as error:
        raise packs.PackError('下载地址格式无效') from error
    if (parsed.scheme!='https' or parsed.hostname not in HOSTS or port not in (None,443)
            or parsed.username or parsed.password or parsed.fragment):
        raise packs.PackError('下载地址仅支持 HTTPS GitHub 发行文件及其官方资源域名')
    return parsed


def _public_host(hostname):
    addresses=socket.getaddrinfo(hostname,443,type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise packs.PackError('下载域名解析到非公网地址，已停止')


async def download(entry):
    url=entry['url']
    started=time.monotonic()
    async with httpx.AsyncClient(timeout=httpx.Timeout(20,connect=10),follow_redirects=False) as client:
        for _ in range(6):
            parsed=validate_url(url)
            await asyncio.to_thread(_public_host,parsed.hostname)
            async with client.stream('GET',url,headers={'User-Agent':'CharacterPack/1'}) as response:
                if response.status_code in (301,302,303,307,308):
                    location=response.headers.get('location')
                    if not location:
                        raise packs.PackError('发行文件重定向无效')
                    url=urljoin(url,location)
                    continue
                if response.status_code!=200:
                    raise packs.PackError(f'发行文件下载失败（HTTP {response.status_code}）')
                buffer=bytearray()
                async for chunk in response.aiter_bytes():
                    if len(buffer)+len(chunk)>packs.MAX_ARCHIVE or time.monotonic()-started>60:
                        raise packs.PackError('角色包下载超过体积或时间限制')
                    buffer.extend(chunk)
                content=bytes(buffer)
                if hashlib.sha256(content).hexdigest()!=entry['sha256']:
                    raise packs.PackError('角色包 SHA-256 与目录声明不一致，未安装')
                return content
        raise packs.PackError('发行文件重定向次数过多')


async def preview(catalog_id):
    entry=next((item for item in entries()['items'] if item['catalog_id']==catalog_id),None)
    if entry is None:
        raise packs.PackError('目录项不存在')
    if entry['source']=='local':
        folder=catalog_id[len('local.'):]
        if not packs.ID.fullmatch(folder):
            raise packs.PackError('目录 ID 无效')
        path=FEATURES_DIR / folder / 'character-pack.zip'
        if path.is_symlink() or path.parent.is_symlink():
            raise packs.PackError('本机包路径异常')
        if path.stat().st_size > packs.MAX_ARCHIVE:
            raise packs.PackError('文件超过 64 MB')
        content=await asyncio.to_thread(path.read_bytes)
    else:
        content=await download(entry)
    if hashlib.sha256(content).hexdigest()!=entry['sha256']:
        raise packs.PackError('目录文件已经改变，请刷新后重试')
    manifest,_=packs.parse(content)
    if manifest['id']!=entry['id'] or manifest['version']!=entry['version']:
        raise packs.PackError('角色包 ID 或版本与目录声明不一致')
    return await asyncio.to_thread(packs.stage,content)
