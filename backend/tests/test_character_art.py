import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db


class CharacterArtTests(unittest.TestCase):
    def test_fresh_and_existing_install_have_portable_art_without_overwriting_edits(self):
        public = Path(__file__).resolve().parents[2] / "frontend/public"
        with tempfile.TemporaryDirectory() as folder, patch.object(db, "DATA_DIR", Path(folder)), \
                patch.object(db, "DB_PATH", Path(folder) / "test.db"):
            db.init_db()
            for character_id in ("dashiyin", "xiaoshiyin", "xiaobai"):
                character = db.get_character(character_id)
                for field in ("avatar", "portrait"):
                    url = character[field]
                    self.assertTrue(url.startswith("/characters/"))
                    self.assertTrue((public / url.lstrip("/")).is_file())
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
            self.assertEqual(updated["portrait"], "/characters/dashiyin-portrait.webp")
            self.assertEqual(updated["avatar"], "/my-custom-avatar.png")
            self.assertEqual(updated["name"], "我的名字")
            self.assertEqual(db.get_character("xiaobai")["portrait"], "")
