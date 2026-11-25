# Cài Bio-Memory: ghim theo commit, không theo nhánh

**Lỗi.** Nút cài (và «cập nhật») Bio-Memory chạy `pip install "bio-agent-os[mcp] @ https://github.com/locaith/bio-memory-ai-locaith/archive/refs/heads/main.zip"`.
Từ 22/11/2026 lúc 10:46 nhánh `main` của kho công khai chỉ còn `README.md` và `LICENSE.md` (Bio-Memory 0.11 phát hành dạng biên dịch),
nên tệp zip đó không còn `pyproject.toml` và pip từ chối. Ai cài mới hoặc bấm cập nhật từ hôm đó đều gặp «Cài đặt thất bại».
Máy đã cài từ trước vẫn chạy, vì môi trường Python cũ còn nguyên.

Kiểm ngày 25/11/2026 qua API công khai của GitHub: `contents/pyproject.toml?ref=main` trả 404; cùng đường dẫn với
`ref=918682538c65530951171ddbff991fcf9848de0d` trả tệp 2.859 byte. Chưa chạy pip thật trên máy sạch.

**Vá.** `BIO_ZIP_URL` trỏ vào đúng commit là đầu nhánh `main` ngay trước ngày 22/11 (`BIO_PINNED_COMMIT`, bio-agent-os 0.8.2rc1, có extra `mcp`):
cùng mã mà các bản cài cũ vẫn tải, nên công cụ MCP và dữ liệu không đổi. Một nhánh hay một thẻ dời được; một commit thì không.

**Chốt chặn.** `test/bio.test.ts`: địa chỉ phải là `archive/<40 ký tự hex>.zip` và không chứa `refs/heads/` hay `refs/tags/`.

**Chưa làm.** Chuyển extension sang Bio-Memory 0.11 (chương trình biên dịch, bộ công cụ `remember`/`recall`…, kho dùng chung với Locaith Work):
là thay đổi lớn hơn, có kế hoạch riêng.

---

# Bio-Memory install: pinned to a commit, not a branch

**Bug.** Install (and "update") ran `pip install` on the zip of the public repository's `main` branch. Since 22 Nov 2026 that branch holds
only `README.md` and `LICENSE.md` (Bio-Memory 0.11 ships compiled), so the zip has no `pyproject.toml` and pip refuses it: every new
install or update fails. Machines that installed earlier keep working.

**Fix.** `BIO_ZIP_URL` points at the commit that was the head of `main` just before that day (`BIO_PINNED_COMMIT`, bio-agent-os 0.8.2rc1 with
the `mcp` extra): the same code earlier installs downloaded. A branch or a tag can move; a commit cannot.

**Guard.** `test/bio.test.ts` requires `archive/<40 hex>.zip` and refuses `refs/heads/` and `refs/tags/`.
