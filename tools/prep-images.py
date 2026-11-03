#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["Pillow>=10", "pillow-heif>=0.16"]
# ///
"""prep-images: make web copies of a shoot for the PhotonRelic library.

Keep your originals where they are. This script writes a prepared copy of each
photo into a second folder, ready to drop on PhotonRelic's Upload page:

  * resized to a chosen long edge, or to the largest size whose file fits
    under the resizer's input cap (19.95 MB, the same cap the library enforces),
    or left "as shot": the pixels and bytes of a JPEG untouched;
  * renamed the way the library files keys: lowercase, every run of spaces or
    punctuation a single hyphen, `.jpeg` as `.jpg` (folder names too, since
    subfolders become subject paths);
  * re-encoded, every file, as JPEG at quality 92 (4:4:4 chroma), orientation
    applied, color converted to sRGB from any embedded profile, EXIF and every
    other tag dropped (camera, date, GPS: privacy); PNG stays PNG when it has
    transparency. A file already under the cap is re-encoded too, so the shoot
    is uniform and smaller on disk. "As shot" (menu option 2, --as-shot) is the
    exception: a JPEG keeps its bytes and only loses its tags (the EXIF, XMP,
    IPTC and comment segments are cut out; the color profile stays); a JPEG
    that needs rotating or is over the cap, and any other format, is re-encoded
    as above and the table says why;
  * noted, before the tags go, in a manifest the Upload page reads: the capture
    date and time as the camera wrote them (DateTimeOriginal, or DateTime), the
    camera (Make and Model), the lens (LensModel) and the original pixel size.
    It is `photonrelic-manifest.json` in the output folder, keyed by each web
    copy's name inside that folder, with absent fields left out:

        {"version": 1, "files": {"details/side-view.jpg": {
          "capturedAt": "2026-05-04T13:22:10", "camera": "Canon EOS R5",
          "lens": "RF24-70mm F2.8 L IS USM", "originalWidth": 6000, "originalHeight": 4000}}}

    Nothing else is read from the EXIF: no GPS, no serial numbers, no artist or
    owner name. Drop the folder with the manifest in it and the uploader sends
    each file's entry along and leaves the manifest itself behind.

Nothing is written over an original and no output is overwritten unless
--force. Run it with no size flag to be asked.

    python3 tools/prep-images.py ~/Pictures/shoots/spring
    python3 tools/prep-images.py ~/Pictures/shoots/spring --max --yes
    python3 tools/prep-images.py ~/Pictures/shoots/spring --as-shot
    python3 tools/prep-images.py IMG_0001.JPG "Side View.jpeg" --size 2560 --out ./web

Needs Pillow (and pillow-heif for .heic): `python3 -m pip install Pillow pillow-heif`,
or run it with `uv run tools/prep-images.py …`, which installs them itself.
"""

from __future__ import annotations

__version__ = "1.0"

import argparse
import io
import json
import math
import re
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    from PIL import Image, ImageCms, ImageOps # type: ignore
except ImportError:  # pragma: no cover - the message is the point
    sys.exit(
        "Pillow is not installed. Run `python3 -m pip install Pillow pillow-heif` "
        "or `uv run tools/prep-images.py …`."
    )

try:  # HEIC from an iPhone; optional
    import pillow_heif # type: ignore

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

# Long edges offered by the menu, in pixels.
SIZES = [1600, 2048, 2560, 3200, 4000]

WEB_EXT = {".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"}
CAMERA_EXT = {".tif", ".tiff", ".heic", ".heif"}
INPUT_EXT = WEB_EXT | CAMERA_EXT

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


def collect(inputs: list[str], out_dir: Path | None) -> tuple[list[Job], Path, list[str], list[Path]]:
    """Every image under the inputs, with its output path; folders keep their structure."""
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
        for f in files:
            if f.name.startswith("."):
                continue
            if f.suffix.lower() not in INPUT_EXT:
                skipped.append(f"{f}: not an image the store takes")
                continue
            rel_parts = [slugify_stem(part) or "x" for part in f.relative_to(base).parts[:-1]]
            rel = Path(*rel_parts, slugify_name(f.name)) if rel_parts else Path(slugify_name(f.name))
            jobs.append(Job(src=f, rel=rel, out=out_dir / rel))
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
# the comment (COM) and the XMP block (Pillow 11), and the profile and EXIF on some paths.
CARRIED_INFO = ("exif", "xmp", "comment", "icc_profile", "photoshop")


def encode(img: Image.Image, fmt: str, quality: int) -> bytes:
    for k in CARRIED_INFO:  # tags are dropped, every one; a re-encode must not smuggle them
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


# JPEG segments cut out "as shot": EXIF and XMP (APP1), IPTC and Photoshop (APP13),
# comments (COM) and the other APPn. Kept: APP0 (JFIF), APP2 (the ICC color profile,
# which holds nothing private) and APP14 (Adobe: tells a decoder how color is stored),
# plus every table and scan, so the pixels are exactly the camera's.
DROP_SEGMENTS = {0xE1, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEF, 0xFE}
ORIENTATION = 0x0112


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


