# TÀI LIỆU ĐẶC TẢ KIẾN TRÚC HỆ THỐNG AGENT TỰ CHỦ (ENTERPRISE AUTONOMOUS AGENT ARCHITECTURE)
**Phân tích chuyên sâu từ cơ chế Interleaved Thinking, Dynamic Skill Discovery và Stream Summarization của Anthropic Claude**

---

## TỔNG QUAN KIẾN TRÚC

Luồng thực thi của Claude dựa trên kiến trúc **Interleaved Thinking & Dynamic Tool-Use Loop (Vòng lặp Suy luận Đan xen và Sử dụng Công cụ Động)**, kết hợp với cơ chế **Progressive Skill/Tool Discovery (Khám phá Kỹ năng/Công cụ Lũy tiến)** và **Stream Summarization (Tóm tắt luồng suy nghĩ theo thời gian thực)**.

Điểm cốt lõi giúp hệ thống này thông minh mà không cần hard-code bất kỳ kịch bản `if-else` nào nằm ở việc: **LLM tự đóng vai trò là State Machine (Máy trạng thái) và Runtime Scheduler (Bộ lập lịch thực thi)**. Toàn bộ quá trình lập kế hoạch, tìm kiếm, phát hiện mâu thuẫn dữ liệu, đổi hướng kiến trúc giao diện và viết code đều diễn ra tự nhiên bên trong một vòng lặp `while` duy nhất.

---

## 1. GIẢI PHẪU CHI TIẾT LUỒNG XỬ LÝ TỪ LOG HỆ THỐNG

Dưới đây là cách bộ máy bên dưới dịch yêu cầu của người dùng thành chuỗi hành động tự chủ qua 5 giai đoạn:

### Giai đoạn 1: Phân rã mục tiêu và Khởi tạo trạng thái (Task Decomposition & Todo State)
* **Log trên UI:** 
  * *"Đã thêm tác vụ: Gom điểm Intelligence Index theo model và mức thinking..."*
  * *"Đã thêm tác vụ: Dựng bảng thang điểm có đánh dấu ranh giới mua được"*
* **Cơ chế lõi:** Ngay khi nhận prompt phức tạp, Agent không nhảy vào trả lời ngay mà gọi một công cụ quản lý trạng thái nội bộ (`todo_write` hoặc `task_manager`). Việc ghi các bước ra một danh sách tác vụ giúp Agent **neo giữ mục tiêu (Goal Anchoring)** trong Context Window. Khi đi qua hàng chục bước tìm kiếm sau đó, nó vẫn biết mình đang ở đâu trong bức tranh tổng thể.

### Giai đoạn 2: Khám phá công cụ động (Lazy Skill / Meta-Tool Loading)
* **Log trên UI:** *"Đã tải claude-artifacts"*
* **Cơ chế lõi:** Nếu nhồi toàn bộ hướng dẫn viết code UI, tạo bảng biểu, xuất file... vào System Prompt ngay từ đầu, hệ thống sẽ tốn hàng chục nghìn token vô ích cho các câu hỏi chat thông thường và làm giảm độ thông minh của model (Context Rot). Anthropic giải quyết bằng kiến trúc **Dynamic Skill Loading**:
  * Trong System Prompt gốc chỉ có một dòng mô tả siêu ngắn: *"Nếu cần dựng giao diện/bảng biểu phức tạp, hãy gọi tool `load_skill('claude-artifacts')`"*.
  * Khi thấy bài toán cần dựng bảng thang điểm, Agent chủ động gọi tool này để "nạp" toàn bộ tài liệu hướng dẫn thiết kế (design guidelines) và bộ công cụ con vào ngữ cảnh.

### Giai đoạn 3: Thu thập dữ liệu song song & Tự hiệu chỉnh (Parallel Search & Self-Correction)
* **Log trên UI:** 
  * Thực hiện 5 lệnh *"Đã tìm kiếm trên web"* liên tiếp cho các họ model (Claude Opus/Sonnet 5.5, Gemini 3.8, GPT-6...).
  * Suy luận đan xen: *"Checking which index version the data came from"* $\rightarrow$ *"Reconciling conflicting index scores across versions"* $\rightarrow$ *"Choosing one index version so the scores line up"* $\rightarrow$ *"Correcting an earlier figure after checking a newer index update"*.
