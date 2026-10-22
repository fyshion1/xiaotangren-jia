import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db


class ProfileDefaultsTests(unittest.TestCase):
    def test_fresh_install_uses_neutral_profiles_and_preserves_edits(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(db, "DATA_DIR", Path(folder)), patch.object(db, "DB_PATH", Path(folder) / "test.db"):
                db.init_db()
                owner = db.get_profile("dalaoda")
                alternate = db.get_profile("xizi")
                self.assertEqual(owner["name"], "主人")
                self.assertEqual(alternate["name"], "自定义身份")
                for profile in (owner, alternate):
                    for field in ("birthday", "age", "height", "weight", "bodyType", "bust", "hip", "measurements"):
                        self.assertEqual(profile[field], "")
                    self.assertEqual(profile["forms"], [])
                owner.update(name="我的称呼", height="自填身高", relation="自定义关系")
                db.upsert_profile(owner["id"], owner)
                db.delete_profile("xizi")
                db.init_db()
                self.assertEqual(db.get_profile("dalaoda"), owner)
                self.assertIsNone(db.get_profile("xizi"))
