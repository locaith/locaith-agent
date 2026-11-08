"""Lệnh `locaith`: tìm Node.js >= 20 rồi chạy bundle lõi đi kèm gói.

Thứ tự tìm Node: biến LOCAITH_NODE → `node` của hệ thống (nếu >= 20) → Node đi kèm gói
`nodejs-wheel-binaries` (phụ thuộc của gói này, nên `pip install locaith-cli` luôn chạy được, không cần cài Node).
"""

from __future__ import annotations

import os
import re
import shutil
import signal
import subprocess
import sys
from pathlib import Path
from typing import List, Optional, Tuple

MIN_NODE_MAJOR = 20


def _bundle_path() -> Path:
    return Path(__file__).resolve().parent / "bin" / "locaith.cjs"


def _node_major(node: str) -> Optional[int]:
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.match(r"v(\d+)", (out or "").strip())
    return int(m.group(1)) if m else None


def _bundled_node() -> Optional[str]:
    """Đường dẫn node trong gói `nodejs-wheel-binaries` (nếu đã cài)."""
    try:
        import nodejs_wheel.executable as ex  # type: ignore[import-not-found]
    except ImportError:
        return None
    root = getattr(ex, "ROOT_DIR", None)
    if not root:
        return None
    exe = os.path.join(root, "node.exe") if os.name == "nt" else os.path.join(root, "bin", "node")
    return exe if os.path.isfile(exe) else None


def find_node(env: Optional[dict] = None) -> Tuple[Optional[str], str, Optional[int]]:
    """Trả (đường dẫn, nguồn, phiên bản chính). nguồn: env | system | bundled | none | old:<major>."""
    e = os.environ if env is None else env
    explicit = (e.get("LOCAITH_NODE") or "").strip()
    old_major: Optional[int] = None
    if explicit and os.path.isfile(explicit):
        major = _node_major(explicit)
        if major is None or major >= MIN_NODE_MAJOR:
            return explicit, "env", major
        old_major = major
    sysnode = shutil.which("node") or shutil.which("node.exe")
    if sysnode:
        major = _node_major(sysnode)
        if major is None or major >= MIN_NODE_MAJOR:
            return sysnode, "system", major
        old_major = major
    bundled = _bundled_node()
    if bundled:
        return bundled, "bundled", _node_major(bundled)
    return None, ("old:%d" % old_major if old_major is not None else "none"), old_major


def _missing_message(source: str, major: Optional[int]) -> str:
    if source.startswith("old:"):
        head = (
            "Locaith CLI cần Node.js %d trở lên; máy đang có bản %s.\n"
            "Locaith CLI needs Node.js %d or newer; this machine has %s.\n" % (MIN_NODE_MAJOR, major, MIN_NODE_MAJOR, major)
        )
    else:
        head = "Không tìm thấy Node.js %d+.\nNode.js %d+ was not found.\n" % (MIN_NODE_MAJOR, MIN_NODE_MAJOR)
    return head + "Cách sửa nhanh / quick fix:  python -m pip install -U nodejs-wheel-binaries   (hoặc cài Node LTS tại https://nodejs.org)\n"


def main(argv: Optional[List[str]] = None) -> int:
    """Chạy CLI. Trả mã thoát của chính CLI (0 xong, 1 lỗi, 2 sai cú pháp, 127 thiếu Node, 130 bị ngắt)."""
    args = list(sys.argv[1:] if argv is None else argv)

    node, source, major = find_node()
    if not node:
        sys.stderr.write(_missing_message(source, major))
        return 127

    bundle = _bundle_path()
    if not bundle.is_file():
        sys.stderr.write("Gói cài đặt thiếu tệp lõi %s — cài lại: pip install --force-reinstall locaith-cli\n" % bundle)
        return 1

    from . import __version__

    env = dict(os.environ)
    env.setdefault("LOCAITH_LAUNCHER", "python %s" % __version__)
    env["LOCAITH_PYTHON"] = sys.executable or ""
    env["LOCAITH_NODE_SOURCE"] = "bundled" if source == "bundled" else "system"
    if env.get("LOCAITH_LAUNCHER_DEBUG") == "1":
        sys.stderr.write("[locaith-launcher] node=%s (%s) bundle=%s\n" % (node, source, bundle))

    # Ctrl+C được gửi tới CẢ nhóm tiến trình: để một mình Node xử lý (đóng terminal sạch, thoát đúng mã), Python không ném KeyboardInterrupt.
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    try:
        # Truyền nguyên tham số, không qua shell: token/đường dẫn có dấu cách vẫn an toàn.
        code = subprocess.call([node, os.fspath(bundle), *args], env=env)
    except OSError as exc:
        sys.stderr.write("Không chạy được Node: %s\n" % exc)
        return 1
    finally:
        signal.signal(signal.SIGINT, previous)
    # POSIX: tiến trình con bị tín hiệu giết trả mã âm → đổi sang quy ước 128+n của shell.
    return 128 - code if code < 0 else code
