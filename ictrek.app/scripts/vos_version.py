"""Resolve VOS revisions against the upstream version in UPSTREAM_VERSION."""

from pathlib import Path
import re
import sys


APP_DIR = Path(__file__).resolve().parents[1]
UPSTREAM_VERSION = (APP_DIR / "UPSTREAM_VERSION").read_text().strip()
UPSTREAM_PATTERN = r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?"


def split_version(version):
    match = re.fullmatch(r"(.+?)([.-])vos\.([0-9]+)", version)
    if not match:
        raise ValueError(f"invalid VOS version: {version}")
    prefix, separator, revision = match.groups()
    if not re.fullmatch(UPSTREAM_PATTERN, prefix) or separator != ("." if "-" in prefix else "-"):
        raise ValueError(f"invalid VOS version: {version}")
    if not re.fullmatch(r"(?:0[1-9]|[1-9][0-9]+)", revision):
        raise ValueError(f"invalid VOS revision: {revision}")
    return prefix, int(revision)


def next_version(current, upstream):
    if re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", current):
        revision = 1
    else:
        prefix, previous = split_version(current)
        revision = previous + 1 if prefix == upstream else 1
    separator = "." if "-" in upstream else "-"
    return f"{upstream}{separator}vos.{revision:02d}"


def main():
    if not re.fullmatch(UPSTREAM_PATTERN, UPSTREAM_VERSION):
        raise ValueError(f"invalid upstream version: {UPSTREAM_VERSION}")
    if sys.argv[1:] == ["next"]:
        print(next_version((APP_DIR / "VERSION").read_text().strip(), UPSTREAM_VERSION))
    elif len(sys.argv) == 3 and sys.argv[1] == "check":
        prefix, _ = split_version(sys.argv[2])
        if prefix != UPSTREAM_VERSION:
            raise ValueError(f"VOS version must follow upstream {UPSTREAM_VERSION}")
    else:
        raise ValueError("usage: vos_version.py next | check VERSION")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
