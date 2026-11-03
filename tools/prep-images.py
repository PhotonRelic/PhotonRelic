#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow>=10", "pillow-heif>=0.16"]
# ///
"""prep-images: make web copies of a shoot for the PhotonRelic library.

Keep your originals where they are. This script writes a prepared copy of each
photo into a second folder, ready to drop on PhotonRelic's Upload page:

  * renamed the way the library files keys: lowercase, every run of spaces or
    punctuation a single hyphen, `.jpeg` as `.jpg` (folder names too, since
    subfolders become subject paths);
  * "as shot" (the default, menu option 1): a JPEG keeps its bytes and pixels;
    only its metadata segments are rewritten. A PNG is re-saved losslessly.
    Any other format (TIFF, HEIC, WebP, AVIF, GIF) is converted to JPEG at full
    size. A JPEG over the resizer's input cap (19.95 MB, the same cap the
    library enforces) or one whose orientation tag needs applying is re-encoded
    at the largest size that fits, and the table says so;
  * re-encoded (menu option 2, --mode re-encode): every file decoded, converted
    to sRGB from any embedded profile, orientation applied, and saved as JPEG at
    quality 92 (4:4:4 chroma) at full size or the largest size under the cap;
    PNG stays PNG when it has transparency. One quality across the shoot and a
    smaller folder than the camera's JPEGs.

What the file says about itself is kept, what a device or an editor recorded
about place, identity and your machine is dropped:

  * kept: the capture settings, orientation and color space, Artist and
    Copyright, the IPTC and XMP description and rights fields (title, caption,
    keywords, creator, credit, copyright notice, source, usage terms), and any
    Content Credentials;
  * dropped: GPS (the EXIF GPS IFD and the XMP coordinate fields), MakerNote,
    body and lens serial numbers, the camera owner's name, the EXIF thumbnail,
    XMP editing history, document IDs and file paths, embedded XMP thumbnails,
    the creator's contact details, and every Photoshop resource except the
    IPTC block itself.

Those description and rights fields are also written to a manifest the Upload
page reads, with the capture date and time as the camera wrote them, the
camera, the lens and the original pixel size. It is `photonrelic-manifest.json`
in the output folder, keyed by each web copy's name inside that folder, with
absent fields left out:

    {"version": 1, "files": {"details/side-view.jpg": {
      "capturedAt": "2026-05-04T13:22:10", "camera": "Canon EOS R5",
      "lens": "RF24-70mm F2.8 L IS USM", "originalWidth": 6000, "originalHeight": 4000,
      "describe": {"title": "Side view", "keywords": ["chair", "oak"],
                   "creator": "A. Photographer", "copyright": "© 2026 A. Photographer",
                   "origin": "Adobe Stock 270140535", "sourceUrl": "https://stock.adobe.com/270140535",
                   "license": "Adobe Stock Standard", "masterName": "AdobeStock_270140535.ai"}}}}

The library seeds each file's record from its entry and only where the record
has nothing, so a later upload never writes over what staff typed.

Stock photos: a file named `AdobeStock_<id>.<ext>` is recognized, its origin and
the asset page `https://stock.adobe.com/<id>` recorded, and the run asks once
which license was bought (Standard, Extended, or leave blank) unless
--license says. A professional-format file beside a web copy with the same
name (`AdobeStock_270140535.ai` beside `AdobeStock_270140535.jpg`; .ai, .psd,
.psb, .tif, raw formats…) is the master: it is copied into the output folder
untouched, metadata and all, and named in the web copy's entry as
`masterName`.

Nothing is written over an original and no output is overwritten unless
--force. Run it with no --mode to be asked; --dry-run shows the plan, every
field read and the stock detection, and writes nothing.

    python3 tools/prep-images.py ~/Pictures/shoots/spring
    python3 tools/prep-images.py ~/Pictures/shoots/spring --mode re-encode --yes
    python3 tools/prep-images.py ~/Downloads/stock --license "Adobe Stock Standard" --dry-run
    python3 tools/prep-images.py IMG_0001.JPG "Side View.jpeg" --out ./web

Needs Pillow (and pillow-heif for .heic): `python3 -m pip install Pillow pillow-heif`,
or run it with `uv run tools/prep-images.py …`, which installs them itself.
"""

from __future__ import annotations

__version__ = "2.0"

import argparse
import io
import json
import math
import re
import shutil
import struct
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

try:
    from PIL import Image, ImageCms, ImageOps  # type: ignore
    from PIL.PngImagePlugin import PngInfo  # type: ignore
except ImportError:  # pragma: no cover - the message is the point
    sys.exit(
        "Pillow is not installed. Run `python3 -m pip install Pillow pillow-heif` "
        "or `uv run tools/prep-images.py …`."
    )

try:  # HEIC from an iPhone; optional
    import pillow_heif  # type: ignore

    pillow_heif.register_heif_opener()
    HEIF = True
except ImportError:  # pragma: no cover
    HEIF = False

# The Images binding refuses a source over 20 MB; 19.95 MB in decimal bytes is
# under the cap on either reading of the unit, and it is what the library enforces.
CAP_BYTES = 19_950_000
CAP_LABEL = "19.95 MB"
# Transformation limits for a source (developers.cloudflare.com/images/get-started/limits).
MAX_DIMENSION = 12_000
MAX_AREA = 100_000_000

WEB_EXT = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"}
CAMERA_EXT = {".tif", ".tiff", ".heic", ".heif"}
INPUT_EXT = WEB_EXT | CAMERA_EXT
# A master: the professional-format or high-resolution original a web copy was made
# from. Only beside a web-format file with the same name; alone, a TIFF or HEIC is
# an input to convert and the rest are skipped.
MASTER_EXT = {
    ".ai", ".eps", ".pdf", ".psd", ".psb", ".tif", ".tiff", ".svg", ".indd",
    ".dng", ".cr2", ".cr3", ".nef", ".arw", ".raf", ".orf", ".rw2", ".heic", ".heif",
}

# Stock platforms recognized by their download names: a label, the name pattern with
# the asset id as its one group, and the asset page. One row per platform.
VENDORS = [
    ("Adobe Stock", re.compile(r"^AdobeStock_(\d+)$", re.IGNORECASE), "https://stock.adobe.com/{id}"),
]
LICENSE_CHOICES = ["Standard", "Extended"]

