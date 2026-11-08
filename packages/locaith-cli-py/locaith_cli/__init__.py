"""Cầu nối Python → lõi Node của Locaith CLI.

Gói này KHÔNG chứa bản sao thứ hai của CLI: nó đóng gói đúng một tệp `locaith.cjs` (bundle do esbuild sinh từ
mã nguồn extension, dùng CHUNG một lõi với extension VS Code) và gọi bằng Node (của hệ thống hoặc Node đi kèm
gói `nodejs-wheel-binaries`). Nhờ vậy `pip install locaith-cli` cho ra lệnh `locaith` đầy đủ, không cần cài thêm gì.
"""

from .cli import main

__all__ = ["main"]
__version__ = "0.4.5"
