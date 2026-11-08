"""Lệnh `locaith`: tìm Node.js >= 20 rồi chạy bundle lõi đi kèm gói.

Thứ tự tìm Node: biến LOCAITH_NODE → `node` của hệ thống (nếu >= 20) → Node đi kèm gói
`nodejs-wheel-binaries` (phụ thuộc của gói này, nên `pip install locaith-cli` luôn chạy được, không cần cài Node).

Chạy lõi:
  - POSIX: thay hẳn tiến trình Python bằng Node (`os.execve`) — không còn hai tiến trình, Ctrl+C / SIGTERM / SIGHUP và mã thoát
    do chính Node xử lý, không có tiến trình mồ côi. (Đặt `LOCAITH_NO_EXEC=1` để quay về cách cũ: chạy con rồi đợi.)
  - Windows: không có exec thật → chạy Node như tiến trình con nhưng nằm trong một Job Object có cờ KILL_ON_JOB_CLOSE: launcher bị giết
    (taskkill /F, IDE bấm Stop, CI hết giờ) thì hệ điều hành giết luôn Node và các tiến trình nó đã sinh ra.
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


def _warn(msg: str) -> None:
    sys.stderr.write("[locaith] %s\n" % msg)


def _utf8_stderr() -> None:
    """Ghi stderr bằng UTF-8 ngay cả khi bị chuyển hướng (ống, tệp, CI): trên Windows nó mặc định là bảng mã ANSI nên chữ có dấu bị thoát thành mã số; lõi Node luôn ghi UTF-8."""
    try:
        enc = (getattr(sys.stderr, "encoding", "") or "").lower().replace("-", "")
        if enc != "utf8":
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - không phải luồng văn bản có reconfigure (kiểm thử, bị thay thế): bỏ qua
        pass


def _is_windows() -> bool:
    return os.name == "nt"


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
    """Trả (đường dẫn, nguồn, phiên bản chính). nguồn: env | system | bundled | none | old:<major>.

    Chỉ nhận một Node đã chạy được `--version` và >= MIN_NODE_MAJOR (Node hỏng không còn bị nhận nhầm). `LOCAITH_NODE` đặt sai thì CẢNH BÁO ra stderr
    rồi dùng Node khác — không bỏ qua im lặng.
    """
    e = os.environ if env is None else env
    explicit = (e.get("LOCAITH_NODE") or "").strip()
    old_major: Optional[int] = None
    if explicit:
        if not os.path.isfile(explicit):
            _warn("LOCAITH_NODE=%s không phải một tệp (is not a file) — bỏ qua / ignored, dùng Node khác / using another Node." % explicit)
        else:
            major = _node_major(explicit)
            if major is not None and major >= MIN_NODE_MAJOR:
                return explicit, "env", major
            if major is None:
                _warn("LOCAITH_NODE=%s không chạy được `--version` (cannot run `--version`) — bỏ qua / ignored." % explicit)
            else:
                _warn("LOCAITH_NODE=%s là Node %d (< %d) — bỏ qua / ignored." % (explicit, major, MIN_NODE_MAJOR))
                old_major = major
    sysnode = shutil.which("node") or shutil.which("node.exe")
    if sysnode:
        major = _node_major(sysnode)
        if major is not None and major >= MIN_NODE_MAJOR:
            return sysnode, "system", major
        if major is not None:
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


# ── Windows: Node chết theo launcher ────────────────────────────────────────────────────────────────────────────────────

class _JobGuard:
    """Job Object có cờ KILL_ON_JOB_CLOSE. Tiến trình con thuộc job bị hệ điều hành giết khi launcher chết (đóng terminal, `taskkill /F`, CI hết giờ):
    nếu không, Node mồ côi và chạy tiếp — một phiên agent có thể tiếp tục sửa tệp mà không ai quản.

    Thoát BÌNH THƯỜNG thì `release(disarm=True)` bỏ cờ trước khi đóng handle, nên không ai bị giết thêm so với trước đây.
    Không bao giờ ném lỗi: không tạo được job thì chỉ mất tính năng dọn dẹp này.
    """

    _KILL_ON_JOB_CLOSE = 0x2000
    _EXTENDED_LIMIT_INFORMATION = 9
    _PROCESS_RIGHTS = 0x0100 | 0x0001  # PROCESS_SET_QUOTA | PROCESS_TERMINATE

    def __init__(self, k32: object, job: object, extended: type) -> None:
        self._k32 = k32
        self._job = job
        self._extended = extended

    @classmethod
    def create(cls) -> "Optional[_JobGuard]":
        try:
            import ctypes
            from ctypes import wintypes

            k32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]

            class IO_COUNTERS(ctypes.Structure):
                _fields_ = [
                    (n, ctypes.c_ulonglong)
                    for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")
                ]

            class BASIC(ctypes.Structure):
                _fields_ = [
                    ("PerProcessUserTimeLimit", ctypes.c_longlong),
                    ("PerJobUserTimeLimit", ctypes.c_longlong),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD),
                ]

            class EXTENDED(ctypes.Structure):
                _fields_ = [
                    ("BasicLimitInformation", BASIC),
                    ("IoInfo", IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t),
                ]

            k32.CreateJobObjectW.restype = wintypes.HANDLE
            k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
            k32.SetInformationJobObject.restype = wintypes.BOOL
            k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
            k32.OpenProcess.restype = wintypes.HANDLE
            k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            k32.AssignProcessToJobObject.restype = wintypes.BOOL
            k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
            k32.CloseHandle.restype = wintypes.BOOL
            k32.CloseHandle.argtypes = [wintypes.HANDLE]

            job = k32.CreateJobObjectW(None, None)
            if not job:
                return None
            info = EXTENDED()
            info.BasicLimitInformation.LimitFlags = cls._KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(job, cls._EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info)):
                k32.CloseHandle(job)
                return None
            return cls(k32, job, EXTENDED)
        except Exception:  # noqa: BLE001 - tính năng phụ, không được làm hỏng lệnh chính
            return None

    def adopt(self, pid: int) -> bool:
        """Đưa tiến trình `pid` (và mọi tiến trình nó sinh ra sau đó) vào job."""
        try:
            k32 = self._k32
            handle = k32.OpenProcess(self._PROCESS_RIGHTS, False, int(pid))  # type: ignore[attr-defined]
            if not handle:
                return False
            try:
                return bool(k32.AssignProcessToJobObject(self._job, handle))  # type: ignore[attr-defined]
            finally:
                k32.CloseHandle(handle)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            return False

    def release(self, disarm: bool) -> None:
        """Đóng job. `disarm=True` (launcher thoát bình thường): bỏ cờ KILL_ON_JOB_CLOSE trước, để tiến trình còn sót (nếu có) sống tiếp như trước nay.
        `disarm=False` (launcher gặp lỗi bất ngờ khi đang đợi): giữ cờ — đóng handle sẽ giết Node và các con của nó."""
        try:
            import ctypes

            k32 = self._k32
            if disarm:
                info = self._extended()
                info.BasicLimitInformation.LimitFlags = 0  # type: ignore[attr-defined]
                k32.SetInformationJobObject(self._job, self._EXTENDED_LIMIT_INFORMATION, ctypes.byref(info), ctypes.sizeof(info))  # type: ignore[attr-defined]
            k32.CloseHandle(self._job)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass


def _run_child(argv_child: List[str], env: dict) -> int:
    """Chạy Node như tiến trình con rồi đợi (Windows, hoặc POSIX khi LOCAITH_NO_EXEC=1). Trả mã thoát."""
    # Ctrl+C được gửi tới CẢ nhóm tiến trình: để một mình Node xử lý (đóng terminal sạch, thoát đúng mã), Python không ném KeyboardInterrupt.
    previous = signal.signal(signal.SIGINT, signal.SIG_IGN)
    guard = _JobGuard.create() if _is_windows() else None
    finished = False
    try:
        # Truyền nguyên tham số, không qua shell: token/đường dẫn có dấu cách vẫn an toàn.
        proc = subprocess.Popen(argv_child, env=env)
        if guard is not None:
            guard.adopt(proc.pid)
        code = proc.wait()
        finished = True
    except OSError as exc:
        sys.stderr.write("Không chạy được Node: %s\n" % exc)
        finished = True  # Node không chạy được thì không có gì để giết
        return 1
    finally:
        signal.signal(signal.SIGINT, previous)
        if guard is not None:
            guard.release(disarm=finished)
    # POSIX: tiến trình con bị tín hiệu giết trả mã âm → đổi sang quy ước 128+n của shell.
    return 128 - code if code < 0 else code


def _run_node(argv_child: List[str], env: dict) -> int:
    """POSIX: thay hẳn tiến trình bằng Node (không trả về nếu thành công). Windows (hoặc LOCAITH_NO_EXEC=1): chạy con trong Job Object rồi đợi."""
    if not _is_windows() and env.get("LOCAITH_NO_EXEC") != "1":
        try:
            sys.stdout.flush()
            sys.stderr.flush()
            os.execve(argv_child[0], argv_child, env)
        except OSError as exc:
            sys.stderr.write("Không chạy được Node: %s\n" % exc)
            return 1
    return _run_child(argv_child, env)


def main(argv: Optional[List[str]] = None) -> int:
    """Chạy CLI. Trả mã thoát của chính CLI (0 xong, 1 lỗi, 2 sai cú pháp, 127 thiếu Node, 130 bị ngắt)."""
    args = list(sys.argv[1:] if argv is None else argv)
    _utf8_stderr()

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

    return _run_node([node, os.fspath(bundle), *args], env)