Image.MAX_IMAGE_PIXELS = 400_000_000  # a 33 MB original is far under this; do not refuse it


def slugify_stem(stem: str) -> str:
    """Lowercase; every run of anything but a-z and 0-9 becomes one hyphen."""
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", stem.lower())).strip("-")


def slugify_name(name: str, ext_override: str | None = None) -> str:
    p = Path(name)
    ext = (ext_override or p.suffix).lower()
    if ext == ".jpeg":
        ext = ".jpg"
    stem = slugify_stem(p.stem) or "image"
    return f"{stem}{ext}"


def fmt_bytes(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.2f} MB"
    return f"{max(1, round(n / 1000))} KB" if n else "0 KB"


def fmt_saved(before: int, after: int) -> str:
    if not before or before == after:
        return "0%"
    pct = (before - after) / before * 100
    if abs(pct) < 0.5:  # a tag strip saves a few KB of a 10 MB file: say 0%, not -0%
        return "0%"
    return f"-{pct:.0f}%" if pct > 0 else f"+{-pct:.0f}%"


def fmt_pixels(src: tuple[int, int], out: tuple[int, int]) -> str:
    a = f"{src[0]} × {src[1]}"
    return a if src == out else f"{a} → {out[0]} × {out[1]}"


@dataclass
class Job:
    src: Path
    rel: Path  # path inside the dropped folder, slugified
    out: Path
    master: Path | None = None  # the master found beside the source, copied untouched


def stock_of(path: Path) -> tuple[str, str] | None:
    """("Adobe Stock 270140535", "https://stock.adobe.com/270140535") for a stock download's name."""
    for label, pattern, url in VENDORS:
        m = pattern.match(path.stem)
        if m:
            return f"{label} {m.group(1)}", url.format(id=m.group(1))
    return None


def collect(inputs: list[str], out_dir: Path | None) -> tuple[list[Job], Path, list[str], list[Path]]:
    """Every image under the inputs, with its output path; folders keep their structure.
    A master beside a web-format file with the same name is attached to that file's job."""
    jobs: list[Job] = []
    skipped: list[str] = []
    roots = [Path(i).expanduser() for i in inputs]
    first_dir = next((r for r in roots if r.is_dir()), None)
    if out_dir is None:
        out_dir = (
            first_dir.with_name(f"{first_dir.name}-web") if first_dir else Path.cwd() / "prepped"
        )
    for root in roots:
        if root.is_dir():
            files = sorted(p for p in root.rglob("*") if p.is_file())
            base = root
        elif root.is_file():
            files = [root]
            base = root.parent
        else:
            skipped.append(f"{root}: not found")
            continue
        files = [f for f in files if not f.name.startswith(".")]
        # A web file's name, by folder, so a master can be matched to it.
        web_stems = {(f.parent, f.stem.lower()) for f in files if f.suffix.lower() in WEB_EXT}
        masters: dict[tuple[Path, str], Path] = {}
        for f in files:
            ext = f.suffix.lower()
            paired = (f.parent, f.stem.lower()) in web_stems and ext not in WEB_EXT
            if paired and ext in MASTER_EXT:
                masters[(f.parent, f.stem.lower())] = f
                continue
            if ext not in INPUT_EXT:
                skipped.append(f"{f}: not an image the store takes" + (
                    " (no web copy with this name to be the master of)" if ext in MASTER_EXT else ""
                ))
                continue
            rel_parts = [slugify_stem(part) or "x" for part in f.relative_to(base).parts[:-1]]
            rel = Path(*rel_parts, slugify_name(f.name)) if rel_parts else Path(slugify_name(f.name))
            jobs.append(Job(src=f, rel=rel, out=out_dir / rel))
        for j in jobs:
            j.master = masters.get((j.src.parent, j.src.stem.lower()), j.master)
    # Two sources that slug to the same name get -2, -3, … rather than one clobbering the other.
    seen: dict[Path, int] = {}
    for j in jobs:
        n = seen.get(j.rel, 0)
        seen[j.rel] = n + 1
        if n:
            j.rel = j.rel.with_name(f"{j.rel.stem}-{n + 1}{j.rel.suffix}")
            j.out = out_dir / j.rel
    return jobs, out_dir, skipped, roots


def output_is_safe(jobs: list[Job], out_dir: Path, roots: list[Path]) -> str | None:
    """The output folder must be away from the originals: never one of the input folders, never
    inside one, never the folder a listed file sits in. On a Mac the disk ignores case, so
    `P1429803.JPG` and `p1429803.jpg` are the same file and a rename in place would overwrite it."""
    out = out_dir.resolve()
    for r in roots:
        if not r.exists():
            continue
        folder = r.resolve() if r.is_dir() else r.resolve().parent
        if out == folder or folder in out.parents:
            return f"the output folder {out_dir} is where the originals are ({r}); pick --out elsewhere"
    for j in jobs:
        if j.out.parent.resolve() == j.src.resolve().parent:
            return f"{j.out} would sit beside its original; pick --out elsewhere"
    return None


def open_image(path: Path) -> Image.Image:
    img = Image.open(path)
    img.load()
    img = ImageOps.exif_transpose(img) or img
    return img


def to_srgb(img: Image.Image) -> Image.Image:
    """Convert from an embedded profile (Adobe RGB, ProPhoto…) to sRGB; drop the profile after."""
    icc = img.info.get("icc_profile")
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            if "srgb" not in (ImageCms.getProfileDescription(src) or "").lower():
                base = img.convert("RGBA" if has_alpha else "RGB")
                img = ImageCms.profileToProfile(
                    base, src, ImageCms.createProfile("sRGB"), outputMode=base.mode
                )
        except Exception:  # a broken profile is not a reason to stop the shoot
            pass
    img = img.convert("RGBA" if has_alpha else "RGB")
    img.info.pop("icc_profile", None)
    return img


def scaled(img: Image.Image, long_edge: int) -> Image.Image:
    w, h = img.size
    cur = max(w, h)
    if long_edge >= cur:
        return img
    s = long_edge / cur
    return img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.Resampling.LANCZOS)