* **Cơ chế lõi (Interleaved Thinking):** Đây là sự khác biệt lớn nhất giữa Agent thế hệ mới và RAG truyền thống. Giữa các lần gọi tool, model mở các khối `<thinking>` (suy nghĩ ẩn). Khi đọc kết quả trả về từ 5 lệnh search, nó phát hiện trang Artificial Analysis có nhiều phiên bản thang đo (Index v1, v2...) làm điểm số bị lệch. Thay vì lấy bừa số đầu tiên, nó tự kích hoạt lệnh đọc trực tiếp trang chủ (`fetch_url`: *"Đã đọc artificialanalysis.ai"*), tìm thêm các model mã nguồn mở (DeepSeek V4.1, Gemma 4...) để tính toán dung lượng RAM/VRAM (*"Sizing the hardware each model needs"*) và chuẩn hóa toàn bộ dữ liệu về cùng một hệ quy chiếu.

### Giai đoạn 4: Tự đánh giá giới hạn kỹ thuật và Đổi hướng kiến trúc (Architectural Pivot)
* **Log trên UI:** 
  * *"Đã liệt kê loại artifact"* $\rightarrow$ *"Đã sử dụng artifact"*.
  * *"Đang kiểm tra các công cụ ghi dữ liệu có sẵn chưa"* $\rightarrow$ *"Đang ghi bảng dữ liệu mô hình vào cơ sở dữ liệu"*.
  * *"Reviewing the Dashboard type's constraints for uploading assets"* $\rightarrow$ *"Weighing a simpler single-file HTML against the Dashboard type"*.
* **Cơ chế lõi:** Sau khi nạp skill `claude-artifacts`, Agent kiểm tra các template có sẵn (như loại `Dashboard` có hỗ trợ database nội bộ). Tuy nhiên, trong quá trình suy luận (Thinking), nó nhận thấy định dạng `Dashboard` có các rào cản về việc nạp tài nguyên/assets cho bài toán cụ thể này, nên nó tự cân nhắc chuyển sang kiến trúc **Single-file HTML/React** gọn nhẹ và linh hoạt hơn để vẽ các thanh điểm (score bars) và bộ lọc (filter chips). Không một dòng code cứng nào lập trình sẵn quyết định này; tất cả là do LLM đọc tài liệu của chính hệ thống (self-documentation) và tự đưa ra quyết định kiến trúc.

### Giai đoạn 5: Thực thi chi tiết và Stream hóa suy nghĩ ra UI (Execution & Thought Summarization)
* **Log trên UI:** Các dòng chữ nhỏ kèm chấm tròn xám/cam chạy liên tục: *"Planning the table layout..."*, *"Viết hàm vẽ bảng và các ô số liệu"*, *"Đang viết kiểu dáng cho bảng và thẻ"*, *"Đang suy nghĩ"*.
* **Cơ chế lõi:** Trong lúc Agent đang thực sự viết hàng trăm dòng code HTML/CSS/JS hoặc suy nghĩ hàng nghìn token bên trong thẻ `<thinking>`, nếu để màn hình trống trơn, người dùng sẽ tưởng ứng dụng bị treo. Hệ thống Backend sẽ cắt các luồng token suy nghĩ/code đang sinh ra theo từng cụm (chunk), đẩy qua một **Model siêu nhẹ và cực nhanh (như lớp Haiku/Flash-Lite)** để tóm tắt thành một câu trạng thái ngắn gọn (10-15 từ) và đẩy qua giao diện qua giao thức Server-Sent Events (SSE).

---

## 2. SƠ ĐỒ KIẾN TRÚC TỔNG THỂ HỆ THỐNG AGENT (5 LAYERS)

Để xây dựng một hệ thống hoạt động theo chuẩn kiến trúc module hóa, không nợ kỹ thuật và hoàn toàn tự động (Zero Hard-coding), kiến trúc toàn diện bao gồm 5 tầng phối hợp chặt chẽ:

