"""Kiểm bộ khởi chạy: chọn Node đúng thứ tự, cảnh báo LOCAITH_NODE sai, thông điệp thiếu Node, mã thoát,
exec trên POSIX và Job Object trên Windows. Chạy: python -m unittest discover -s tests"""

import io
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from locaith_cli import cli  # noqa: E402


class _Captured:
    """Bắt stderr của launcher."""

    def __enter__(self):
        self.buf = io.StringIO()
        self._p = mock.patch.object(sys, "stderr", new=self.buf)
        self._p.start()
        return self

    def __exit__(self, *a):
        self._p.stop()

    @property
    def text(self) -> str:
        return self.buf.getvalue()


class FindNodeTests(unittest.TestCase):
    def test_env_override_wins(self):
        with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as f:
            path = f.name
        try:
            with mock.patch.object(cli, "_node_major", return_value=22):
                node, source, major = cli.find_node({"LOCAITH_NODE": path})
            self.assertEqual((node, source, major), (path, "env", 22))
        finally:
            os.unlink(path)

    def test_system_node_when_new_enough(self):
        with mock.patch.object(cli.shutil, "which", return_value="/usr/bin/node"), mock.patch.object(cli, "_node_major", return_value=20):
            node, source, _ = cli.find_node({})
        self.assertEqual((node, source), ("/usr/bin/node", "system"))

    def test_old_system_node_falls_back_to_bundled(self):
        with mock.patch.object(cli.shutil, "which", return_value="/usr/bin/node"), mock.patch.object(
            cli, "_node_major", side_effect=lambda n: 18 if n == "/usr/bin/node" else 24
        ), mock.patch.object(cli, "_bundled_node", return_value="/site/nodejs_wheel/bin/node"):
            node, source, major = cli.find_node({})
        self.assertEqual((node, source, major), ("/site/nodejs_wheel/bin/node", "bundled", 24))

    def test_nothing_found(self):
        with mock.patch.object(cli.shutil, "which", return_value=None), mock.patch.object(cli, "_bundled_node", return_value=None):
            self.assertEqual(cli.find_node({}), (None, "none", None))

    def test_old_node_only_reports_version(self):
        with mock.patch.object(cli.shutil, "which", return_value="/usr/bin/node"), mock.patch.object(cli, "_node_major", return_value=16), mock.patch.object(
            cli, "_bundled_node", return_value=None
        ):
            node, source, major = cli.find_node({})
        self.assertIsNone(node)
        self.assertEqual((source, major), ("old:16", 16))
        self.assertIn("16", cli._missing_message(source, major))
        self.assertIn("nodejs-wheel-binaries", cli._missing_message(source, major))

    # ── (0.4.4) LOCAITH_NODE đặt sai phải được báo, Node không chạy được không được nhận ──

    def test_env_missing_file_warns_then_uses_system(self):
        missing = os.path.join(tempfile.gettempdir(), "khong", "co", "node.exe")
        with _Captured() as cap, mock.patch.object(cli.shutil, "which", return_value="/usr/bin/node"), mock.patch.object(cli, "_node_major", return_value=22):
            node, source, _ = cli.find_node({"LOCAITH_NODE": missing})
        self.assertEqual((node, source), ("/usr/bin/node", "system"))
        self.assertIn("LOCAITH_NODE=" + missing, cap.text)
        self.assertIn("không phải một tệp", cap.text)

    def test_env_node_that_cannot_run_is_rejected_with_warning(self):
        with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as f:
            path = f.name
        try:
            with _Captured() as cap, mock.patch.object(cli, "_node_major", side_effect=lambda n: None if n == path else 24), mock.patch.object(
                cli.shutil, "which", return_value=None
            ), mock.patch.object(cli, "_bundled_node", return_value="/site/nodejs_wheel/bin/node"):
                node, source, _ = cli.find_node({"LOCAITH_NODE": path})
            self.assertEqual((node, source), ("/site/nodejs_wheel/bin/node", "bundled"))
            self.assertIn("--version", cap.text)
        finally:
            os.unlink(path)

    def test_env_node_too_old_warns_and_falls_back(self):
        with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as f:
            path = f.name
        try:
            with _Captured() as cap, mock.patch.object(cli, "_node_major", side_effect=lambda n: 16 if n == path else 22), mock.patch.object(
                cli.shutil, "which", return_value="/usr/bin/node"
            ):
                node, source, _ = cli.find_node({"LOCAITH_NODE": path})
            self.assertEqual((node, source), ("/usr/bin/node", "system"))
            self.assertIn("Node 16", cap.text)
        finally:
            os.unlink(path)

    def test_system_node_that_cannot_run_version_is_not_accepted(self):
        # Trước đây `major is None` vẫn được nhận → một Node hỏng được chọn rồi mới nổ lúc chạy lõi.
        with mock.patch.object(cli.shutil, "which", return_value="/usr/bin/node"), mock.patch.object(
            cli, "_node_major", side_effect=lambda n: None if n == "/usr/bin/node" else 24
        ), mock.patch.object(cli, "_bundled_node", return_value="/site/nodejs_wheel/bin/node"):
            node, source, _ = cli.find_node({})
        self.assertEqual((node, source), ("/site/nodejs_wheel/bin/node", "bundled"))