# What Pillow carries from the opened file into a save unless it is removed first:
# the comment (COM) and the XMP block, and the profile and EXIF on some paths. The
# cleaned metadata is attached afterwards, on purpose, by `with_metadata`.
CARRIED_INFO = ("exif", "xmp", "comment", "icc_profile", "photoshop")


def encode(img: Image.Image, fmt: str, quality: int) -> bytes:
    for k in CARRIED_INFO:  # tags are dropped, every one; the cleaned set is spliced in later
        img.info.pop(k, None)
    buf = io.BytesIO()
    if fmt == "JPEG":
        kwargs = dict(quality=quality, optimize=True, progressive=True)
        if quality >= 90:
            kwargs["subsampling"] = 0  # 4:4:4 keeps fine texture and color edges clean
        img.save(buf, "JPEG", **kwargs)  # no exif= and no icc_profile=: metadata is dropped
    else:
        img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# JPEG segments: cut out, then put the cleaned ones back
# ---------------------------------------------------------------------------

# JPEG segments cut out "as shot": EXIF and XMP (APP1), IPTC and Photoshop (APP13),
# comments (COM) and the other APPn. Kept: APP0 (JFIF), APP2 (the ICC color profile,
# which holds nothing private), APP11 (JUMBF: Content Credentials, the signed
# provenance) and APP14 (Adobe: tells a decoder how color is stored), plus every
# table and scan, so the pixels are exactly the camera's. The cleaned EXIF, XMP and
# IPTC are then spliced back in by `with_metadata`.
DROP_SEGMENTS = {0xE1, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEC, 0xED, 0xEF, 0xFE}
ORIENTATION = 0x0112
SEGMENT_MAX = 65_533  # a segment's length field counts itself: 65,535 - 2


