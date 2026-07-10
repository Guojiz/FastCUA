"""Create the no-display-overlay build from the original host binary.

The cursor and display HWNDs are intentionally still initialized.  The only
patched operation is ShowWindow(display, SW_SHOWNOACTIVATE); keeping the rest
of the overlay state machine intact avoids changing cursor, capture, resize,
and shutdown behavior.
"""

from __future__ import annotations

import argparse
import hashlib
import pathlib


ORIGINAL_SHA256 = "f2b2f56fcd1699b0fa32dec3214a56a1d36b937a2ecf58cc822ab4a904551e03"
PATCH_VA = 0x14008B81B
PATCH_FILE_OFFSET = 0x8AC1B
EXPECTED = bytes.fromhex("ff d3")  # call rbx (rbx = user32!ShowWindow)
REPLACEMENT = bytes.fromhex("90 90")


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", nargs="?", default="cua-native-host.exe")
    parser.add_argument("output", nargs="?", default="cua-native-host-no-display.exe")
    args = parser.parse_args()
    source = pathlib.Path(args.source)
    output = pathlib.Path(args.output)

    source_hash = sha256(source)
    if source_hash != ORIGINAL_SHA256:
        raise SystemExit(
            f"refusing to patch unknown binary: SHA-256 {source_hash}; "
            f"expected {ORIGINAL_SHA256}"
        )
    image = bytearray(source.read_bytes())
    file_offset = PATCH_FILE_OFFSET
    actual = bytes(image[file_offset : file_offset + len(EXPECTED)])
    if actual != EXPECTED:
        raise SystemExit(
            f"patch site mismatch at file+0x{file_offset:x}: "
            f"found {actual.hex(' ')}, expected {EXPECTED.hex(' ')}"
        )
    image[file_offset : file_offset + len(REPLACEMENT)] = REPLACEMENT
    output.write_bytes(image)
    print(f"source  sha256={source_hash}")
    print(f"patch   VA=0x{PATCH_VA:x} file+0x{file_offset:x} {EXPECTED.hex()} -> {REPLACEMENT.hex()}")
    print(f"output  {output} sha256={sha256(output)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
