"""Tests for prep-images.py's capture manifest. Needs Pillow, like the tool.

    python3 tools/test_prep_images.py          # unittest
    python3 -m pytest tools                     # or pytest, if installed

The fixtures are made here with Pillow: a JPEG with the capture tags, an artist,
two serial numbers and a GPS IFD, so the test can show which of them reach the
manifest (the date, camera and lens) and which never do (the rest).
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

try:
    from PIL import Image  # type: ignore
except ImportError:  # pragma: no cover
    raise unittest.SkipTest("Pillow is not installed: python3 -m pip install Pillow")


def load_tool():
    """The script has a hyphen in its name, so it is loaded from its path."""
    spec = importlib.util.spec_from_file_location("prep_images", HERE / "prep-images.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["prep_images"] = mod
    spec.loader.exec_module(mod)
    return mod


prep = load_tool()

TAKEN = "2026:05:04 13:22:10"
LENS = "RF24-70mm F2.8 L IS USM"


def shot_exif() -> Image.Exif:
    exif = Image.Exif()
    exif[0x010F] = "Canon"
    exif[0x0110] = "Canon EOS R5"
    exif[0x0132] = "2026:05:05 09:00:00"  # DateTime: the file's last edit, not the capture
    exif[0x013B] = "A. Person"  # Artist: never read
    sub = exif.get_ifd(0x8769)
    sub[0x9003] = TAKEN
    sub[0xA434] = LENS
    sub[0xA431] = "SERIAL-0001"  # BodySerialNumber: never read
    sub[0xA435] = "LENS-SERIAL-0002"  # LensSerialNumber: never read
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"  # GPSLatitudeRef: never read
    gps[3] = "E"
    return exif


def write_jpeg(path: Path, exif: Image.Exif | None, size=(40, 30)) -> None:
    img = Image.new("RGB", size, (200, 100, 50))
    if exif is None:
        img.save(path, "JPEG")
    else:
        img.save(path, "JPEG", exif=exif.tobytes())


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_the_capture_fields_and_nothing_else(self):
        p = self.root / "IMG_0001.JPG"
        write_jpeg(p, shot_exif())
        got = prep.read_capture(p)
        self.assertEqual(
            got, {"capturedAt": "2026-05-04T13:22:10", "camera": "Canon EOS R5", "lens": LENS}
        )
        flat = json.dumps(got)
        for secret in ("A. Person", "SERIAL", '"N"', '"E"'):
            self.assertNotIn(secret, flat)

    def test_falls_back_to_datetime_and_copes_with_no_exif(self):
        exif = Image.Exif()
        exif[0x010F] = "NIKON CORPORATION"
        exif[0x0110] = "NIKON Z 6"
        exif[0x0132] = "2026:05:05 09:00:00"
        p = self.root / "a.jpg"
        write_jpeg(p, exif)
        self.assertEqual(
            prep.read_capture(p), {"capturedAt": "2026-05-05T09:00:00", "camera": "NIKON Z 6"}
        )
        unset = Image.Exif()
        unset[0x0132] = "0000:00:00 00:00:00"
        write_jpeg(p, unset)
        self.assertEqual(prep.read_capture(p), {})
        plain = self.root / "plain.png"
        Image.new("RGB", (4, 4)).save(plain, "PNG")
        self.assertEqual(prep.read_capture(plain), {})
        self.assertEqual(prep.read_capture(self.root / "missing.jpg"), {})

    def test_small_helpers(self):
        self.assertEqual(prep.exif_date_to_iso("2026:05:04 13:22:10"), "2026-05-04T13:22:10")
        self.assertIsNone(prep.exif_date_to_iso("yesterday"))
        self.assertEqual(prep.join_camera("Canon", "Canon EOS R5"), "Canon EOS R5")
        self.assertEqual(prep.join_camera("Apple", "iPhone 15 Pro"), "Apple iPhone 15 Pro")
        self.assertEqual(prep.join_camera(None, "X100V"), "X100V")
        self.assertIsNone(prep.join_camera(None, None))
        self.assertEqual(prep.exif_text(b"Canon\x00\x00"), "Canon")
        self.assertIsNone(prep.exif_text("  \x00"))

    def test_a_run_writes_the_manifest_and_strips_the_copies(self):
        src = self.root / "spring"
        (src / "Details").mkdir(parents=True)
        write_jpeg(src / "IMG_0001.JPG", shot_exif())
        write_jpeg(src / "Details" / "Side View.jpeg", None, size=(30, 40))
        out = self.root / "web"
        code = prep.run([str(src), "--out", str(out), "--size", "20", "--yes"])
        self.assertEqual(code, 0)

        manifest = json.loads((out / prep.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(
            manifest,
            {
                "version": 1,
                "files": {
                    "details/side-view.jpg": {"originalWidth": 30, "originalHeight": 40},
                    "img-0001.jpg": {
                        "capturedAt": "2026-05-04T13:22:10",
                        "camera": "Canon EOS R5",
                        "lens": LENS,
                        "originalWidth": 40,
                        "originalHeight": 30,
                    },
                },
            },
        )
        # The web copy carries none of it: the manifest is the only place the date survives.
        with Image.open(out / "img-0001.jpg") as copy:
            self.assertEqual(copy.size, (20, 15))
            self.assertEqual(dict(copy.getexif()), {})

        # A second run keeps the copies and rewrites a whole manifest; a dry run writes nothing.
        (out / prep.MANIFEST_NAME).unlink()
        self.assertEqual(prep.run([str(src), "--out", str(out), "--size", "20", "--yes"]), 1)
        self.assertEqual(
            sorted(json.loads((out / prep.MANIFEST_NAME).read_text())["files"]),
            ["details/side-view.jpg", "img-0001.jpg"],
        )
        dry = self.root / "dry"
        self.assertEqual(prep.run([str(src), "--out", str(dry), "--max", "--dry-run"]), 0)
        self.assertFalse(dry.exists())


if __name__ == "__main__":
    unittest.main()