def strip_jpeg(data: bytes) -> bytes:
    """The same JPEG without its metadata segments; no decode, no re-encode."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    out = bytearray(b"\xff\xd8")
    i, n = 2, len(data)
    while i < n:
        if data[i] != 0xFF:
            raise ValueError("the JPEG's segment table is broken")
        while i < n and data[i] == 0xFF:  # fill bytes before a marker
            i += 1
        if i >= n:
            break
        marker = data[i]
        i += 1
        if marker == 0xDA:  # start of scan: everything from here is scan data and later tables
            out += b"\xff\xda" + data[i:]
            return bytes(out)
        if marker == 0xD9 or 0xD0 <= marker <= 0xD8 or marker == 0x01:  # no payload
            out += bytes((0xFF, marker))
            continue
        length = int.from_bytes(data[i : i + 2], "big")
        if marker not in DROP_SEGMENTS:
            out += bytes((0xFF, marker)) + data[i : i + length]
        i += length
    return bytes(out)


def segment(marker: int, payload: bytes) -> bytes:
    """One JPEG segment: marker, the length (counting itself), the payload."""
    if len(payload) > SEGMENT_MAX:
        raise ValueError("segment too long")
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def insert_segments(data: bytes, segments: list[bytes]) -> bytes:
    """The JPEG with the segments placed after APP0 (JFIF) when it leads, else right after SOI."""
    if not segments:
        return data
    at = 2
    if data[2:4] == b"\xff\xe0":
        at = 4 + int.from_bytes(data[4:6], "big")
    return data[:at] + b"".join(segments) + data[at:]


def jpeg_segments(data: bytes) -> dict[str, bytes]:
    """The raw EXIF (TIFF bytes), XMP packet and Photoshop IRB of a JPEG, by name, from its headers."""
    out: dict[str, bytes] = {}
    i, n = 2, len(data)
    while i + 4 <= n and data[i] == 0xFF:
        marker = data[i + 1]
        if marker == 0xDA or marker == 0xD9:
            break
        length = int.from_bytes(data[i + 2 : i + 4], "big")
        body = data[i + 4 : i + 2 + length]
        if marker == 0xE1 and body.startswith(b"Exif\x00\x00") and "exif" not in out:
            out["exif"] = body[6:]
        elif marker == 0xE1 and body.startswith(XMP_HEADER) and "xmp" not in out:
            out["xmp"] = body[len(XMP_HEADER) :]
        elif marker == 0xED and body.startswith(PHOTOSHOP_HEADER) and "photoshop" not in out:
            out["photoshop"] = body[len(PHOTOSHOP_HEADER) :]
        i += 2 + length
    return out


# ---------------------------------------------------------------------------
# What is read from a file, and what is cleaned out of it
# ---------------------------------------------------------------------------

TAG_MAKE, TAG_MODEL, TAG_DATETIME, TAG_EXIF_IFD = 0x010F, 0x0110, 0x0132, 0x8769
TAG_DATETIME_ORIGINAL, TAG_LENS_MODEL = 0x9003, 0xA434
TAG_IMAGE_DESCRIPTION, TAG_ARTIST, TAG_COPYRIGHT = 0x010E, 0x013B, 0x8298
TAG_GPS_IFD = 0x8825
# Dropped from the Exif IFD: MakerNote, the owner's name, the body and lens serial numbers,
# and the pixel dimensions (stale once the copy is resized).
EXIF_DROP = {0x927C, 0xA430, 0xA431, 0xA435, 0xA002, 0xA003}
EXIF_DATE = re.compile(r"^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$")

XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"
PHOTOSHOP_HEADER = b"Photoshop 3.0\x00"
IPTC_RESOURCE = 0x0404
# IPTC datasets (record 2) read, and the one dropped: Contact (2:118) is the creator's
# address and phone number.
IPTC = {
    "title": (2, 5),
    "keywords": (2, 25),
    "creator": (2, 80),
    "credit": (2, 110),
    "origin": (2, 115),
    "copyright": (2, 116),
    "description": (2, 120),
}
IPTC_DROP = {(2, 118)}

NS = {
    "x": "adobe:ns:meta/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "dc": "http://purl.org/dc/elements/1.1/",
    "xmp": "http://ns.adobe.com/xap/1.0/",
    "xmpRights": "http://ns.adobe.com/xap/1.0/rights/",
    "xmpMM": "http://ns.adobe.com/xap/1.0/mm/",
    "photoshop": "http://ns.adobe.com/photoshop/1.0/",
    "Iptc4xmpCore": "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/",
    "Iptc4xmpExt": "http://iptc.org/std/Iptc4xmpExt/2008-02-29/",
    "plus": "http://ns.useplus.org/ldf/xmp/1.0/",
    "crs": "http://ns.adobe.com/camera-raw-settings/1.0/",
    "aux": "http://ns.adobe.com/exif/1.0/aux/",
    "exifEX": "http://cipa.jp/exif/1.0/",
}
RDF_LI = f"{{{NS['rdf']}}}li"
RDF_ABOUT = f"{{{NS['rdf']}}}about"
# XMP properties read, by field, in the order tried.
XMP_FIELDS = {
    "title": [("dc", "title")],
    "description": [("dc", "description")],
    "keywords": [("dc", "subject")],
    "creator": [("dc", "creator")],
    "credit": [("photoshop", "Credit")],
    "copyright": [("dc", "rights")],
    "origin": [("photoshop", "Source")],
    "sourceUrl": [("xmpRights", "WebStatement"), ("plus", "LicensorURL")],
    "usageTerms": [("xmpRights", "UsageTerms")],
}
# Dropped from the XMP: a whole namespace, or a property by local name in any namespace.
XMP_DROP_NS = {NS["xmpMM"]}
XMP_DROP_LOCAL = {
    "History", "DerivedFrom", "Ingredients", "Pantry", "Manifest",  # editing history, other files
    "DocumentID", "InstanceID", "OriginalDocumentID",  # document identity
    "RawFileName",  # the raw file's name on disk
    "Thumbnails",  # embedded previews
    "CreatorContactInfo",  # the creator's address and phone
    "SerialNumber", "LensSerialNumber", "BodySerialNumber", "CameraOwnerName", "OwnerName",
}


@dataclass
class Meta:
    """Everything read from an original before its copy is made."""
    capture: dict = field(default_factory=dict)
    describe: dict = field(default_factory=dict)
    exif: bytes | None = None  # cleaned TIFF bytes, without the "Exif\0\0" prefix
    xmp: bytes | None = None  # cleaned packet
    iptc: bytes | None = None  # cleaned IPTC block, for an APP13 resource
    orientation: int = 1
    notes: list[str] = field(default_factory=list)


def exif_text(value: object) -> str | None:
    """An ASCII tag as a clean string: bytes decoded, NULs and whitespace trimmed, empty as None."""
    if isinstance(value, bytes):
        value = value.decode("utf-8", "replace")
    if not isinstance(value, str):
        return None
    text = value.replace("\0", "").strip()
    return text or None


def exif_date_to_iso(value: str) -> str | None:
    """"2026:05:04 13:22:10" as the camera writes it, to ISO 8601 with no timezone guessed."""
    m = EXIF_DATE.match(value.strip())
    if not m or m.group(1) == "0000":  # some cameras write all zeros when the clock was never set
        return None
    y, mo, d, h, mi, s = m.groups()
    return f"{y}-{mo}-{d}T{h}:{mi}:{s}"


def join_camera(make: str | None, model: str | None) -> str | None:
    """Make and model as one name; a model that already starts with the make's first word
    ("Canon" / "Canon EOS R5", "NIKON CORPORATION" / "NIKON Z 6") is not said twice."""
    if not make or not model:
        return model or make
    first = make.split()[0].lower()
    return model if make and model.lower().startswith(first) else f"{make} {model}"


def one_line(s: str | None) -> str | None:
    """Whitespace collapsed to single spaces; empty as None."""
    if s is None:
        return None
    t = re.sub(r"\s+", " ", s).strip()
    return t or None


def capture_from_exif(exif: Image.Exif) -> dict:
    """The capture fields from an EXIF: date, camera, lens."""
    out: dict = {}
    ifd0 = {t: exif_text(exif.get(t)) for t in (TAG_MAKE, TAG_MODEL, TAG_DATETIME)}
    try:
        sub = exif.get_ifd(TAG_EXIF_IFD)
    except Exception:  # a broken Exif IFD is not a reason to lose the make and model
        sub = {}
    taken = exif_text(sub.get(TAG_DATETIME_ORIGINAL)) or ifd0[TAG_DATETIME]
    lens = exif_text(sub.get(TAG_LENS_MODEL))
    when = exif_date_to_iso(taken) if taken else None
    if when:
        out["capturedAt"] = when
    camera = join_camera(ifd0[TAG_MAKE], ifd0[TAG_MODEL])
    if camera:
        out["camera"] = camera
    if lens:
        out["lens"] = lens
    return out


def read_capture(path: Path) -> dict:
    """The capture fields of an original, from its EXIF; {} for a file with none."""
    try:
        with Image.open(path) as img:
            return capture_from_exif(img.getexif())
    except Exception:
        return {}


def clean_exif(exif: Image.Exif, upright: bool) -> bytes | None:
    """The EXIF without the GPS IFD, MakerNote, serial numbers, owner name and thumbnail
    (Pillow writes IFD0 and its sub-IFDs only, never the thumbnail IFD). `upright` sets
    the orientation to 1, for a copy whose pixels were turned. None when nothing is left."""
    if TAG_GPS_IFD in exif:
        del exif[TAG_GPS_IFD]
    try:
        sub = exif.get_ifd(TAG_EXIF_IFD)
        for tag in EXIF_DROP:
            if tag in sub:
                del sub[tag]
    except Exception:
        pass
    if upright and ORIENTATION in exif:
        exif[ORIENTATION] = 1
    if not any(True for _ in exif):
        return None
    try:
        data = exif.tobytes()
    except Exception:
        return None
    # Pillow puts the JPEG prefix on; the TIFF alone is kept, and `with_metadata` adds it once.
    return data[6:] if data.startswith(b"Exif\x00\x00") else data


def decode_iptc(value: bytes | str) -> str | None:
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except UnicodeDecodeError:
            value = value.decode("latin-1")
    return one_line(value)


def iptc_records(block: bytes) -> list[tuple[int, int, bytes]]:
    """The (record, dataset, data) triples of an IPTC-IIM block; stops at the first oddity."""
    out = []
    i, n = 0, len(block)
    while i + 5 <= n and block[i] == 0x1C:
        record, dataset = block[i + 1], block[i + 2]
        size = int.from_bytes(block[i + 3 : i + 5], "big")
        i += 5
        if size & 0x8000:  # extended size: the count of length bytes follows
            count = size & 0x7FFF
            size = int.from_bytes(block[i : i + count], "big")
            i += count
        out.append((record, dataset, block[i : i + size]))
        i += size
    return out


def describe_from_iptc(block: bytes) -> dict:
    found: dict = {}
    keywords: list[str] = []
    for record, dataset, data in iptc_records(block):
        for name, (r, d) in IPTC.items():
            if (record, dataset) != (r, d):
                continue
            text = decode_iptc(data)
            if not text:
                continue
            if name == "keywords":
                keywords.append(text)
            else:
                found.setdefault(name, text)
    if keywords:
        found["keywords"] = keywords
    return found


def clean_iptc(block: bytes) -> bytes | None:
    """The IPTC block without the contact dataset; None when nothing is left."""
    out = bytearray()
    for record, dataset, data in iptc_records(block):
        if (record, dataset) in IPTC_DROP:
            continue
        out += bytes((0x1C, record, dataset))
        if len(data) < 0x8000:
            out += struct.pack(">H", len(data))
        else:
            out += struct.pack(">H", 0x8004) + struct.pack(">I", len(data))
        out += data
    return bytes(out) or None


def photoshop_resources(irb: bytes) -> dict[int, bytes]:
    """The Photoshop image resources of an APP13 body (after its header), by id."""
    out: dict[int, bytes] = {}
    i, n = 0, len(irb)
    while i + 12 <= n and irb[i : i + 4] == b"8BIM":
        rid = int.from_bytes(irb[i + 4 : i + 6], "big")
        name_len = irb[i + 6]
        i += 7 + name_len
        if (name_len + 1) % 2:
            i += 1
        size = int.from_bytes(irb[i : i + 4], "big")
        i += 4
        out.setdefault(rid, irb[i : i + size])
        i += size + (size % 2)
    return out


def photoshop_segment(iptc: bytes) -> bytes:
    """An APP13 payload holding one resource, the IPTC block."""
    body = b"8BIM" + struct.pack(">H", IPTC_RESOURCE) + b"\x00\x00" + struct.pack(">I", len(iptc)) + iptc
    if len(iptc) % 2:
        body += b"\x00"
    return PHOTOSHOP_HEADER + body


def xmp_namespaces(packet: str) -> None:
    """Register every prefix the packet declares, so the rewritten packet keeps them."""
    for prefix, uri in re.findall(r'xmlns:([A-Za-z0-9_.-]+)="([^"]+)"', packet):
        if prefix not in ("xml", "xmlns"):
            try:
                ET.register_namespace(prefix, uri)
            except ValueError:
                pass


def xmp_root(packet: bytes) -> ET.Element | None:
    text = packet.decode("utf-8", "replace")
    start = text.find("<x:xmpmeta")
    end = text.rfind("</x:xmpmeta>")
    if start < 0 or end < 0:
        return None
    xmp_namespaces(text)
    try:
        return ET.fromstring(text[start : end + len("</x:xmpmeta>")])
    except ET.ParseError:
        return None


def xmp_values(desc: ET.Element, uri: str, local: str) -> list[str]:
    """A property's values: an attribute, a simple element, or the items of its Alt/Bag/Seq."""
    tag = f"{{{uri}}}{local}"
    attr = desc.get(tag)
    if attr is not None:
        return [attr]
    el = desc.find(tag)
    if el is None:
        return []
    items = [li.text or "" for li in el.iter(RDF_LI)]
    return items if items else [el.text or ""]