```text
+===================================================================================================+
|                                  1. CLIENT & STREAMING UI LAYER                                   |
|  +-----------------------------+   +-----------------------------+   +-------------------------+  |
|  |   Task / Todo Tracker UI    |   |  Live Thought Timeline UI   |   |  Artifact Sandbox (UI)  |  |
|  | (Hiển thị các mốc công việc)|   | (Các dòng chấm tròn tóm tắt)|   | (Iframe chạy HTML/React)|  |
|  +-----------------------------+   +-----------------------------+   +-------------------------+  |
+===================================================================================================+
                                                  ^
                                                  | (SSE / WebSockets: Multiplexed Event Stream)
                                                  | Events: [task_update, status_pill, artifact_chunk]
+===================================================================================================+
|                              2. STREAM INTERCEPTOR & ROUTER GATEWAY                               |
|  +----------------------------------------------+----------------------------------------------+  |
|  |            XML/JSON Stream Parser            |          Async Thought Summarizer            |  |
|  |  Bóc tách luồng token raw theo thời gian thực|  Gom mỗi 300 tokens từ luồng <thinking> hoặc |  |
|  |  - Luồng <thinking>  ---> Đẩy sang Summarizer|  luồng viết code ---> Gọi Fast LLM (Haiku/   |  |
|  |  - Luồng <tool_call> ---> Đẩy xuống Runtime  |  Flash) dịch thành 1 câu trạng thái ngắn gọn |  |
|  |  - Luồng Text/Code   ---> Đẩy lên UI         |  (VD: "Đang viết hàm xếp hạng...")           |  |
|  +----------------------------------------------+----------------------------------------------+  |
+===================================================================================================+
                                                  ^
                                                  | (Raw Token Stream)
+===================================================================================================+
|                         3. AGENTIC ORCHESTRATION ENGINE (THE CORE LOOP)                           |
|                                                                                                   |
|   +-------------------------------------------------------------------------------------------+   |
|   |                        WHILE (stop_reason == "tool_use" && turn < MAX_TURNS)              |   |
|   |                                                                                           |   |
|   |    +-------------------+       +-------------------+       +-------------------------+    |   |
|   |    | 1. Context Builder| ----> | 2. Reasoning LLM  | ----> | 3. Tool Dispatcher      |    |   |
|   |    | (Nạp System Prompt|       | (Interleaved      |       | (Hỗ trợ gọi song song   |    |   |
|   |    | + Lịch sử + Kỹ    |       |  Thinking + Sinh  |       |  Parallel Tool Calls    |    |   |
|   |    | năng vừa mở khóa) |       |  Lệnh gọi Tool)   |       |  bất đồng bộ)           |    |   |
|   |    +-------------------+       +-------------------+       +-------------------------+    |   |
|   |              ^                                                          |                 |   |
|   |              |_________________ (4. Append Tool Results) _______________|                 |   |
|   +-------------------------------------------------------------------------------------------+   |
+===================================================================================================+
               |                                  |                                   |
               v                                  v                                   v
+=============================+    +==============================+    +============================+
|  4A. STATE & PLANNING TOOLS |    | 4B.PROGRESSIVE SKILL REGISTRY|    | 4C. EXECUTION SANDBOX & IO |
|  +-----------------------+  |    | +--------------------------+ |    | +------------------------+ |
|  | - todo_add / update   |  |    | | Meta-Tool:               | |    | | - Web Search (Parallel)| |
|  | - scratchpad_memory   |  |    | | - search_skills(query)   | |    | | - Headless Web Scraper | |
|  | (Giữ trạng thái kế    |  |    | | - load_skill(skill_name) | |    | | - In-memory SQLite DB  | |
|  |  hoạch xuyên suốt     |  |    | | (Chỉ nạp hướng dẫn thiết | |    | | - Code/Artifact Writer | |
|  |  hàng chục bước)      |  |    | |  kế và sub-tools khi cần)| |    | |   (VFS / Sandboxed)    | |
|  +-----------------------+  |    | +--------------------------+ |    | +------------------------+ |
+=============================+    +==============================+    +============================+
```

---

## 3. THIẾT KẾ HỆ THỐNG LÕI (CORE ENGINE ARCHITECTURE)

Để tránh hoàn toàn việc viết các luồng `if (user_asks_benchmark) { search_web(); draw_table(); }`, hệ thống áp dụng triết lý **Model-Driven Control Flow** thông qua 4 trụ cột kỹ thuật:

### Trụ cột 1: Kiến trúc Vòng lặp Đơn (Single-Loop ReAct với Interleaved Thinking)
Thay vì xây dựng một đồ thị DAG (Directed Acyclic Graph) cứng nhắc với hàng chục Node cố định, lõi của Agent chỉ là một vòng lặp `while` duy nhất. Ở mỗi vòng lặp, Model được cấp quyền suy nghĩ (`thinking`) trước và sau mỗi lần nhận kết quả từ công cụ.

