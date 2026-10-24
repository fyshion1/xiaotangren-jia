import base64
import io
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app import db, theme_feature
from app.routers import assets as asset_routes
from app.services import assets

HEADERS = {'X-Exploration-Dashboard': '1'}


def picture(color='red'):
    stream = io.BytesIO()
    Image.new('RGB', (8, 8), color).save(stream, 'PNG')
    return stream.getvalue()


class UserAssetTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.theme = self.root / 'theme'
        for obj, key, value in [(db, 'DATA_DIR', self.root / 'data'),
                                (db, 'DB_PATH', self.root / 'data/test.db'),
                                (db, 'SEED_CHARACTERS', []), (db, 'SEED_PROFILES', []),
                                (theme_feature, 'FEATURE_DIR', self.theme)]:
            patcher = patch.object(obj, key, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        db.init_db()
        app = FastAPI()
        app.include_router(asset_routes.router, prefix='/api')
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def upload(self, content=None):
        return self.client.post('/api/assets', headers=HEADERS, json={
            'data': 'data:image/png;base64,' + base64.b64encode(content or picture()).decode()})

    def migrate(self):
        return self.client.post('/api/assets/preserve-legacy', headers=HEADERS)

    def test_migration_survives_removal_of_theme_and_keeps_settings(self):
        folder = self.theme / 'public/characters'
        folder.mkdir(parents=True)
        (folder / 'avatar.png').write_bytes(picture())
        (folder / 'portrait.png').write_bytes(picture('blue'))
        profile = dict(id='role', name='User role', about='私人修改的设定',
                       avatar='/characters/avatar.png', portrait='/custom-portrait.png',
                       forms=[{'id':'second', 'fields':{'portrait':'/characters/portrait.png'}}])
        db.upsert_character('role', profile)
        db.upsert_profile('person', dict(id='person', name='User', avatar='/characters/avatar.png'))
        db.append_message('single-role', 'user', '保留聊天')
        result = self.migrate()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['updated'], 2)
        self.assertEqual(result.json()['unresolved'], [])
        updated = db.get_character('role')
        self.assertEqual(updated['about'], profile['about'])
        self.assertEqual(updated['portrait'], '/custom-portrait.png')
        self.assertTrue(updated['avatar'].startswith('/api/assets/'))
        self.assertEqual(db.get_profile('person')['avatar'], updated['avatar'])
        (folder / 'avatar.png').unlink()
        (folder / 'portrait.png').unlink()
        with patch.object(theme_feature, 'installed', return_value=False):
            self.assertEqual(self.client.get(updated['avatar']).content, picture())
            self.assertEqual(self.client.get(updated['forms'][0]['fields']['portrait']).content, picture('blue'))
            self.assertEqual(self.migrate().json()['updated'], 0)
        self.assertEqual(db.list_messages('single-role')[0]['content'], '保留聊天')
        backups = list((db.DATA_DIR / 'backups').glob('before-character-assets-*.db'))
        self.assertEqual(len(backups), 1)
        with closing(sqlite3.connect(backups[0])) as backup:
            original = json.loads(backup.execute("SELECT data FROM characters WHERE id='role'").fetchone()[0])
            self.assertEqual(original, profile)
            self.assertEqual(backup.execute('PRAGMA integrity_check').fetchone()[0], 'ok')

    def test_missing_source_keeps_reference_and_recovery_from_uninstall_backup(self):
        db.upsert_character('role', dict(id='role', avatar='/characters/lost.png', portrait=''))
        result = self.migrate().json()
        self.assertEqual(result['updated'], 0)
        self.assertEqual(len(result['unresolved']), 1)
        self.assertEqual(db.get_character('role')['avatar'], '/characters/lost.png')
        folder = db.DATA_DIR / 'uninstalled-plugins/xiaotangren-theme/public/characters'
        folder.mkdir(parents=True)
        (folder / 'lost.png').write_bytes(picture())
        self.assertEqual(self.migrate().json()['updated'], 1)
        self.assertEqual(db.get_character('role')['portrait'], '')

    def test_upload_deduplicates_assignment_preserves_prompt_and_checks_conflict(self):
        first, second = self.upload(), self.upload()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json()['id'], second.json()['id'])
        db.upsert_character('role', dict(id='role', about='设定不变', avatar=''))
        body = dict(kind='characters', owner_id='role', field='avatar',
                    asset_id=first.json()['id'], expected_url='')
        response = self.client.put('/api/assets/assignment', headers=HEADERS, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(db.get_character('role')['about'], '设定不变')
        self.assertEqual(self.client.put('/api/assets/assignment', headers=HEADERS, json=body).status_code, 409)
        inventory = self.client.get('/api/assets', headers=HEADERS).json()
        self.assertEqual(len(inventory['items']), 1)
        self.assertEqual(inventory['items'][0]['references'][0]['owner_id'], 'role')
        self.assertEqual(self.client.get(first.json()['url']).headers['x-content-type-options'], 'nosniff')

    def test_access_validation_and_no_path_or_active_content_import(self):
        self.assertEqual(self.client.get('/api/assets').status_code, 403)
        self.assertEqual(self.client.post('/api/assets', json={'data':'x'}).status_code, 403)
        self.assertEqual(self.upload(b'<svg onload="alert(1)"/>').status_code, 422)
        self.assertEqual(self.client.post('/api/assets', headers=HEADERS,
                                          json={'data':'data:image/png;base64,%%%'}).status_code, 422)
        db.upsert_character('role', dict(id='role', avatar='/characters/../secret.png'))
        self.assertEqual(len(self.migrate().json()['unresolved']), 1)
        self.assertEqual(self.client.get('/api/assets/invalid/content').status_code, 404)

    def test_repeated_missing_import_does_not_repeat_backup(self):
        db.upsert_character('role', dict(id='role', avatar='/characters/missing.png'))
        self.migrate()
        self.migrate()
        self.assertEqual(len(list((db.DATA_DIR / 'backups').glob('*.db'))), 1)

    def test_inline_and_attachment_art_outlive_attachment_cleanup(self):
        folder = db.DATA_DIR / 'attachments/gallery/orig'
        folder.mkdir(parents=True)
        image = picture('green')
        (folder / 'art.png').write_bytes(image)
        inline = 'data:image/png;base64,' + base64.b64encode(image).decode()
        db.upsert_character('role', dict(id='role', avatar=inline, portrait='/api/files/gallery/orig/art.png'))
        result = self.migrate()
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['updated'], 1)
        updated = db.get_character('role')
        self.assertEqual(updated['avatar'], updated['portrait'])
        (folder / 'art.png').unlink()
        self.assertEqual(self.client.get(updated['portrait']).content, image)
        self.assertEqual(self.client.get('/api/assets', headers=HEADERS).json()['legacy'], [])

    def test_editor_save_uses_assets_and_keeps_prompt_and_id(self):
        from app.routers import characters, profiles
        self.client.app.include_router(characters.router, prefix='/api')
        self.client.app.include_router(profiles.router, prefix='/api')
        data = 'data:image/png;base64,' + base64.b64encode(picture()).decode()
        result = self.client.post('/api/characters', json={'id':'new-role','name':'A','about':'人设内容', 'avatar':data})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['id'], 'new-role')
        self.assertEqual(result.json()['about'], '人设内容')
        self.assertTrue(result.json()['avatar'].startswith('/api/assets/'))
        identity = self.client.post('/api/profiles', json={'name':'New identity','avatar':data})
        self.assertEqual(identity.status_code, 200, identity.text)
        self.assertEqual(identity.json()['avatar'], result.json()['avatar'])

    def test_packaged_character_files_are_valid_user_assets(self):
        from app.data_paths import PROJECT_ROOT
        folder = PROJECT_ROOT / 'features/xiaotangren-theme/public/characters'
        if not folder.is_dir():
            self.skipTest('optional source character art is absent')
        for path in folder.glob('*.webp'):
            result = self.upload(path.read_bytes())
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(self.client.get(result.json()['url']).content, path.read_bytes())


if __name__ == '__main__':
    unittest.main()