# The capture data the manifest keeps. Only these tags are read: the reader never
# touches the GPS IFD (0x8825), the serial numbers (0xA431, 0xA435), Artist (0x013B)
# or Copyright (0x8298), so nothing private can reach the manifest by accident.
MANIFEST_NAME = "photonrelic-manifest.json"
TAG_MAKE, TAG_MODEL, TAG_DATETIME, TAG_EXIF_IFD = 0x010F, 0x0110, 0x0132, 0x8769
TAG_DATETIME_ORIGINAL, TAG_LENS_MODEL = 0x9003, 0xA434
EXIF_DATE = re.compile(r"^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$")


def exif_text(value: object) -> str | None:
    """An ASCII tag as a clean string: bytes decoded, NULs and whitespace trimmed, empty as None."""
    if isinstance(value, bytes):
        value = value.decode("latin-1", "replace")
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
    return model if model.lower().startswith(first) else f"{make} {model}"


def read_capture(path: Path) -> dict:
    """The capture fields of an original, from its EXIF; {} for a file with none."""
    out: dict = {}
    try:
        with Image.open(path) as img:
            exif = img.getexif()
            ifd0 = {t: exif_text(exif.get(t)) for t in (TAG_MAKE, TAG_MODEL, TAG_DATETIME)}
            try:
                sub = exif.get_ifd(TAG_EXIF_IFD)
            except Exception:  # a broken Exif IFD is not a reason to lose the make and model
                sub = {}
            taken = exif_text(sub.get(TAG_DATETIME_ORIGINAL)) or ifd0[TAG_DATETIME]
            lens = exif_text(sub.get(TAG_LENS_MODEL))
    except Exception:
        return out
    when = exif_date_to_iso(taken) if taken else None
    if when:
        out["capturedAt"] = when
    camera = join_camera(ifd0[TAG_MAKE], ifd0[TAG_MODEL])
    if camera:
        out["camera"] = camera
    if lens:
        out["lens"] = lens
    return out