Dưới đây là mã nguồn kiến trúc lõi chuẩn Production (Python/Asyncio):

```python
import asyncio
from typing import List, Dict, Any

class AutonomousAgentEngine:
    def __init__(self, core_llm, fast_summarizer_llm, skill_registry, tool_executor, ui_stream):
        self.core_llm = core_llm                      # Model suy luận mạnh (VD: Claude Opus/Sonnet, Gemini Pro)
        self.summarizer = fast_summarizer_llm         # Model siêu nhanh để tóm tắt trạng thái UI
        self.skills = skill_registry                  # Kho chứa các Skill (Artifacts, Data Analysis, Coding...)
        self.executor = tool_executor                 # Bộ thực thi công cụ bất đồng bộ
        self.ui = ui_stream                           # Kênh truyền SSE về giao diện người dùng

    async def run_agent_loop(self, user_prompt: str, session_state: Dict[str, Any]):
        # 1. Khởi tạo Context chỉ với các Meta-Tools cơ bản (Không nạp full tools để tiết kiệm token)
        messages = [{"role": "user", "content": user_prompt}]
        active_tools = self.skills.get_base_meta_tools() # Gồm: todo_write, load_skill, web_search, fetch_url
        system_prompt = self.build_dynamic_system_prompt(session_state)

        turn_count = 0
        MAX_TURNS = 25

        # VÒNG LẶP LÕI DUY NHẤT ĐIỀU KHIỂN TOÀN BỘ AGENT
        while turn_count < MAX_TURNS:
            turn_count += 1
            
            # 2. Gọi Core LLM với chế độ Streaming & Interleaved Thinking
            response_stream = self.core_llm.stream(
                system=system_prompt,
                messages=messages,
                tools=active_tools,
                thinking_config={"type": "enabled", "budget_tokens": 8000}
            )

            # 3. Bộ đón lõng luồng (Stream Interceptor) xử lý song song việc hiển thị UI
            assistant_message = await self.process_and_summarize_stream(response_stream)
            messages.append(assistant_message)

            # 4. Nếu Model quyết định đã giải quyết xong bài toán -> Thoát vòng lặp
            if assistant_message.stop_reason == "end_turn":
                break

            # 5. Nếu Model yêu cầu gọi công cụ (Có thể là 1 hoặc nhiều công cụ cùng lúc)
            if assistant_message.stop_reason == "tool_use":
                tool_calls = assistant_message.get_tool_calls()
                
                # Thực thi TẤT CẢ các tool calls song song (VD: 5 lệnh tìm kiếm web cùng lúc)
                tool_results = await asyncio.gather(
                    *[self.execute_single_tool(tc, active_tools, session_state) for tc in tool_calls]
                )
                
                # Đưa toàn bộ kết quả quan sát được (Observations) quay lại vào Context cho vòng lặp tiếp theo
                messages.append({"role": "tool_results", "content": tool_results})

    async def execute_single_tool(self, tool_call, active_tools: List, session_state: Dict):
        """Xử lý từng công cụ và tự động mở rộng quyền hạn (Dynamic Skill Expansion)"""
        name = tool_call.name
        args = tool_call.arguments

        # Cơ chế 1: Quản lý Todo List (Hiển thị lên UI: "Đã thêm tác vụ...")
        if name == "todo_write":
            await self.ui.emit("task_added", {"title": args["task_title"], "status": args.get("status", "pending")})
            return self.executor.update_todo(session_state, args)

        # Cơ chế 2: Lazy Skill Loading (Hiển thị lên UI: "Đã tải claude-artifacts")
        elif name == "load_skill":
            skill_name = args["skill_name"]
            await self.ui.emit("skill_loaded", {"skill": skill_name})
            
            # Lấy hướng dẫn chuyên sâu (Design Guidelines) và mở khóa các Sub-tools mới
            skill_pack = self.skills.fetch_skill_package(skill_name)
            
            # Tránh nạp trùng sub-tools nếu đã mở khóa trước đó
            existing_names = {t["name"] for t in active_tools}
            for sub_tool in skill_pack.sub_tools:
                if sub_tool["name"] not in existing_names:
                    active_tools.append(sub_tool)
            
            # Trả về tài liệu hướng dẫn ngay trong kết quả của Tool để LLM đọc và học tức thì!
            return {
                "status": "success",
                "skill_documentation": skill_pack.markdown_guidelines,
                "unlocked_tools": [t["name"] for t in skill_pack.sub_tools]
            }

        # Cơ chế 3: Các công cụ thực thi thông thường (Web Search, Đọc URL, Ghi DB, Tạo Artifact)
        else:
            await self.ui.emit("tool_executing", {"tool": name, "detail": args})
            return await self.executor.run(name, args)
```

