"""Kiểm bộ khởi chạy: chọn Node đúng thứ tự, thông điệp thiếu Node, mã thoát. Chạy: python -m unittest discover -s tests"""

import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from locaith_cli import cli  # noqa: E402


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

            def fake_call(cmd, env=None):
                seen["cmd"], seen["env"] = cmd, env
                return 7

            with mock.patch.object(cli, "find_node", return_value=("/n/node", "bundled", 24)), mock.patch.object(
                cli, "_bundle_path", return_value=bundle
            ), mock.patch.object(cli.subprocess, "call", side_effect=fake_call):
                code = cli.main(["-p", "xin chào", "--model", "a b"])
        self.assertEqual(code, 7)
        self.assertEqual(seen["cmd"], ["/n/node", str(bundle), "-p", "xin chào", "--model", "a b"])
        self.assertEqual(seen["env"]["LOCAITH_NODE_SOURCE"], "bundled")
        self.assertTrue(seen["env"]["LOCAITH_LAUNCHER"].startswith("python "))
        self.assertEqual(seen["env"]["LOCAITH_PYTHON"], sys.executable)

    def test_sigint_restored_and_negative_code_mapped(self):
        with tempfile.TemporaryDirectory() as d:
            bundle = Path(d) / "locaith.cjs"
            bundle.write_text("//", encoding="utf8")
            before = signal.getsignal(signal.SIGINT)
            with mock.patch.object(cli, "find_node", return_value=("/n/node", "system", 22)), mock.patch.object(
                cli, "_bundle_path", return_value=bundle
            ), mock.patch.object(cli.subprocess, "call", return_value=-2):
                code = cli.main([])
            self.assertEqual(signal.getsignal(signal.SIGINT), before)
        self.assertEqual(code, 130)


if __name__ == "__main__":
    unittest.main()