def write_manifest(out_dir: Path, files: dict[str, dict]) -> Path:
    """The manifest beside the web copies; sorted keys, so two runs of the same shoot diff cleanly."""
    path = out_dir / MANIFEST_NAME
    body = {"version": 1, "files": {k: files[k] for k in sorted(files)}}
    path.write_text(json.dumps(body, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return path


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


def prepare(job: Job, mode: str, size: int, quality: int) -> tuple[bytes, str, tuple[int, int], tuple[int, int], str]:
    """Return (encoded bytes, output suffix, source dimensions, output dimensions, note).

    Every file is re-encoded, even one already under the cap: one quality
    across the shoot, metadata gone from all of it, and a smaller folder than
    the camera's JPEGs.
    """
    src_ext = job.src.suffix.lower()
    if mode == "copy":
        return prepare_as_shot(job, quality)
    img = open_image(job.src)
    w, h = img.size
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    fmt = "PNG" if (src_ext == ".png" and has_alpha) else "JPEG"
    img = to_srgb(img)
    if mode == "max":
        data, out = largest_under_cap(img, fmt, quality)
        note = "re-encoded at full size" if out.size == (w, h) else "resized to the largest under the cap"
    else:
        target = within_limits(size, img)
        out = scaled(img, target)
        data = encode(out, fmt, quality)
        note = f"resized to {target} px" if out.size != (w, h) else f"re-encoded at full size (under {target} px already)"
        q = quality
        while len(data) > CAP_BYTES and q > 75:  # a 4,000 px JPEG over the cap is rare; step quality
            q -= 4
            data = encode(out, fmt, q)
            note = f"resized to {target} px, quality {q} to fit the cap"
        if len(data) > CAP_BYTES:
            data, out = largest_under_cap(img, fmt, quality)
            note = "resized to the largest under the cap"
    if fmt == "PNG":
        note += ", kept PNG for its transparency"
    elif src_ext not in (".jpg", ".jpeg"):
        note += f", {src_ext[1:].upper()} to JPEG"
    return data, ".png" if fmt == "PNG" else ".jpg", (w, h), out.size, note


def prepare_as_shot(job: Job, quality: int) -> tuple[bytes, str, tuple[int, int], tuple[int, int], str]:
    """Option 2: a JPEG keeps its bytes and loses its tags. Anything that cannot stay as it is
    (a JPEG that needs rotating or is over the cap; any other format) takes the normal path at
    full size, and the note says why."""
    src_ext = job.src.suffix.lower()
    if src_ext in (".jpg", ".jpeg"):
        raw = job.src.read_bytes()
        with Image.open(job.src) as probe:
            size = probe.size
            orientation = probe.getexif().get(ORIENTATION, 1)
        if len(raw) > CAP_BYTES:
            why = f"over {CAP_LABEL}"
        elif orientation not in (0, 1):
            why = "it needed rotating"
        else:
            return strip_jpeg(raw), ".jpg", size, size, "as shot, tags dropped"
    elif src_ext == ".png":
        why = "PNG is lossless, re-saved without tags"
    else:
        why = f"{src_ext[1:].upper()} is not a web format"
    data, suffix, src_px, out_px, note = prepare(job, "max", 0, quality)
    return data, suffix, src_px, out_px, f"{note} (not as shot: {why})"


def ask_mode() -> tuple[str, int]:
    """The menu. Returns ("max" | "copy" | "size", long edge) or ("quit", 0) on q, Q, Ctrl-C or Ctrl-D."""
    custom = len(SIZES) + 3
    print("\nAll choices fix the file name (lowercase, whitespace and punctuation to hyphens)")
    print("and drop all EXIF and tag data.\n")
    print(f"  1  Re-encoded at quality 92, no resize unless needed to fit under {CAP_LABEL}  (default)")
    print("  2  As shot: no re-encode, no resize, just the file operations for web use")
    for i, L in enumerate(SIZES, 3):
        print(f"  {i}  {L} px long edge")
    print(f"  {custom}  A long edge of your own, in pixels")
    print("  q  Quit, nothing written")
    try:
        while True:
            raw = input(f"Choose [1-{custom}, Enter for 1, q to quit]: ").strip()
            if raw.lower() == "q":
                return "quit", 0
            if raw == "" or raw == "1":
                return "max", 0
            if raw == "2":
                return "copy", 0
            if raw.isdigit() and 3 <= int(raw) < custom:
                return "size", SIZES[int(raw) - 3]
            if raw == str(custom):
                while True:
                    px = input(f"Long edge in pixels [256-{MAX_DIMENSION}, q to quit]: ").strip()
                    if px.lower() == "q":
                        return "quit", 0
                    if px.isdigit() and 256 <= int(px) <= MAX_DIMENSION:
                        return "size", int(px)
                    print(f"  a whole number from 256 to {MAX_DIMENSION}, or q")
                continue
            print(f"  a number from 1 to {custom}, or q to quit")
    except (KeyboardInterrupt, EOFError):
        print()
        return "quit", 0


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
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--size", type=int, metavar="PX", help=f"long edge in pixels (menu: {', '.join(map(str, SIZES))})")
    g.add_argument("--max", action="store_true", help=f"the largest size whose file fits under {CAP_LABEL} (default)")
    g.add_argument("--as-shot", action="store_true", help="no re-encode: fix the name, drop EXIF and every other tag, keep a JPEG's bytes")
    ap.add_argument("--quality", type=int, default=92, help="JPEG quality, default 92")
    ap.add_argument("--force", action="store_true", help="overwrite files already in the output folder")
    ap.add_argument("--dry-run", action="store_true", help="show the plan, write nothing")
    ap.add_argument("--yes", "-y", action="store_true", help="no questions (with no size flag, --max)")
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

    if a.size:
        mode, size = "size", a.size
    elif a.as_shot:
        mode, size = "copy", 0
    elif a.max or a.yes or not sys.stdin.isatty():
        mode, size = "max", 0
    else:
        mode, size = ask_mode()
        if mode == "quit":
            print("Quit: nothing written.")
            return 1

    what = {
        "max": f"largest under {CAP_LABEL}, quality {a.quality}",
        "copy": "as shot: no re-encode, tags dropped",
        "size": f"{size} px long edge, quality {a.quality}",
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
    manifest: dict[str, dict] = {}  # web copy's name in the output folder → its capture entry
    for j in jobs:
        before = j.src.stat().st_size
        try:
            data, suffix, src_px, out_px, note = prepare(j, mode, size, a.quality)
        except Exception as e:  # one bad file does not stop the shoot
            failures += 1
            print(f"{'FAIL':5} {j.src.name:<{nw}}   {e}")
            continue
        out = j.out.with_suffix(suffix)
        rel = str(out.relative_to(out_dir))
        after = len(data)
        if out.exists() and out.samefile(j.src):  # belt and braces behind output_is_safe
            failures += 1
            print(f"{'FAIL':5} {j.src.name:<{nw}}   the output is the original itself")
            continue
        # The original's capture data, read before its tags are gone for good; the pixel size
        # is the original's after orientation, the same way round as the web copy.
        manifest[rel.replace("\\", "/")] = {
            **read_capture(j.src),
            "originalWidth": src_px[0],
            "originalHeight": src_px[1],
        }
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
    verb = "planned" if a.dry_run else "prepared"
    done = len(jobs) - failures
    print(f"\n{done} of {len(jobs)} {verb}: {fmt_bytes(before_total)} → {fmt_bytes(after_total)} ({fmt_saved(before_total, after_total)}) in {out_dir}" + (f"; {failures} not written" if failures else ""))
    if manifest and not a.dry_run:
        # Written for every copy in the folder, kept ones included, so the manifest is whole
        # after a second run; a copy that failed has no entry.
        write_manifest(out_dir, manifest)
        dated = sum(1 for m in manifest.values() if "capturedAt" in m)
        print(f"Capture data for {len(manifest)} file(s), {dated} with a date, in {MANIFEST_NAME}: the Upload page reads it.")
    if not a.dry_run and failures < len(jobs):
        print("Next: PhotonRelic › Upload, give the shoot its subject, drop this folder.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