class Utf8StderrTests(unittest.TestCase):
    """(0.4.4) stderr bị chuyển hướng trên Windows là bảng mã ANSI: «không phải một tệp» ra thành chuỗi thoát. Launcher phải ghi UTF-8 như lõi Node."""

    def test_redirected_ansi_stderr_is_switched_to_utf8(self):
        raw = io.BytesIO()
        fake = io.TextIOWrapper(raw, encoding="cp1252", errors="backslashreplace", newline="\n", write_through=True)  # newline="\n": không đổi \n thành \r\n trên Windows
        with mock.patch.object(sys, "stderr", new=fake):
            cli._utf8_stderr()
            cli._warn("không phải một tệp")
        self.assertEqual(raw.getvalue().decode("utf-8"), "[locaith] không phải một tệp\n")

    def test_stream_without_reconfigure_is_left_alone(self):
        with mock.patch.object(sys, "stderr", new=io.StringIO()) as buf:
            cli._utf8_stderr()  # StringIO không có reconfigure: không được ném lỗi
            cli._warn("ok")
        self.assertEqual(buf.getvalue(), "[locaith] ok\n")


class MainTests(unittest.TestCase):
    def test_missing_node_exit_127(self):
        with mock.patch.object(cli, "find_node", return_value=(None, "none", None)), mock.patch.object(sys, "stderr", new=mock.MagicMock()):
            self.assertEqual(cli.main(["--version"]), 127)

    def test_missing_bundle_exit_1(self):
        with mock.patch.object(cli, "find_node", return_value=("/n/node", "system", 22)), mock.patch.object(
            cli, "_bundle_path", return_value=Path("/nope/locaith.cjs")
        ), mock.patch.object(sys, "stderr", new=mock.MagicMock()):
            self.assertEqual(cli.main([]), 1)

    def test_passes_args_env_and_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            bundle = Path(d) / "locaith.cjs"
            bundle.write_text("//", encoding="utf8")
            seen = {}

            def fake_run(argv, env):
                seen["cmd"], seen["env"] = argv, env
                return 7

            with mock.patch.object(cli, "find_node", return_value=("/n/node", "bundled", 24)), mock.patch.object(
                cli, "_bundle_path", return_value=bundle
            ), mock.patch.object(cli, "_run_node", side_effect=fake_run):
                code = cli.main(["-p", "xin chào", "--model", "a b"])
        self.assertEqual(code, 7)
        self.assertEqual(seen["cmd"], ["/n/node", str(bundle), "-p", "xin chào", "--model", "a b"])
        self.assertEqual(seen["env"]["LOCAITH_NODE_SOURCE"], "bundled")
        self.assertTrue(seen["env"]["LOCAITH_LAUNCHER"].startswith("python "))
        self.assertEqual(seen["env"]["LOCAITH_PYTHON"], sys.executable)


class RunNodeTests(unittest.TestCase):
    class _Replaced(Exception):
        """os.execve thật không bao giờ trả về; test mô phỏng bằng một ngoại lệ."""

    def test_posix_replaces_the_process_with_exec(self):
        env = {"A": "1"}
        with mock.patch.object(cli, "_is_windows", return_value=False), mock.patch.object(cli.os, "execve", side_effect=self._Replaced) as ex, mock.patch.object(
            cli, "_run_child"
        ) as child:
            with self.assertRaises(self._Replaced):
                cli._run_node(["/n/node", "/b/locaith.cjs", "-p", "x"], env)
        ex.assert_called_once_with("/n/node", ["/n/node", "/b/locaith.cjs", "-p", "x"], env)
        child.assert_not_called()

    def test_posix_exec_failure_reports_and_exits_1(self):
        with _Captured() as cap, mock.patch.object(cli, "_is_windows", return_value=False), mock.patch.object(cli.os, "execve", side_effect=OSError("không có")):
            code = cli._run_node(["/n/node", "/b/locaith.cjs"], {})
        self.assertEqual(code, 1)
        self.assertIn("Không chạy được Node", cap.text)

    def test_no_exec_escape_hatch_runs_a_child_instead(self):
        with mock.patch.object(cli, "_is_windows", return_value=False), mock.patch.object(cli.os, "execve") as ex, mock.patch.object(
            cli, "_run_child", return_value=0
        ) as child:
            self.assertEqual(cli._run_node(["/n/node", "/b/locaith.cjs"], {"LOCAITH_NO_EXEC": "1"}), 0)
        ex.assert_not_called()
        child.assert_called_once()

    def test_windows_runs_a_child(self):
        with mock.patch.object(cli, "_is_windows", return_value=True), mock.patch.object(cli.os, "execve") as ex, mock.patch.object(
            cli, "_run_child", return_value=3
        ) as child:
            self.assertEqual(cli._run_node(["n", "b"], {}), 3)
        ex.assert_not_called()
        child.assert_called_once_with(["n", "b"], {})


