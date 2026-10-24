import asyncio
import copy
import hashlib
import io
import json
import os
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app import db
from app.routers import character_packs as routes
from app.services import character_packs as packs, pack_catalog as catalog

HEADERS = {'X-Exploration-Dashboard': '1'}


def fixture():
    image = io.BytesIO()
    Image.new('RGB', (8, 8), 'red').save(image, 'PNG')
    content = image.getvalue()
    sha = hashlib.sha256(content).hexdigest()
    manifest = dict(format='character-pack', format_version=1, id='example.roles', name='测试角色包',
                    version='1.0.0', author='Test author', license='Test fixtures only', description='测试资料',
                    characters=[dict(id='guide', name='向导', about='原始设定', avatar='asset:'+sha,
                                     forms=[dict(id='alternate', name='其他形态', fields=dict(portrait='asset:'+sha))])],
                    assets={sha: dict(path=f'assets/{sha}.png', sha256=sha)})
    return manifest, {f'assets/{sha}.png': content}


def archive(manifest=None, files=None):
    if manifest is None:
        manifest, files = fixture()
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False))
        for name, content in (files or {}).items():
            z.writestr(name, content)
    return stream.getvalue()


class CharacterPackTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for obj, key, value in [(db, 'DATA_DIR', self.root / 'data'),
                                (db, 'DB_PATH', self.root / 'data/test.db'),
                                (db, 'SEED_CHARACTERS', []), (db, 'SEED_PROFILES', []),
                                (catalog, 'FEATURES_DIR', self.root / 'features')]:
            p = patch.object(obj, key, value)
            p.start()
            self.addCleanup(p.stop)
        db.init_db()
        app = FastAPI()
        app.include_router(routes.router, prefix='/api')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def preview(self, content=None):
        response = self.client.post('/api/character-packs/preview', headers=HEADERS,
                                    files={'file': ('pack.zip', content or archive(), 'application/zip')})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_preview_install_update_uninstall_preserve_user_data(self):
        preview = self.preview()
        identifier = packs.character_id('example.roles', 'guide')
        self.assertIsNone(db.get_character(identifier))
        response = self.client.post('/api/character-packs/install', headers=HEADERS, json={'token':preview['token']})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['created'], [identifier])
        role = db.get_character(identifier)
        self.assertFalse(role.get('imported'))
        self.assertEqual(role['characterPackId'], 'example.roles')
        self.assertTrue(role['avatar'].startswith('/api/assets/'))
        self.assertEqual(role['forms'][0]['fields']['portrait'], role['avatar'])
        self.assertEqual(len(list((db.DATA_DIR/'assets').iterdir())), 1)
        role['about'] = '用户修改的设定'
        db.upsert_character(identifier, role)
        db.append_message('single-'+identifier, 'user', '测试聊天')
        manifest, files = fixture()
        manifest['version'] = '1.1.0'
        manifest['characters'].append(dict(id='new', name='新角色'))
        updated = packs.install(self.preview(archive(manifest, files))['token'])
        self.assertEqual(updated['preserved'], [identifier])
        self.assertEqual(len(updated['created']), 1)
        self.assertEqual(db.get_character(identifier), role)
        packs.uninstall('example.roles')
        self.assertFalse(packs.listing()['items'][0]['installed'])
        self.assertEqual(db.get_character(identifier), role)
        self.assertEqual(len(db.list_messages('single-'+identifier)), 1)
        self.assertEqual(len(list((db.DATA_DIR/'assets').iterdir())), 1)
        result = packs.install(self.preview(archive(manifest, files))['token'])
        self.assertEqual(result['created'], [])
        self.assertEqual(len(result['preserved']), 2)

    def test_explicit_profile_removal_retains_history_and_can_restore_id(self):
        identifier = packs.install(self.preview()['token'])['created'][0]
        db.append_message('single-'+identifier, 'user', '保留的聊天')
        response = self.client.delete('/api/character-packs/characters/'+identifier, headers=HEADERS)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(db.get_character(identifier))
        self.assertEqual(len(db.list_messages('single-'+identifier)), 1)
        self.assertEqual(len(list((db.DATA_DIR/'assets').iterdir())), 1)
        result = packs.install(self.preview()['token'])
        self.assertEqual(result['created'], [identifier])
        db.upsert_character('manual-role', {'id':'manual-role','name':'Manual'})
        self.assertEqual(self.client.delete('/api/character-packs/characters/manual-role',headers=HEADERS).status_code,404)

    def test_preview_expires_and_cannot_be_reused(self):
        preview = self.preview()
        path = packs._staging_path(preview['token'])
        os.utime(path, (time.time()-7200, time.time()-7200))
        with self.assertRaises(packs.PackError):
            packs.install(preview['token'])
        token = self.preview()['token']
        packs.install(token)
        with self.assertRaises(packs.PackError):
            packs.install(token)

    def test_different_publishers_do_not_overwrite_roles(self):
        first = packs.install(self.preview()['token'])['created'][0]
        manifest, files = fixture()
        manifest['id'] = 'another.roles'
        second = packs.install(self.preview(archive(manifest, files))['token'])['created'][0]
        self.assertNotEqual(first, second)

    def test_invalid_archives_are_rejected(self):
        manifest, files = fixture()
        variations = []
        for field, value in [('format_version', 2), ('characters', []), ('assets', []), ('author', ''), ('version','latest')]:
            changed = copy.deepcopy(manifest)
            changed[field] = value
            variations.append(archive(changed, files))
        for field, value in [('avatar', 'https://example.com/a.png'), ('about', {}), ('script','alert(1)')]:
            changed = copy.deepcopy(manifest)
            changed['characters'][0][field] = value
            variations.append(archive(changed, files))
        for extra in ['../evil.py', 'assets/script.py', 'unlisted.png']:
            variations.append(archive(manifest, files | {extra:b'no'}))
        variations.append(archive(manifest, {name: b'broken' for name in files}))
        variations.append(b'not zip')
        for content in variations:
            with self.subTest(length=len(content)), self.assertRaises(packs.PackError):
                packs.parse(content)

    def test_dashboard_required(self):
        for path in ['/api/character-packs', '/api/character-packs/catalog']:
            self.assertEqual(self.client.get(path).status_code, 403)
        self.assertEqual(self.client.post('/api/character-packs/install', json={'token':'a'*32}).status_code,403)

    def test_local_catalog_and_preview(self):
        folder = catalog.FEATURES_DIR/'example'
        folder.mkdir(parents=True)
        (folder/'character-pack.zip').write_bytes(archive())
        listing = catalog.entries()
        self.assertEqual(listing['errors'], [])
        self.assertEqual(listing['items'][0]['catalog_id'], 'local.example')
        preview = asyncio.run(catalog.preview('local.example'))
        self.assertEqual(preview['name'], '测试角色包')

    def test_github_download_pin_and_redirect_guards(self):
        content = archive()
        real_client = httpx.AsyncClient
        def request(req):
            return httpx.Response(200, content=content)
        def client(**kwargs):
            return real_client(transport=httpx.MockTransport(request), **kwargs)
        entry = dict(url='https://github.com/example/repo/releases/download/v1/roles.zip',
                     sha256=hashlib.sha256(content).hexdigest())
        with patch.object(catalog, '_public_host'), patch.object(catalog.httpx, 'AsyncClient', side_effect=client):
            self.assertEqual(asyncio.run(catalog.download(entry)), content)
            with self.assertRaises(packs.PackError):
                asyncio.run(catalog.download(entry | {'sha256':'0'*64}))
        def redirect(req):
            return httpx.Response(302, headers={'location':'http://127.0.0.1/private'})
        with patch.object(catalog, '_public_host'), patch.object(catalog.httpx, 'AsyncClient', side_effect=lambda **kw:real_client(transport=httpx.MockTransport(redirect),**kw)):
            with self.assertRaises(packs.PackError):
                asyncio.run(catalog.download(entry))
        for url in ['http://github.com/a','https://evil.example/a','https://github.com:bad/a','https://name:pass@github.com/a']:
            with self.assertRaises(packs.PackError):
                catalog.validate_url(url)


if __name__ == '__main__':
    unittest.main()
