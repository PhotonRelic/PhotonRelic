"""Tests for prep-images.py: what reaches the manifest, what stays in the copy, what is cut out.
Needs Pillow, like the tool.

    python3 tools/test_prep_images.py          # unittest
    python3 -m pytest tools                     # or pytest, if installed
    uv run --with pillow --with pillow-heif tools/test_prep_images.py

The fixtures are made here: a JPEG with capture tags, an artist and a copyright, two serial
numbers, a MakerNote, a GPS IFD and a thumbnail IFD; an XMP packet with description and rights
fields beside editing history, a document id, a GPS coordinate and an embedded thumbnail; an
IPTC block with keywords, a credit, a source and the creator's contact details.
"""

from __future__ import annotations

import importlib.util
import io
import json
import struct
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
    exif[0x013B] = "A. Person"  # Artist: kept, as the creator
    exif[0x8298] = "(c) 2026 A. Person"  # Copyright: kept (EXIF is ASCII)
    exif[0x010E] = "A chair by a window"  # ImageDescription: kept, as the description
    sub = exif.get_ifd(0x8769)
    sub[0x9003] = TAKEN
    sub[0xA434] = LENS
    sub[0xA431] = "SERIAL-0001"  # BodySerialNumber: dropped
    sub[0xA435] = "LENS-SERIAL-0002"  # LensSerialNumber: dropped
    sub[0xA430] = "Owner Name"  # CameraOwnerName: dropped
    sub[0x927C] = b"\x00\x01MAKERNOTE"  # MakerNote: dropped
    gps = exif.get_ifd(0x8825)
    gps[1] = "N"  # GPSLatitudeRef: dropped with the whole IFD
    gps[3] = "E"
    return exif


XMP = """<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"
    xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/"
    xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/"
    xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#"
    xmlns:exif="http://ns.adobe.com/exif/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"
    xmpMM:DocumentID="xmp.did:ABC123"
    xmpMM:InstanceID="xmp.iid:DEF456"
    crs:RawFileName="IMG_0001.CR3"
    exif:GPSLatitude="13,45.123N"
    photoshop:Credit="Sevendeman - stock.adobe.com"
    photoshop:Source="270140535"
    xmpRights:WebStatement="https://stock.adobe.com/license"
    xmpRights:UsageTerms="Standard license"
    xmp:CreatorTool="Adobe Lightroom">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Man is shocked  by a bill</rdf:li></rdf:Alt></dc:title>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">Asian man is shocked by the bill.</rdf:li></rdf:Alt></dc:description>
   <dc:subject><rdf:Bag><rdf:li>man</rdf:li><rdf:li>Bill</rdf:li><rdf:li>xmp-only</rdf:li></rdf:Bag></dc:subject>
   <dc:creator><rdf:Seq><rdf:li>Rachata Teyparsit</rdf:li></rdf:Seq></dc:creator>
   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© Sevendeman</rdf:li></rdf:Alt></dc:rights>
   <xmpMM:History><rdf:Seq><rdf:li stEvt:action="saved" stEvt:changed="/Users/someone/Pictures/x.psd"/></rdf:Seq></xmpMM:History>
   <xmp:Thumbnails><rdf:Alt><rdf:li>BASE64THUMB</rdf:li></rdf:Alt></xmp:Thumbnails>
   <Iptc4xmpCore:CreatorContactInfo Iptc4xmpCore:CiEmailWork="someone@example.com"/>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""


def iptc_block(datasets: list[tuple[int, bytes]]) -> bytes:
    out = bytearray()
    for dataset, data in datasets:
        out += bytes((0x1C, 2, dataset)) + struct.pack(">H", len(data)) + data
    return bytes(out)


IPTC_DATASETS = [
    (5, b"Man is shocked and surprised with the bill."),
    (25, b"man"),
    (25, b"document"),
    (25, b"man"),  # Adobe Stock lists every keyword twice
    (80, b"Rachata Teyparsit"),
    (110, b"Sevendeman - stock.adobe.com"),
    (115, b"270140535"),
    (116, "© 2019 Sevendeman".encode("utf-8")),
    (118, b"+66 0000 0000 Bangkok"),  # Contact: dropped
    (120, b"Asian man is shocked and surprised with the white mail message or the bill."),
]


def write_jpeg(path: Path, exif: Image.Exif | bytes | None, size=(40, 30), xmp: str | None = None, iptc: bytes | None = None) -> None:
    img = Image.new("RGB", size, (200, 100, 50))
    kwargs: dict = {}
    if exif is not None:
        kwargs["exif"] = exif if isinstance(exif, bytes) else exif.tobytes()
    if xmp is not None:
        kwargs["xmp"] = xmp.encode("utf-8")
    buf = io.BytesIO()
    img.save(buf, "JPEG", **kwargs)
    data = buf.getvalue()
    if iptc is not None:
        data = prep.insert_segments(data, [prep.segment(0xED, prep.photoshop_segment(iptc))])
    path.write_bytes(data)


def tiff_with_thumbnail_ifd() -> bytes:
    """A little-endian TIFF: IFD0 with Make, pointing on to an IFD1 (the thumbnail IFD)."""
    make = b"Canon\x00"
    ifd0_at = 8
    ifd0 = struct.pack("<H", 1) + struct.pack("<HHII", 0x010F, 2, len(make), 0) + struct.pack("<I", 0)
    make_at = ifd0_at + len(ifd0)
    ifd1_at = make_at + len(make)
    ifd0 = struct.pack("<H", 1) + struct.pack("<HHII", 0x010F, 2, len(make), make_at) + struct.pack("<I", ifd1_at)
    ifd1 = struct.pack("<H", 1) + struct.pack("<HHII", 0x0201, 4, 1, 0) + struct.pack("<I", 0)
    return b"II*\x00" + struct.pack("<I", ifd0_at) + ifd0 + make + ifd1


def next_ifd_of(tiff: bytes) -> int:
    """IFD0's pointer to the next IFD in a TIFF; 0 when there is none (no thumbnail IFD)."""
    le = tiff[:2] == b"II"
    fmt = "<" if le else ">"
    ifd0 = struct.unpack(fmt + "I", tiff[4:8])[0]
    n = struct.unpack(fmt + "H", tiff[ifd0 : ifd0 + 2])[0]
    at = ifd0 + 2 + n * 12
    return struct.unpack(fmt + "I", tiff[at : at + 4])[0]


class ReadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_reads_the_capture_fields(self):
        p = self.root / "IMG_0001.JPG"
        write_jpeg(p, shot_exif())
        self.assertEqual(
            prep.read_capture(p), {"capturedAt": "2026-05-04T13:22:10", "camera": "Canon EOS R5", "lens": LENS}
        )

    def test_falls_back_to_datetime_and_copes_with_no_exif(self):
        exif = Image.Exif()
        exif[0x010F] = "NIKON CORPORATION"
        exif[0x0110] = "NIKON Z 6"
        exif[0x0132] = "2026:05:05 09:00:00"
        p = self.root / "a.jpg"
        write_jpeg(p, exif)
        self.assertEqual(prep.read_capture(p), {"capturedAt": "2026-05-05T09:00:00", "camera": "NIKON Z 6"})
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
        self.assertEqual(prep.stock_of(Path("AdobeStock_270140535.jpg")), ("Adobe Stock 270140535", "https://stock.adobe.com/270140535"))
        self.assertEqual(prep.stock_of(Path("adobestock_42.AI")), ("Adobe Stock 42", "https://stock.adobe.com/42"))
        self.assertIsNone(prep.stock_of(Path("IMG_0001.JPG")))

    def test_reads_the_describe_fields_iptc_first_then_xmp_then_exif(self):
        p = self.root / "AdobeStock_270140535.jpg"
        write_jpeg(p, shot_exif(), xmp=XMP, iptc=iptc_block(IPTC_DATASETS))
        meta = prep.read_meta(p)
        self.assertEqual(meta.capture["camera"], "Canon EOS R5")
        self.assertEqual(
            meta.describe,
            {
                "title": "Man is shocked and surprised with the bill.",
                "keywords": ["man", "document", "Bill", "xmp-only"],  # IPTC's, deduplicated, then XMP's new ones
                "creator": "Rachata Teyparsit",
                "credit": "Sevendeman - stock.adobe.com",
                "origin": "270140535",
                "copyright": "© 2019 Sevendeman",
                "description": "Asian man is shocked and surprised with the white mail message or the bill.",
                "sourceUrl": "https://stock.adobe.com/license",
                "usageTerms": "Standard license",
            },
        )
        # Without IPTC the XMP speaks, with its whitespace collapsed; without XMP the EXIF does.
        write_jpeg(p, shot_exif(), xmp=XMP)
        d = prep.read_meta(p).describe
        self.assertEqual(d["title"], "Man is shocked by a bill")
        self.assertEqual(d["keywords"], ["man", "Bill", "xmp-only"])
        self.assertEqual(d["copyright"], "© Sevendeman")
        write_jpeg(p, shot_exif())
        self.assertEqual(
            prep.read_meta(p).describe,
            {"description": "A chair by a window", "creator": "A. Person", "copyright": "(c) 2026 A. Person"},
        )
        self.assertEqual(prep.read_meta(self.root / "missing.jpg").describe, {})


class CleanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.src = self.root / "shoot"
        self.src.mkdir()
        self.out = self.root / "web"

    def tearDown(self):
        self.tmp.cleanup()

    def run_tool(self, *args: str) -> int:
        return prep.run([str(self.src), "--out", str(self.out), "--yes", *args])

    def assert_cleaned(self, path: Path, upright: bool):
        data = path.read_bytes()
        segs = prep.jpeg_segments(data)
        self.assertIn("exif", segs)
        self.assertIn("xmp", segs)
        self.assertIn("photoshop", segs)
        # EXIF: capture, artist and copyright stay; GPS, MakerNote, serials, owner and the thumbnail IFD go.
        exif = Image.Exif()
        exif.load(segs["exif"])
        self.assertEqual(exif[0x010F], "Canon")
        self.assertEqual(exif[0x013B], "A. Person")
        self.assertEqual(exif[0x8298], "(c) 2026 A. Person")
        sub = exif.get_ifd(0x8769)
        self.assertEqual(sub[0x9003], TAKEN)
        self.assertEqual(sub[0xA434], LENS)
        for tag in (0xA431, 0xA435, 0xA430, 0x927C):
            self.assertNotIn(tag, sub)
        self.assertNotIn(0x8825, exif)
        self.assertEqual(dict(exif.get_ifd(0x8825)), {})
        self.assertEqual(next_ifd_of(segs["exif"]), 0)
        if upright:
            self.assertEqual(exif.get(0x0112, 1), 1)
        flat = data.decode("latin-1")
        for secret in ("SERIAL-0001", "LENS-SERIAL", "Owner Name", "MAKERNOTE"):
            self.assertNotIn(secret, flat)
        # XMP: the description and rights stay; history, ids, the raw file's name, GPS, the thumbnail
        # and the contact details go, and the packet is still well-formed with its prefixes.
        xmp = segs["xmp"].decode("utf-8")
        for kept in ("Rachata Teyparsit", "Sevendeman - stock.adobe.com", "Standard license", "xmp-only", "Adobe Lightroom", 'xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"'):
            self.assertIn(kept, xmp)
        for gone in ("xmp.did:ABC123", "xmp.iid:DEF456", "IMG_0001.CR3", "13,45.123N", "/Users/someone", "BASE64THUMB", "someone@example.com", "xmpMM:History", "stEvt"):
            self.assertNotIn(gone, xmp)
        self.assertTrue(xmp.startswith('<?xpacket begin="﻿"'))
        self.assertTrue(xmp.endswith('<?xpacket end="w"?>'))
        # IPTC: the block is back, minus the contact dataset.
        resources = prep.photoshop_resources(segs["photoshop"])
        records = prep.iptc_records(resources[prep.IPTC_RESOURCE])
        self.assertIn((2, 80, b"Rachata Teyparsit"), records)
        self.assertIn((2, 116, "© 2019 Sevendeman".encode("utf-8")), records)
        self.assertNotIn((2, 118), {(r, d) for r, d, _ in records})
        self.assertNotIn("Bangkok", flat)
        # And Pillow reads the copy back whole.
        with Image.open(path) as img:
            img.load()
            self.assertEqual(img.getexif()[0x010F], "Canon")

    def test_as_shot_keeps_the_bytes_and_cleans_the_metadata(self):
        write_jpeg(self.src / "AdobeStock_270140535.jpg", shot_exif(), xmp=XMP, iptc=iptc_block(IPTC_DATASETS))
        (self.src / "AdobeStock_270140535.ai").write_bytes(b"%!PS-Adobe master")
        self.assertEqual(self.run_tool("--license", "Adobe Stock Standard"), 0)
        out = self.out / "adobestock-270140535.jpg"
        self.assert_cleaned(out, upright=False)
        # The scan data is the original's, byte for byte.
        src = (self.src / "AdobeStock_270140535.jpg").read_bytes()
        self.assertEqual(out.read_bytes()[out.read_bytes().index(b"\xff\xda") :], src[src.index(b"\xff\xda") :])
        # The master came along untouched and is named in the entry.
        self.assertEqual((self.out / "AdobeStock_270140535.ai").read_bytes(), b"%!PS-Adobe master")
        manifest = json.loads((self.out / prep.MANIFEST_NAME).read_text(encoding="utf-8"))
        entry = manifest["files"]["adobestock-270140535.jpg"]
        self.assertEqual(entry["capturedAt"], "2026-05-04T13:22:10")
        self.assertEqual(entry["originalWidth"], 40)
        self.assertEqual(
            entry["describe"],
            {
                "title": "Man is shocked and surprised with the bill.",
                "keywords": ["man", "document", "Bill", "xmp-only"],
                "creator": "Rachata Teyparsit",
                "credit": "Sevendeman - stock.adobe.com",
                "origin": "Adobe Stock 270140535",
                "copyright": "© 2019 Sevendeman",
                "description": "Asian man is shocked and surprised with the white mail message or the bill.",
                "sourceUrl": "https://stock.adobe.com/license",  # the file's own statement wins over the asset page
                "usageTerms": "Standard license",
                "license": "Adobe Stock Standard",
                "masterName": "AdobeStock_270140535.ai",
            },
        )

    def test_re_encode_attaches_the_same_cleaned_metadata_upright(self):
        exif = shot_exif()
        exif[0x0112] = 6  # needs a quarter turn
        write_jpeg(self.src / "IMG_0001.JPG", exif, size=(40, 30), xmp=XMP, iptc=iptc_block(IPTC_DATASETS))
        self.assertEqual(self.run_tool("--mode", "re-encode"), 0)
        out = self.out / "img-0001.jpg"
        self.assert_cleaned(out, upright=True)
        with Image.open(out) as img:
            self.assertEqual(img.size, (30, 40))  # turned upright
        entry = json.loads((self.out / prep.MANIFEST_NAME).read_text(encoding="utf-8"))["files"]["img-0001.jpg"]
        self.assertEqual((entry["originalWidth"], entry["originalHeight"]), (30, 40))
        self.assertNotIn("origin", entry["describe"].get("origin", "") and "Adobe")
        self.assertNotIn("license", entry["describe"])

    def test_as_shot_re_encodes_what_cannot_stay_and_says_why(self):
        exif = shot_exif()
        exif[0x0112] = 8
        write_jpeg(self.src / "turned.jpg", exif, size=(40, 30))
        Image.new("RGBA", (10, 10), (1, 2, 3, 128)).save(self.src / "alpha.png", "PNG")
        Image.new("RGB", (10, 10)).save(self.src / "scan.tif", "TIFF")
        self.assertEqual(self.run_tool(), 0)
        with Image.open(self.out / "turned.jpg") as img:
            self.assertEqual(img.size, (30, 40))
            self.assertEqual(img.getexif().get(0x0112, 1), 1)
        with Image.open(self.out / "alpha.png") as img:
            self.assertEqual(img.mode, "RGBA")
        self.assertTrue((self.out / "scan.jpg").exists())
        self.assertFalse((self.out / "scan.tif").exists())

    def test_the_thumbnail_ifd_is_dropped(self):
        write_jpeg(self.src / "thumb.jpg", b"Exif\x00\x00" + tiff_with_thumbnail_ifd())
        src_exif = prep.jpeg_segments((self.src / "thumb.jpg").read_bytes())["exif"]
        self.assertNotEqual(next_ifd_of(src_exif), 0)  # the fixture really has one
        self.assertEqual(self.run_tool(), 0)
        out_exif = prep.jpeg_segments((self.out / "thumb.jpg").read_bytes())["exif"]
        self.assertEqual(next_ifd_of(out_exif), 0)
        exif = Image.Exif()
        exif.load(out_exif)
        self.assertEqual(exif[0x010F], "Canon")

    def test_a_file_with_nothing_to_keep_gets_no_segments(self):
        write_jpeg(self.src / "bare.jpg", None)
        self.assertEqual(self.run_tool(), 0)
        self.assertEqual(prep.jpeg_segments((self.out / "bare.jpg").read_bytes()), {})
        manifest = json.loads((self.out / prep.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(manifest["files"]["bare.jpg"], {"originalWidth": 40, "originalHeight": 30})

    def test_masters_pair_by_name_in_their_folder_only(self):
        (self.src / "Details").mkdir()
        write_jpeg(self.src / "Side View.jpeg", None)
        (self.src / "Side View.psd").write_bytes(b"8BPS master")
        (self.src / "Details" / "Side View.psd").write_bytes(b"8BPS other")  # no web copy here: skipped
        Image.new("RGB", (10, 10)).save(self.src / "Details" / "scan.tif", "TIFF")  # alone: an input
        Image.new("RGB", (10, 10)).save(self.src / "scan.tif", "TIFF")
        write_jpeg(self.src / "scan.jpg", None)  # beside it: scan.tif is its master
        jobs, _, skipped, _ = prep.collect([str(self.src)], self.out)
        by_name = {j.src.name: j for j in jobs}
        self.assertEqual(by_name["Side View.jpeg"].master, self.src / "Side View.psd")
        self.assertEqual(by_name["scan.jpg"].master, self.src / "scan.tif")
        self.assertIn("scan.tif", [j.src.name for j in jobs if j.src.parent.name == "Details"])
        self.assertNotIn("scan.tif", [j.src.name for j in jobs if j.src.parent == self.src])
        self.assertTrue(any("Details/Side View.psd" in s or "Details\\Side View.psd" in s for s in skipped))
        self.assertEqual(self.run_tool(), 0)
        self.assertEqual((self.out / "Side View.psd").read_bytes(), b"8BPS master")
        self.assertTrue((self.out / "scan.tif").exists())
        self.assertTrue((self.out / "details" / "scan.jpg").exists())
        manifest = json.loads((self.out / prep.MANIFEST_NAME).read_text(encoding="utf-8"))
        self.assertEqual(manifest["files"]["side-view.jpg"]["describe"], {"masterName": "Side View.psd"})
        self.assertEqual(manifest["files"]["scan.jpg"]["describe"], {"masterName": "scan.tif"})

    def test_dry_run_writes_nothing_and_a_second_run_keeps_what_is_there(self):
        write_jpeg(self.src / "AdobeStock_1.jpg", shot_exif(), iptc=iptc_block(IPTC_DATASETS))
        (self.src / "AdobeStock_1.ai").write_bytes(b"master")
        self.assertEqual(self.run_tool("--dry-run"), 0)
        self.assertFalse(self.out.exists())
        self.assertEqual(self.run_tool(), 0)
        before = (self.out / "adobestock-1.jpg").read_bytes()
        self.assertEqual(self.run_tool(), 1)  # KEEP rows count as not written
        self.assertEqual((self.out / "adobestock-1.jpg").read_bytes(), before)
        self.assertEqual(self.run_tool("--force"), 0)

    def test_refuses_to_write_beside_the_originals(self):
        write_jpeg(self.src / "a.jpg", None)
        self.assertEqual(prep.run([str(self.src), "--out", str(self.src), "--yes"]), 1)
        self.assertEqual(prep.run([str(self.src / "a.jpg"), "--out", str(self.src), "--yes"]), 1)


if __name__ == "__main__":
    unittest.main()