def describe_from_xmp(root: ET.Element) -> dict:
    found: dict = {}
    for desc in root.iter(f"{{{NS['rdf']}}}Description"):
        for name, sources in XMP_FIELDS.items():
            if name in found:
                continue
            for prefix, local in sources:
                values = [v for v in (one_line(v) for v in xmp_values(desc, NS[prefix], local)) if v]
                if not values:
                    continue
                found[name] = values if name == "keywords" else values[0]
                break
    return found


def local_of(tag: str) -> tuple[str, str]:
    """(namespace, local name) of an ElementTree tag."""
    if tag.startswith("{"):
        uri, local = tag[1:].split("}", 1)
        return uri, local
    return "", tag


def drop_from_xmp(root: ET.Element) -> None:
    """Remove the dropped namespaces and properties, as elements and as attributes, everywhere."""
    def unwanted(tag: str) -> bool:
        uri, local = local_of(tag)
        return uri in XMP_DROP_NS or local in XMP_DROP_LOCAL or local.startswith("GPS")

    for parent in list(root.iter()):
        for child in list(parent):
            if unwanted(child.tag):
                parent.remove(child)
        for attr in list(parent.attrib):
            if unwanted(attr):
                del parent.attrib[attr]


def clean_xmp(packet: bytes) -> bytes | None:
    """The packet without editing history, document ids, paths, GPS, serials, thumbnails and
    contact details; None when no description is left."""
    root = xmp_root(packet)
    if root is None:
        return None
    drop_from_xmp(root)
    rdf = root.find(f"{{{NS['rdf']}}}RDF")
    if rdf is None:
        return None
    for desc in list(rdf):
        has_props = any(a != RDF_ABOUT for a in desc.attrib) or len(desc) > 0
        if not has_props:
            rdf.remove(desc)
    if len(rdf) == 0:
        return None
    body = ET.tostring(root, encoding="unicode")
    return ('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' + body + '<?xpacket end="w"?>').encode("utf-8")


def merge_describe(*sources: dict) -> dict:
    """First non-empty value per field across the sources; keywords deduplicated, in order."""
    out: dict = {}
    for src in sources:
        for k, v in src.items():
            if k == "keywords":
                seen = {w.lower() for w in out.get("keywords", [])}
                words = out.setdefault("keywords", [])
                for w in v:
                    if w.lower() not in seen:
                        seen.add(w.lower())
                        words.append(w)
            elif k not in out and v:
                out[k] = v
    if not out.get("keywords"):
        out.pop("keywords", None)
    return out


