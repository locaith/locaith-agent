"""Lệnh `locaith`: tìm Node.js trên máy rồi chạy bundle lõi đi kèm gói."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

MIN_NODE_MAJOR = 20


def _bundle_path() -> Path:
    return Path(__file__).resolve().parent / "bin" / "locaith.cjs"


def _node_major(node: str) -> int | None:
    try:
        out = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=10
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"v(\d+)", (out or "").strip())
    return int(m.group(1)) if m else None


def main(argv: list[str] | None = None) -> int:
    """Chạy CLI. Trả mã thoát của chính CLI (0 xong, 1 lỗi, 2 sai cú pháp)."""
    args = list(sys.argv[1:] if argv is None else argv)

    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        sys.stderr.write(
            "Locaith CLI cần Node.js 20 trở lên nhưng không tìm thấy `node`.\n"
            "Cài tại https://nodejs.org (bản LTS) rồi chạy lại.\n"
        )
        return 127

    major = _node_major(node)
    if major is not None and major < MIN_NODE_MAJOR:
        sys.stderr.write(
            "Locaith CLI cần Node.js %d trở lên; máy đang có bản %d.\n"
            "Nâng cấp tại https://nodejs.org rồi chạy lại.\n" % (MIN_NODE_MAJOR, major)
        )
        return 127

    bundle = _bundle_path()
    if not bundle.is_file():
        sys.stderr.write(
            "Gói cài đặt thiếu tệp lõi %s — cài lại: pip install --force-reinstall locaith-cli\n"
            % bundle
        )
        return 1

    try:
        # Truyền nguyên tham số, không qua shell: token/đường dẫn có dấu cách vẫn an toàn.
        return subprocess.call([node, os.fspath(bundle), *args])
    except KeyboardInterrupt:
        return 130
    except OSError as exc:
        sys.stderr.write("Không chạy được Node: %s\n" % exc)
        return 1