---

### Trụ cột 2: Cơ chế "Documentation-as-Tool-Output" & Cấu trúc Progressive Skill Registry
Làm sao Agent "đọc hướng dẫn thiết kế" và "biết giới hạn của kiểu Dashboard" trong lúc đang chạy?
1. Khi Agent gọi công cụ `load_skill("claude-artifacts")` hoặc `list_artifact_types()`, kết quả trả về (`tool_result`) không chỉ là dữ liệu JSON khô khan, mà **chính là một file Markdown chứa tài liệu kiến trúc và Design System** do các kỹ sư biên soạn sẵn.
2. Tài liệu này chỉ được bơm vào Context **đúng thời điểm Agent cần dựng giao diện**.
3. Ngay ở bước `<thinking>` tiếp theo, Agent đọc đoạn Markdown vừa được trả về từ tool, đối chiếu với yêu cầu của người dùng, và tự suy luận để chọn hướng kiến trúc tối ưu (ví dụ: chuyển từ `Dashboard` sang `Single-file HTML`).

#### Mẫu JSON Schema của Meta-Tool & Skill Package trong `Skill Registry`:

```json
{
  "base_meta_tools": [
    {
      "name": "todo_write",
      "description": "Ghi lại hoặc cập nhật các tác vụ trong kế hoạch giải quyết vấn đề phức tạp.",
      "input_schema": {
        "type": "object",
        "properties": {
          "task_title": { "type": "string", "description": "Tên tác vụ ngắn gọn hiển thị cho người dùng" },
          "status": { "type": "string", "enum": ["added", "in_progress", "completed"] }
        },
        "required": ["task_title", "status"]
      }
    },
    {
      "name": "load_skill",
      "description": "Tải gói kỹ năng chuyên sâu (tài liệu hướng dẫn kiến trúc và bộ công cụ con) vào ngữ cảnh hiện tại.",
      "input_schema": {
        "type": "object",
        "properties": {
          "skill_name": {
            "type": "string",
            "enum": ["claude-artifacts", "data-science-sandbox", "document-exporter"],
            "description": "Tên gói kỹ năng cần nạp"
          }
        },
        "required": ["skill_name"]
      }
    }
  ],
  "skill_packages": {
    "claude-artifacts": {
      "markdown_guidelines": "# HƯỚNG DẪN THIẾT KẾ ARTIFACT\n1. **Kiểu Dashboard (`application/vnd.ant.dashboard`)**: Hỗ trợ SQLite nội bộ (`write_db`), nhưng KHÔNG hỗ trợ nhúng tài nguyên/assets tuỳ chỉnh phức tạp hoặc vẽ thanh điểm (score bars) tuỳ biến cao.\n2. **Kiểu Single-file HTML (`text/html`)**: Bao gồm toàn bộ HTML/CSS/JS trong một file duy nhất. Ưu tiên sử dụng khi cần tuỳ biến giao diện bảng biểu phức tạp, filter chips, thanh tiến trình màu sắc và phân vùng dữ liệu trực quan.",
      "sub_tools": [
        {
          "name": "list_artifact_types",
          "description": "Liệt kê chi tiết thông số kỹ thuật và giới hạn của từng loại Artifact."
        },
        {
          "name": "create_artifact",
          "description": "Khởi tạo và stream mã nguồn giao diện hoàn chỉnh lên Sandbox UI."
        }
      ]
    }
  }
}
```

---

### Trụ cột 3: Cơ chế Stream Summarization (Biến luồng suy nghĩ thô thành trải nghiệm UI mượt mà)
Giải pháp kiến trúc ở tầng **Stream Interceptor (Tầng 2)** hoạt động như sau:
1. **Bộ đệm trượt (Sliding Token Buffer):** Khi Core LLM đang stream các token bên trong thẻ `<thinking>` hoặc đang truyền tham số code rất dài vào tool `create_artifact(code="...")`, bộ Interceptor sẽ gom mỗi cụm khoảng **150 – 300 tokens** (hoặc mỗi 1.5 giây).
2. **Luồng tóm tắt bất đồng bộ (Non-blocking Sidecar Summarizer):** Cụm token thô đó được gửi bất đồng bộ (fire-and-forget) sang một mô hình nhỏ, tốc độ phản hồi dưới 200ms với System Prompt chuyên biệt dưới đây:

