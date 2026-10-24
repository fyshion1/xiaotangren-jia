import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db, theme_feature
from app.services import assets


class CharacterArtTests(unittest.TestCase):
    def test_fresh_and_existing_install_have_portable_art_without_overwriting_edits(self):
        if not theme_feature.installed():
            self.skipTest('optional character art theme not installed')
        public = theme_feature.FEATURE_DIR / "public"
        with tempfile.TemporaryDirectory() as folder, patch.object(db, "DATA_DIR", Path(folder)), \
                patch.object(db, "DB_PATH", Path(folder) / "test.db"):
            db.init_db()
            for character_id in ("dashiyin", "xiaoshiyin", "xiaobai"):
                character = db.get_character(character_id)
                for field in ("avatar", "portrait"):
                    url = character[field]
                    self.assertTrue(url.startswith("/api/assets/"))
                    identifier = url.split("/")[3]
                    self.assertTrue(assets.asset_path(Path(folder), identifier, "webp").is_file())
            character = db.get_character("dashiyin")
            del character["portrait"]
            character["avatar"] = "/my-custom-avatar.png"
            character["name"] = "我的名字"
            db.upsert_character("dashiyin", character)
            cleared = db.get_character("xiaobai")
            cleared["portrait"] = ""
            db.upsert_character("xiaobai", cleared)
            db.init_db()
            updated = db.get_character("dashiyin")
            self.assertTrue(updated["portrait"].startswith("/api/assets/"))
            self.assertEqual(updated["avatar"], "/my-custom-avatar.png")
            self.assertEqual(updated["name"], "我的名字")
            self.assertEqual(db.get_character("xiaobai")["portrait"], "")
