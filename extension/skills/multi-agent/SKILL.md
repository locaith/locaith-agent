---
name: multi-agent
description: Điều phối nhiều agent con song song (đa agent, workflow) cho việc lớn — điều tra nhiều giả thuyết, rà soát hàng loạt tệp, nghiên cứu nhiều nguồn, kiểm chứng chéo; kết quả trung gian không nhồi vào ngữ cảnh chính. Nạp khi việc có thể chia thành nhiều phần độc lập hoặc cần phản biện độc lập.
tags: [agent, subagent, workflow, song song, đa agent, điều phối, orchestration, parallel, phản biện, rà soát hàng loạt]
unlocks: [workflow_run]
---

# Điều phối agent con

Bạn có hai công cụ. Chọn đúng cái nhỏ nhất đủ dùng.

## `agent` — một (hoặc vài) agent con

- Mỗi agent chạy trong phiên MỚI: ngữ cảnh riêng, công cụ riêng, chỉ thấy đúng `prompt` bạn đưa. Nó trả về MỘT báo cáo cuối; các bước trung gian không vào hội thoại của bạn.
- Gọi **nhiều `agent` trong cùng một lượt** thì chúng chạy song song. Dùng khi các phần độc lập nhau (tìm ở 3 thư mục khác nhau, tra 3 nguồn khác nhau…).
- `prompt` phải TRỌN GÓI: mục tiêu, nơi cần tìm, định dạng muốn nhận lại (ví dụ "trả về danh sách `đường dẫn:dòng — lý do`, tối đa 15 mục"). Agent con không đoán được ngữ cảnh của bạn.
- Chọn loại: `explore` (do thám nhanh, rẻ), `researcher` (web, đối chiếu nguồn), `plan` (kế hoạch), `reviewer` (phản biện độc lập), `general` (làm việc có ghi tệp/chạy lệnh — vẫn xin phép người dùng).
- Đừng giao việc bạn làm xong được trong 1–2 lệnh. Đừng giao việc mà kết quả của nó là đầu vào ngay cho bước kế tiếp của bạn nếu bạn phải đọc lại toàn bộ.

## `workflow_run` — chương trình điều phối hàng loạt

Dùng khi có **nhiều hơn ~5 việc độc lập** hoặc cần nhiều pha (điều tra → thử bác bỏ → phán quyết). Bạn viết thân hàm async JavaScript; kết quả trung gian nằm trong biến script, chỉ giá trị `return` quay về hội thoại — nên hãy `return` một đối tượng GỌN (kết luận, số liệu, tham chiếu `ref`).

```js
phase("Trace");
const traces = await pipeline(args.hypotheses, (h) =>
  agent(`Điều tra giả thuyết, trả về JSON {finding, evidence[]}: ${h}`, { agent: "explore", json: true, label: h.slice(0, 30) }));
phase("Experiment");
const checks = await pipeline(traces.filter((t) => t.ok), (t) =>
  agent(`Thử bác bỏ kết luận này bằng bằng chứng độc lập:\n${JSON.stringify(t.data)}`, { agent: "reviewer", json: true }));
phase("Adjudicate");
const verdict = await agent(`Cân nhắc toàn bộ bằng chứng, kết luận giả thuyết nào đúng:\n${JSON.stringify(checks.map((c) => c.data))}`, { tier: "top", json: true });
return verdict.data;
```

Quy tắc:
- API trong script: `agent`, `parallel`, `pipeline`, `store`, `phase`, `log`, `args`. Không có `require`, `process`, `fetch`, `eval`.
- `agent(...)` trả `{ ok, text, data?, tokens, model, ref }`. Luôn kiểm `ok` trước khi dùng `text`/`data`; với `json: true` thì dùng `data`.
- Hạng model (`tier`): `top` cho lập kế hoạch/phán quyết, `balanced` mặc định, `fast` cho do thám rẻ. Chỉ có tác dụng khi người dùng bật chế độ điều phối nhiều AI; nếu không, mọi agent dùng model của bạn.
- Mặc định rộng: tới 1.000 agent mỗi lần chạy, 16 chạy cùng lúc (còn lại xếp hàng), KHÔNG có ngân sách token. Chỉ đặt `max_tokens` khi người dùng yêu cầu một ngân sách; `max_agents`/`timeout_minutes` đặt khi bạn biết số lượng. Bắt đầu nhỏ (thử trên 2–3 phần tử) trước khi chạy hàng loạt.
- Chạm giới hạn do bạn đặt thì `agent()` KHÔNG ném lỗi mà trả `{ ok: false, skipped: 'agents'|'tokens', error }` — script vẫn chạy tiếp: dùng kết quả đã có, đừng coi `text` rỗng là câu trả lời. Nếu workflow chết giữa chừng, báo cáo các agent đã xong được cứu vào scratchpad: đọc lại chúng thay vì chạy lại từ đầu.
- Agent con mặc định CHỈ ĐỌC. Muốn sửa tệp thì làm ở luồng chính sau khi workflow trả kết quả (hoặc dùng `agent: "general"` có kiểm soát — mỗi thao tác ghi vẫn xin phép và chạy tuần tự).
- Người dùng phải duyệt mỗi lần chạy workflow; nói rõ cho họ biết workflow sẽ làm gì và tốn cỡ nào (số agent × số token ước lượng).

## Sau khi xong

Tổng hợp kết quả thành câu trả lời cho người dùng bằng lời của bạn; nêu số agent đã dùng, phần nào chưa chắc, phần nào agent không hoàn thành (`ok: false`). Đừng dán nguyên báo cáo thô của agent con.