class RunChildTests(unittest.TestCase):
    @staticmethod
    def _proc(code=0, pid=4242):
        p = mock.MagicMock()
        p.pid = pid
        p.wait.return_value = code
        return p

    def test_sigint_restored_and_negative_code_mapped(self):
        before = signal.getsignal(signal.SIGINT)
        with mock.patch.object(cli, "_is_windows", return_value=False), mock.patch.object(cli.subprocess, "Popen", return_value=self._proc(-2)):
            code = cli._run_child(["n", "b"], {})
        self.assertEqual(signal.getsignal(signal.SIGINT), before)
        self.assertEqual(code, 130)

    def test_windows_child_joins_the_job_and_the_flag_is_dropped_on_a_normal_exit(self):
        guard = mock.MagicMock()
        with mock.patch.object(cli, "_is_windows", return_value=True), mock.patch.object(cli._JobGuard, "create", return_value=guard), mock.patch.object(
            cli.subprocess, "Popen", return_value=self._proc(0, pid=777)
        ):
            self.assertEqual(cli._run_child(["n", "b"], {}), 0)
        guard.adopt.assert_called_once_with(777)
        guard.release.assert_called_once_with(disarm=True)

    def test_windows_unexpected_error_while_waiting_keeps_the_kill_flag(self):
        guard = mock.MagicMock()
        proc = self._proc()
        proc.wait.side_effect = RuntimeError("bất ngờ")
        with mock.patch.object(cli, "_is_windows", return_value=True), mock.patch.object(cli._JobGuard, "create", return_value=guard), mock.patch.object(
            cli.subprocess, "Popen", return_value=proc
        ):
            with self.assertRaises(RuntimeError):
                cli._run_child(["n", "b"], {})
        guard.release.assert_called_once_with(disarm=False)

    def test_windows_without_a_job_still_runs(self):
        with mock.patch.object(cli, "_is_windows", return_value=True), mock.patch.object(cli._JobGuard, "create", return_value=None), mock.patch.object(
            cli.subprocess, "Popen", return_value=self._proc(5)
        ):
            self.assertEqual(cli._run_child(["n", "b"], {}), 5)

    def test_node_that_cannot_start_returns_1_and_does_not_kill_anything(self):
        guard = mock.MagicMock()
        with _Captured() as cap, mock.patch.object(cli, "_is_windows", return_value=True), mock.patch.object(
            cli._JobGuard, "create", return_value=guard
        ), mock.patch.object(cli.subprocess, "Popen", side_effect=OSError("hỏng")):
            self.assertEqual(cli._run_child(["n", "b"], {}), 1)
        self.assertIn("Không chạy được Node", cap.text)
        guard.release.assert_called_once_with(disarm=True)


@unittest.skipUnless(os.name == "nt", "Job Object chỉ có trên Windows")
class JobGuardWindowsTests(unittest.TestCase):
    """Job Object THẬT: tiến trình con chết khi launcher chết, và sống tiếp khi launcher thoát bình thường."""

    PY = getattr(sys, "_base_executable", sys.executable)  # bản thật, không phải trình chuyển tiếp của venv (nó sẽ sinh thêm tiến trình con ngoài job)

    def _sleeper(self):
        return subprocess.Popen([self.PY, "-c", "import time; time.sleep(60)"])

    def test_child_is_killed_when_the_job_handle_closes(self):
        guard = cli._JobGuard.create()
        self.assertIsNotNone(guard)
        p = self._sleeper()
        try:
            self.assertTrue(guard.adopt(p.pid))
            guard.release(disarm=False)  # như launcher bị giết: handle đóng, cờ còn nguyên
            self.assertIsNotNone(self._wait(p, 10), "Node mồ côi: tiến trình con còn sống sau khi job đóng")
        finally:
            p.kill()
            p.wait()

    def test_child_survives_when_the_launcher_exits_normally(self):
        guard = cli._JobGuard.create()
        p = self._sleeper()
        try:
            self.assertTrue(guard.adopt(p.pid))
            guard.release(disarm=True)  # thoát bình thường: bỏ cờ trước khi đóng
            time.sleep(1.0)
            self.assertIsNone(p.poll(), "thoát bình thường mà vẫn giết tiến trình con")
        finally:
            p.kill()
            p.wait()

    @staticmethod
    def _wait(p, seconds):
        try:
            return p.wait(timeout=seconds)
        except subprocess.TimeoutExpired:
            return None


if __name__ == "__main__":
    unittest.main()
