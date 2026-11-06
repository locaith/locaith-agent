"""Cầu nối Python → lõi Node của Locaith CLI.

Gói này KHÔNG chứa bản sao thứ hai của CLI: nó đóng gói đúng một tệp `locaith.cjs` (bundle do
esbuild sinh từ mã nguồn extension, dùng chung một lõi) và gọi bằng `node` có sẵn trên máy.
Nhờ vậy `pip install locaith-cli` cho ra lệnh `locaith` giống hệt bản npm.
"""

from .cli import main

__all__ = ["main"]
__version__ = "0.1.0"