def read_meta(path: Path) -> Meta:
    """Everything the original says about itself, and its cleaned metadata segments."""
    meta = Meta()
    try:
        with Image.open(path) as img:
            info = dict(img.info)
            exif = img.getexif()
            meta.orientation = int(exif.get(ORIENTATION, 1) or 1)
            meta.capture = capture_from_exif(exif)
            from_exif = {
                "description": one_line(exif_text(exif.get(TAG_IMAGE_DESCRIPTION))),
                "creator": one_line(exif_text(exif.get(TAG_ARTIST))),
                "copyright": one_line(exif_text(exif.get(TAG_COPYRIGHT))),
            }
            from_exif = {k: v for k, v in from_exif.items() if v}
            upright = False  # decided by the caller; the cleaned EXIF is finished in `attach`
            meta.exif = clean_exif(exif, upright)
    except Exception:
        return meta
    iptc_block = None
    photoshop = info.get("photoshop")
    if isinstance(photoshop, dict) and isinstance(photoshop.get(IPTC_RESOURCE), bytes):
        iptc_block = photoshop[IPTC_RESOURCE]
    elif isinstance(info.get("iptc"), bytes):
        iptc_block = info["iptc"]
    from_iptc = describe_from_iptc(iptc_block) if iptc_block else {}
    meta.iptc = clean_iptc(iptc_block) if iptc_block else None
    from_xmp: dict = {}
    xmp = info.get("xmp")
    if isinstance(xmp, bytes):
        root = xmp_root(xmp)
        if root is not None:
            from_xmp = describe_from_xmp(root)
            meta.xmp = clean_xmp(xmp)
    meta.describe = merge_describe(from_iptc, from_xmp, from_exif)
    return meta


def with_metadata(data: bytes, suffix: str, meta: Meta, upright: bool) -> bytes:
    """The encoded copy with the cleaned metadata attached: APP1 EXIF, APP1 XMP and APP13 IPTC
    for a JPEG; an eXIf chunk and an XMP text chunk for a PNG."""
    exif = meta.exif
    if exif is not None and upright:
        e = Image.Exif()
        e.load(exif)
        exif = clean_exif(e, upright=True)
    if suffix == ".jpg":
        segments = []
        if exif is not None and len(exif) + 6 <= SEGMENT_MAX:
            segments.append(segment(0xE1, b"Exif\x00\x00" + exif))
        elif exif is not None:
            meta.notes.append("EXIF too long to keep")
        if meta.xmp is not None and len(meta.xmp) + len(XMP_HEADER) <= SEGMENT_MAX:
            segments.append(segment(0xE1, XMP_HEADER + meta.xmp))
        elif meta.xmp is not None:
            meta.notes.append("XMP too long to keep")
        if meta.iptc is not None and len(meta.iptc) + 32 <= SEGMENT_MAX:
            segments.append(segment(0xED, photoshop_segment(meta.iptc)))
        return insert_segments(data, segments)
    if suffix == ".png":
        img = Image.open(io.BytesIO(data))
        img.load()
        for k in CARRIED_INFO:
            img.info.pop(k, None)
        pnginfo = PngInfo()
        if meta.xmp is not None:
            pnginfo.add_itxt("XML:com.adobe.xmp", meta.xmp.decode("utf-8", "replace"))
        buf = io.BytesIO()
        kwargs: dict = {"optimize": True, "pnginfo": pnginfo}
        if exif is not None:
            kwargs["exif"] = exif
        img.save(buf, "PNG", **kwargs)
        return buf.getvalue()
    return data


# ---------------------------------------------------------------------------
# Sizing
# ---------------------------------------------------------------------------

def within_limits(long_edge: int, img: Image.Image) -> int:
    """Clamp a long edge to the transformation limits (12,000 px, 100 megapixels)."""
    w, h = img.size
    long_edge = min(long_edge, MAX_DIMENSION)
    area_at = lambda L: (L * L * min(w, h)) // max(w, h)  # noqa: E731
    if area_at(long_edge) > MAX_AREA:
        long_edge = int(math.sqrt(MAX_AREA * max(w, h) / min(w, h)))
    return long_edge