#### System Prompt cho Sidecar Summarizer (Fast LLM):
```markdown
Bạn là bộ máy tóm tắt trạng thái thực thi theo thời gian thực (Real-time Telemetry Summarizer).
Nhiệm vụ của bạn là đọc một đoạn văn bản thô (đang được cắt ra từ luồng suy nghĩ nội bộ `<thinking>` hoặc luồng viết code của AI chính) và dịch nó thành MỘT câu thông báo trạng thái cực ngắn gọn để hiển thị trên giao diện người dùng.

QUY TẮC BẮT BUỘC:
1. Độ dài: Tối đa 8 - 14 từ.
2. Định dạng: Bắt đầu bằng động từ chỉ hành động đang diễn ra (Ví dụ tiếng Việt: "Đang đối chiếu...", "Đang viết hàm...", "Chọn nguồn và định dạng..."; hoặc tiếng Anh dạng V-ing: "Checking...", "Reconciling...", "Sorting...").
3. Tuyệt đối KHÔNG nhắc đến tên biến, thẻ XML/HTML, cú pháp code (như `<div>`, `function`, `JSON`), hoặc từ "người dùng". Hãy dịch ý nghĩa kỹ thuật sang ngôn ngữ nghiệp vụ tự nhiên.
4. Ví dụ chuyển đổi chuẩn:
   - Input thô: `<thinking>The scores from October 2026 leaderboard show v2 index while earlier search showed v1. Need to align them to v2...</thinking>`
   -> Output: `Reconciling conflicting index scores across versions.`
   - Input thô: `function renderScoreTable(models) { const container = document.getElementById('table-body'); ...`
   -> Output: `Viết hàm vẽ bảng và các ô số liệu.`
   - Input thô: `.score-bar { display: flex; border-radius: 4px; background: linear-gradient(...); }`
   -> Output: `Đang viết kiểu dáng cho bảng và thẻ.`
```

---

### Trụ cột 4: Hệ thống Prompt Đóng vai trò "Hiến pháp điều phối" (Orchestration System Prompt)
Để vòng lặp `while` vận hành trơn tru như một chuyên gia thực thụ mà không bị đi lòng vòng, System Prompt của Core LLM được thiết kế theo hướng **Phương pháp luận giải quyết vấn đề (Problem-Solving Meta-Cognition)**:

```markdown
# ORCHESTRATION CONSTITUTION (HIẾN PHÁP ĐIỀU PHỐI AGENT)

Bạn là một Autonomous AI Agent có khả năng lập kế hoạch, suy luận đan xen (Interleaved Thinking), khám phá công cụ động và tự hiệu chỉnh. Khi giải quyết yêu cầu của người dùng, hãy tuân thủ 4 nguyên tắc cốt lõi:

1. **Nguyên tắc Plan-First (Neo giữ mục tiêu):**
   Với mọi yêu cầu đòi hỏi nhiều bước thu thập, đối chiếu và tổng hợp dữ liệu, hãy luôn sử dụng công cụ `todo_write` đầu tiên để phác thảo các cột mốc lớn trước khi thực thi.

2. **Nguyên tắc Parallel Exploration (Khám phá song song):**
   Khi cần tra cứu thông tin về nhiều thực thể độc lập (ví dụ: nhiều sản phẩm, nhiều mô hình AI, nhiều nguồn tin), hãy phát lệnh gọi công cụ tìm kiếm song song trong cùng một lượt (batch tool calls) để tối ưu thời gian phản hồi.

3. **Nguyên tắc Data Reconciliation (Đối chiếu & Tự hiệu chỉnh):**
   Không bao giờ tin tưởng mù quáng vào kết quả tìm kiếm đầu tiên. Trong khối `<thinking>` sau khi nhận dữ liệu từ công cụ, hãy luôn kiểm tra tính nhất quán về phiên bản, thời gian và đơn vị đo. Nếu phát hiện mâu thuẫn giữa các nguồn, hãy chủ động gọi công cụ đọc trực tiếp trang gốc (`fetch_url`) hoặc tìm kiếm bổ sung để xác minh trước khi tổng hợp.

4. **Nguyên tắc Lazy Skill Discovery & Architectural Evaluation (Khám phá kỹ năng & Đánh giá kiến trúc):**
   Trước khi xây dựng sản phẩm đầu ra phức tạp (báo cáo, bảng biểu, ứng dụng tương tác), hãy gọi công cụ `load_skill` tương ứng để nạp tiêu chuẩn thiết kế. Sau khi đọc tiêu chuẩn thiết kế trong `<thinking>`, hãy cân nhắc ưu/nhược điểm của từng định dạng (ví dụ: Dashboard vs Single-file HTML) để chọn ra kiến trúc phù hợp nhất với dữ liệu thực tế.
```

---

## 4. BẢNG TÓM LƯỢC LUỒNG DỮ LIỆU ĐẦU - CUỐI (END-TO-END EXECUTION FLOW)

| Bước | Thành phần xử lý | Hành động bên dưới Hệ thống Lõi (Under the hood) | Hiển thị trên Giao diện (UI Tóm tắt) |
| :--- | :--- | :--- | :--- |
| **1** | **Core LLM $\rightarrow$ State Tool** | Phân tích độ phức tạp của câu hỏi, gọi `todo_write` tạo 2 mục tiêu lớn trong Session State. | `Đã thêm tác vụ: Gom điểm Intelligence Index...`<br>`Đã thêm tác vụ: Dựng bảng thang điểm...` |
| **2** | **Core LLM $\rightarrow$ Skill Registry** | Nhận thấy cần vẽ bảng tương tác, gọi `load_skill("claude-artifacts")` để nạp tài liệu hướng dẫn và mở khóa bộ công cụ Artifact. | `Q Đã tải claude-artifacts` |
| **3** | **Core LLM $\rightarrow$ Parallel IO** | Sinh 5 lệnh `web_search` trong cùng 1 phản hồi. `Tool Dispatcher` chạy `asyncio.gather` gọi 5 API tìm kiếm cùng lúc. | 5 dòng `Đã tìm kiếm trên web` xuất hiện gần như đồng thời. |
| **4** | **Core LLM (Interleaved Thinking)** | Đọc kết quả từ 5 lệnh search trong khối `<thinking>`. Phát hiện điểm số lệch nhau do khác phiên bản bảng xếp hạng. Sidecar LLM tóm tắt luồng suy nghĩ này bắn lên UI. | `• Checking which index version the data came from.`<br>`• Reconciling conflicting index scores...`<br>`• Choosing one index version...` |
| **5** | **Core LLM $\rightarrow$ Web Scraper** | Quyết định cần dữ liệu gốc chuẩn xác và thông số phần cứng (VRAM/RAM) cho model local. Gọi tiếp `fetch_url("artificialanalysis.ai/...")` và 2 lệnh `web_search` bổ sung. | `Đã đọc artificialanalysis.ai`<br>`Đã tìm kiếm trên web (DeepSeek V4.1 GGUF...)` |
| **6** | **Core LLM $\rightarrow$ Artifact Sub-tools** | Gọi các công cụ con vừa được mở khóa ở Bước 2 để kiểm tra các template giao diện và ghi dữ liệu chuẩn hóa vào bộ nhớ tạm. | `Đã liệt kê loại artifact`<br>`Đã sử dụng artifact`<br>`• Đang ghi bảng dữ liệu mô hình vào cơ sở dữ liệu.` |
| **7** | **Core LLM (Architectural Pivot)** | Đọc tài liệu giới hạn của kiểu `Dashboard` (vừa trả về từ tool), suy luận trong `<thinking>` và quyết định chuyển sang viết Single-file HTML để vẽ thanh điểm và bộ lọc linh hoạt hơn. | `• Reviewing the Dashboard type's constraints...`<br>`• Weighing a simpler single-file HTML against the Dashboard type.` |
| **8** | **Core LLM $\rightarrow$ Code Stream + Sidecar Summarizer** | Bắt đầu stream mã nguồn HTML/CSS/JS hoàn chỉnh vào công cụ render. Trong lúc chờ hàng trăm dòng code được sinh ra, Sidecar Summarizer liên tục đọc code đang chảy qua và dịch thành các bước công việc dễ hiểu cho người dùng. | `• Viết hàm vẽ bảng và các ô số liệu.`<br>`• Đang viết kiểu dáng cho bảng và thẻ.`<br>`• Đang viết hàm xếp hạng và gán nhóm...` |