def largest_under_cap(img: Image.Image, fmt: str, quality: int) -> tuple[bytes, Image.Image]:
    """The biggest long edge whose encoded file is under the cap, by estimate then bisection."""
    full = within_limits(max(img.size), img)
    candidate = scaled(img, full)
    data = encode(candidate, fmt, quality)
    if len(data) <= CAP_BYTES:
        return data, candidate
    # Bytes scale roughly with area: guess, then bisect between a fit and a miss.
    lo_fit, hi_miss = 0, full
    guess = int(full * math.sqrt(CAP_BYTES / len(data)) * 0.97)
    best: tuple[bytes, Image.Image] | None = None
    for _ in range(9):
        L = guess if best is None and lo_fit == 0 else (lo_fit + hi_miss) // 2
        L = max(256, min(L, hi_miss - 1))
        candidate = scaled(img, L)
        data = encode(candidate, fmt, quality)
        if len(data) <= CAP_BYTES:
            best, lo_fit = (data, candidate), L
        else:
            hi_miss = L
        if hi_miss - lo_fit <= max(16, full // 100):
            break
    if best is None:  # even 256 px missed: the only way is a lower quality
        return encode(scaled(img, 256), fmt, max(60, quality - 20)), scaled(img, 256)
    return best


Prepared = tuple[bytes, str, tuple[int, int], tuple[int, int], str]


def re_encode(job: Job, quality: int, meta: Meta) -> Prepared:
    """Decode, sRGB, orientation applied, JPEG (or PNG with transparency) at full size or the
    largest size under the cap, with the cleaned metadata attached, orientation set upright."""
    src_ext = job.src.suffix.lower()
    img = open_image(job.src)
    w, h = img.size
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    fmt = "PNG" if (src_ext == ".png" and has_alpha) else "JPEG"
    img = to_srgb(img)
    data, out = largest_under_cap(img, fmt, quality)
    note = "re-encoded at full size" if out.size == (w, h) else "resized to the largest under the cap"
    if fmt == "PNG":
        note += ", kept PNG for its transparency"
    elif src_ext not in (".jpg", ".jpeg"):
        note += f", {src_ext[1:].upper()} to JPEG"
    suffix = ".png" if fmt == "PNG" else ".jpg"
    return with_metadata(data, suffix, meta, upright=True), suffix, (w, h), out.size, note


def as_shot(job: Job, quality: int, meta: Meta) -> Prepared:
    """A JPEG keeps its bytes and gets its cleaned metadata back. A PNG is re-saved losslessly.
    Anything that cannot stay as it is (a JPEG that needs rotating or is over the cap; any
    other format) is re-encoded at full size, and the note says why."""
    src_ext = job.src.suffix.lower()
    if src_ext in (".jpg", ".jpeg"):
        raw = job.src.read_bytes()
        with Image.open(job.src) as probe:
            size = probe.size
        if len(raw) > CAP_BYTES:
            why = f"over {CAP_LABEL}"
        elif meta.orientation not in (0, 1):
            why = "it needed rotating"
        else:
            data = with_metadata(strip_jpeg(raw), ".jpg", meta, upright=False)
            return data, ".jpg", size, size, "as shot, metadata cleaned"
    elif src_ext == ".png":
        img = Image.open(job.src)
        img.load()
        size = img.size
        data = encode(img, "PNG", quality)
        if len(data) <= CAP_BYTES:
            return with_metadata(data, ".png", meta, upright=False), ".png", size, size, "as shot, re-saved losslessly"
        why = f"over {CAP_LABEL}"
    else:
        why = f"{src_ext[1:].upper()} is not a web format"
    data, suffix, src_px, out_px, note = re_encode(job, quality, meta)
    return data, suffix, src_px, out_px, f"{note} (not as shot: {why})"


def prepare(job: Job, mode: str, quality: int, meta: Meta) -> Prepared:
    return as_shot(job, quality, meta) if mode == "copy" else re_encode(job, quality, meta)


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

MANIFEST_NAME = "photonrelic-manifest.json"
MODES = {"as-shot": "copy", "re-encode": "max"}


def write_manifest(out_dir: Path, files: dict[str, dict]) -> Path:
    """The manifest beside the web copies; sorted keys, so two runs of the same shoot diff cleanly."""
    path = out_dir / MANIFEST_NAME
    body = {"version": 1, "files": {k: files[k] for k in sorted(files)}}
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


def ask_mode() -> str:
    """The menu. Returns "copy" | "max", or "quit" on q, Q, Ctrl-C or Ctrl-D. A new way to
    prepare a shoot is a row here and a function above."""
    print("\nEvery choice fixes the file name (lowercase, whitespace and punctuation to hyphens),")
    print("keeps what the file says about itself and drops GPS, serial numbers, MakerNote,")
    print("thumbnails and editing history.\n")
    print("  1  As shot: a JPEG keeps its bytes; only what cannot stay as it is gets re-encoded  (default)")
    print(f"  2  Re-encode: sRGB, quality 92, full size or the largest under {CAP_LABEL}")
    print("  q  Quit, nothing written")
    try:
        while True:
            raw = input("Choose [1-2, Enter for 1, q to quit]: ").strip()
            if raw.lower() == "q":
                return "quit"
            if raw in ("", "1"):
                return "copy"
            if raw == "2":
                return "max"
            print("  1, 2, or q to quit")
    except (KeyboardInterrupt, EOFError):
        print()
        return "quit"


def ask_license(vendor: str, count: int) -> str | None:
    """Which license was bought for the run's stock files; Enter leaves it blank."""
    print(f"\n{count} {vendor} file(s) found. Which license was bought?")
    for i, choice in enumerate(LICENSE_CHOICES, 1):
        print(f"  {i}  {vendor} {choice}")
    print("  Enter  leave the license blank, to fill in later")
    try:
        while True:
            raw = input(f"Choose [1-{len(LICENSE_CHOICES)}, Enter for blank]: ").strip()
            if raw == "":
                return None
            if raw.isdigit() and 1 <= int(raw) <= len(LICENSE_CHOICES):
                return f"{vendor} {LICENSE_CHOICES[int(raw) - 1]}"
            print(f"  a number from 1 to {len(LICENSE_CHOICES)}, or Enter")
    except (KeyboardInterrupt, EOFError):
        print()
        return None


def describe_summary(d: dict) -> str:
    """"noted: title, 50 keywords, creator, origin, master" for the table's last column."""
    parts = []
    for k in ("title", "description", "keywords", "creator", "credit", "copyright", "origin", "sourceUrl", "usageTerms", "license", "masterName"):
        if k not in d:
            continue
        if k == "keywords":
            parts.append(f"{len(d[k])} keywords")
        elif k == "masterName":
            parts.append("master")
        elif k == "sourceUrl":
            parts.append("source URL")
        elif k == "usageTerms":
            parts.append("usage terms")
        else:
            parts.append(k)
    return f"; noted: {', '.join(parts)}" if parts else ""


def main(argv: list[str] | None = None) -> int:
    """Run, then close with the version line, so a pasted run says which script made it."""
    try:
        code = run(argv)
    except SystemExit:  # --help and --version have already printed; argparse errors too
        raise
    except Exception:
        print(f"prep-images {__version__}")
        raise
    print(f"prep-images {__version__}")
    return code


def run(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version=f"prep-images {__version__}")
    ap.add_argument("inputs", nargs="+", help="photos, or folders of photos (subfolders are kept)")
    ap.add_argument("--out", help="output folder (default: <folder>-web beside the first folder, or ./prepped)")
    ap.add_argument("--mode", choices=sorted(MODES), help="as-shot (the default when not asked) or re-encode")
    ap.add_argument("--license", help='the license to record for stock files, e.g. "Adobe Stock Standard"')
    ap.add_argument("--quality", type=int, default=92, help="JPEG quality when re-encoding, default 92")
    ap.add_argument("--force", action="store_true", help="overwrite files already in the output folder")
    ap.add_argument("--dry-run", action="store_true", help="show the plan and every field read; write nothing")
    ap.add_argument("--yes", "-y", action="store_true", help="no questions: as-shot unless --mode, license blank unless --license")
    a = ap.parse_args(argv)

    jobs, out_dir, skipped, roots = collect(a.inputs, Path(a.out).expanduser() if a.out else None)
    for s in skipped:
        print(f"skip  {s}")
    if not jobs:
        print("Nothing to do.")
        return 1
    if any(j.src.suffix.lower() in (".heic", ".heif") for j in jobs) and not HEIF:
        print("HEIC files need pillow-heif: python3 -m pip install pillow-heif")
        return 1
    problem = output_is_safe(jobs, out_dir, roots)
    if problem:
        print(f"refusing: {problem}")
        return 1

    interactive = not a.yes and sys.stdin.isatty()
    if a.mode:
        mode = MODES[a.mode]
    elif interactive:
        mode = ask_mode()
        if mode == "quit":
            print("Quit: nothing written.")
            return 1
    else:
        mode = "copy"

    stock = {j.src: stock_of(j.src) for j in jobs}
    stock_jobs = [j for j in jobs if stock[j.src]]
    license_text = a.license
    if stock_jobs and license_text is None and interactive:
        vendor = stock[stock_jobs[0].src][0].rsplit(" ", 1)[0]  # type: ignore[index]
        license_text = ask_license(vendor, len(stock_jobs))

    what = {
        "max": f"re-encode: sRGB, quality {a.quality}, full size or the largest under {CAP_LABEL}",
        "copy": "as shot: bytes kept, metadata cleaned",
    }[mode]
    print(f"\n{len(jobs)} file(s) → {out_dir}  ({what})")
    if a.dry_run:
        print("dry run: nothing is written")
    # A table, one row per file as it finishes; the name columns are sized from the whole list up front.
    nw = max(len(j.src.name) for j in jobs)
    ow = max(len(str(j.out.relative_to(out_dir))) for j in jobs)
    pw = 27  # "12000 × 8000 → 6704 × 4469"
    header = f"{'':5} {'original':<{nw}}   {'web copy':<{ow}} {'pixels':<{pw}} {'before':>9} {'after':>9} {'saved':>6}  what happened"
    print()
    print(header)
    print("-" * len(header))
    failures = 0
    before_total = 0
    after_total = 0
    manifest: dict[str, dict] = {}  # web copy's name in the output folder → its entry
    for j in jobs:
        before = j.src.stat().st_size
        try:
            meta = read_meta(j.src)
            # The original's capture data, read before its tags are gone for good; the pixel size
            # is the original's after orientation, the same way round as the web copy.
            describe = dict(meta.describe)
            vendor = stock[j.src]
            if vendor:
                origin, url = vendor
                mismatch = describe.get("origin") and describe["origin"] != origin.rsplit(" ", 1)[1]
                describe["origin"] = origin
                describe.setdefault("sourceUrl", url)
                if license_text:
                    describe["license"] = license_text
                if mismatch:
                    meta.notes.append(f"IPTC source says {meta.describe['origin']}, name says {origin}")
            if j.master is not None:
                describe["masterName"] = j.master.name
            data, suffix, src_px, out_px, note = prepare(j, mode, a.quality, meta)
        except Exception as e:  # one bad file does not stop the shoot
            failures += 1
            print(f"{'FAIL':5} {j.src.name:<{nw}}   {e}")
            continue
        out = j.out.with_suffix(suffix)
        rel = str(out.relative_to(out_dir)).replace("\\", "/")
        after = len(data)
        if out.exists() and out.samefile(j.src):  # belt and braces behind output_is_safe
            failures += 1
            print(f"{'FAIL':5} {j.src.name:<{nw}}   the output is the original itself")
            continue
        entry: dict = {**meta.capture, "originalWidth": src_px[0], "originalHeight": src_px[1]}
        if describe:
            entry["describe"] = describe
        manifest[rel] = entry
        note += describe_summary(describe) + "".join(f"; {n}" for n in meta.notes)
        if out.exists() and not a.force and not a.dry_run:
            failures += 1
            kept = out.stat().st_size
            print(f"{'KEEP':5} {j.src.name:<{nw}} → {rel:<{ow}} {fmt_pixels(src_px, out_px):<{pw}} {fmt_bytes(before):>9} {fmt_bytes(kept):>9} {fmt_saved(before, kept):>6}  already there, left alone (--force replaces it)")
            continue
        if not a.dry_run:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
        before_total += before
        after_total += after
        print(f"{'ok':5} {j.src.name:<{nw}} → {rel:<{ow}} {fmt_pixels(src_px, out_px):<{pw}} {fmt_bytes(before):>9} {fmt_bytes(after):>9} {fmt_saved(before, after):>6}  {note}")
        if a.dry_run:
            for k in ("title", "description", "keywords", "creator", "credit", "copyright", "origin", "sourceUrl", "usageTerms", "license", "masterName"):
                if k in describe:
                    v = describe[k]
                    shown = ", ".join(v) if isinstance(v, list) else v
                    print(f"{'':5}   {k}: {shown}")
        if j.master is not None:
            target = out.parent / j.master.name
            msize = j.master.stat().st_size
            if target.exists() and not a.force and not a.dry_run:
                print(f"{'KEEP':5} {j.master.name:<{nw}} → {str(target.relative_to(out_dir)):<{ow}} {'':<{pw}} {fmt_bytes(msize):>9} {'':>9} {'':>6}  master, already there")
            else:
                if not a.dry_run:
                    shutil.copyfile(j.master, target)
                print(f"{'copy':5} {j.master.name:<{nw}} → {str(target.relative_to(out_dir)):<{ow}} {'':<{pw}} {fmt_bytes(msize):>9} {fmt_bytes(msize):>9} {'0%':>6}  master of {rel}, copied untouched")
    verb = "planned" if a.dry_run else "prepared"
    done = len(jobs) - failures
    print(f"\n{done} of {len(jobs)} {verb}: {fmt_bytes(before_total)} → {fmt_bytes(after_total)} ({fmt_saved(before_total, after_total)}) in {out_dir}" + (f"; {failures} not written" if failures else ""))
    if manifest and not a.dry_run:
        # Written for every copy in the folder, kept ones included, so the manifest is whole
        # after a second run; a copy that failed has no entry.
        write_manifest(out_dir, manifest)
        dated = sum(1 for m in manifest.values() if "capturedAt" in m)
        described = sum(1 for m in manifest.values() if "describe" in m)
        print(f"Entries for {len(manifest)} file(s), {dated} with a capture date, {described} described, in {MANIFEST_NAME}: the Upload page reads it.")
    if not a.dry_run and failures < len(jobs):
        print("Next: PhotonRelic › Upload, give the shoot its subject, drop this folder.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
