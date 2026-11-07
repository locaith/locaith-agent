/**
 * Ô nhập. Hai ràng buộc cứng cho tiếng Việt:
 *  1. <textarea> KHÔNG kiểm soát (không có prop `value`): không bao giờ gán .value khi đang gõ dấu
 *     (Telex/VNI) — nếu không bộ gõ sẽ hỏng chữ đang soạn.
 *  2. Enter không được gửi tin khi bộ gõ còn đang ghép chữ (`isComposing` / keyCode 229).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DOC_ACCEPT, MAX_DOC_BYTES, MAX_DOCS_PER_MESSAGE, docKindOf, isLegacyOffice } from '../../../../src/shared/docKinds';
import type { AttachmentInfo, FileHit, QueuedInfo, SlashCommandInfo, ViewState } from '../../../../src/shared/protocol';
import { bus } from '../../bus';
import { useApp } from '../../ctx';
import { basename, filterByQuery, mentionAtCaret, parseSlashCommand, relativizeUri, slashAtCaret, SLASH_COMMANDS_WITH_ARGS } from '../../text';
import { imageKey } from '../../../../src/shared/transcriptRebuild';
import { persistableAttachments } from '../../draftState';
import { cx, readFileAsBase64 } from '../../util';
import { loadUiState, post, saveUiState } from '../../vscode';
import { AttachmentChip, attachmentText } from '../Chips';
import { Icon } from '../Icons';
import { Spinner } from '../ui';
import { AgentChip } from './AgentChip';
import { ContextMeter, ModelPicker, ModePicker, SwarmToggle, ThinkingPicker } from './Pickers';
import { isModeCycleKey, nextMode } from '../../modeCycle'; // (lane:perm-rules)

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXTAREA_PX = 260;
/** Quá hạn này mà host chưa trả lời thì thôi chờ (để chip "đang đọc" không chặn việc gửi mãi). */
const DOC_READ_TIMEOUT_MS = 120_000;

type PickerId = 'model' | 'mode' | 'think' | 'ctx';

/** Tệp đang chờ host đọc thành chữ. */
interface ReadingDoc {
  id: number;
  name: string;
  size: number;
}

/** Thứ tự người dùng chọn tệp tải lên: chip giữ đúng thứ tự đó dù tệp nhỏ đọc xong trước tệp lớn. */
const docSeq = new WeakMap<AttachmentInfo, number>();

/** Ảnh thu nhỏ (JPEG ≤ 320 px) để hiện trong tin đã gửi mà không phải giữ cả ảnh gốc ở giao diện. */
async function makeThumb(file: Blob, max = 320): Promise<string | undefined> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d')?.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const url = c.toDataURL('image/jpeg', 0.72);
    return url.slice(url.indexOf(',') + 1);
  } catch {
    return undefined; // định dạng trình duyệt không giải mã được (hiếm): vẫn gửi được, chỉ thiếu bản thu nhỏ
  }
}

function sameAttachment(a: AttachmentInfo, b: AttachmentInfo): boolean {
  return a.kind === b.kind && a.path === b.path && a.range?.[0] === b.range?.[0] && a.range?.[1] === b.range?.[1] && a.label === b.label && a.sizeBytes === b.sizeBytes;
}

function MentionMenu({
  items,
  busy,
  active,
  onPick,
  onHover,
}: {
  items: FileHit[];
  busy: boolean;
  active: number;
  onPick: (hit: FileHit) => void;
  onHover: (i: number) => void;
}) {
  const { t } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }), [active, items]);
  return (
    <div class="popover popover-menu" role="listbox" aria-label="@" ref={ref}>
      {items.length === 0 ? (
        <div class="popover-empty">{busy ? <><Spinner size={12} /> {t('composer.mention.searching')}</> : t('composer.mention.none')}</div>
      ) : (
        items.map((hit, i) => (
          <button
            key={hit.path}
            type="button"
            role="option"
            aria-selected={i === active}
            data-active={i === active}
            class={cx('menu-row', i === active && 'is-active')}
            onMouseMove={() => onHover(i)}
            // pointerdown + preventDefault: giữ focus ở ô nhập để không làm gián đoạn bộ gõ.
            onPointerDown={(e) => {
              e.preventDefault();
              onPick(hit);
            }}
          >
            <Icon name={hit.path.startsWith('tab:') ? 'globe' : hit.isDir ? 'folder' : 'file-text'} size={14} />
            <span class="menu-name">{hit.name}</span>
            <span class="menu-dir">{hit.dir}</span>
          </button>
        ))
      )}
    </div>
  );
}

function SlashMenu({
  items,
  active,
  onPick,
  onHover,
}: {
  items: SlashCommandInfo[];
  active: number;
  onPick: (cmd: SlashCommandInfo) => void;
  onHover: (i: number) => void;
}) {
  const { t } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }), [active, items]);
  return (
    <div class="popover popover-menu" role="listbox" aria-label={t('composer.slash.title')} ref={ref}>
      {items.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          role="option"
          aria-selected={i === active}
          data-active={i === active}
          class={cx('menu-row', i === active && 'is-active')}
          onMouseMove={() => onHover(i)}
          onPointerDown={(e) => {
            e.preventDefault();
            onPick(cmd);
          }}
        >
          <span class="menu-slash">/{cmd.name.replace(/^\//, '')}</span>
          <span class="menu-desc">{cmd.description}</span>
        </button>
      ))}
    </div>
  );
}

/** Tin đang xếp hàng, chờ trợ lý nhận ở bước kế tiếp. Bấm nội dung để lấy lại vào ô nhập và sửa; ✕ để xoá. */
function QueueList({ items }: { items: QueuedInfo[] }) {
  const { t } = useApp();
  return (
    <div class="queue" role="region" aria-live="polite" aria-label={t('queue.title', { n: items.length })}>
      <div class="queue-head">
        <span class="queue-title">
          <Icon name="queue" size={13} />
          {t('queue.title', { n: items.length })}
        </span>
        <span class="queue-hint">{t('queue.hint')}</span>
      </div>
      <ul class="queue-list">
        {items.map((q) => (
          <li key={q.id} class="queue-item">
            <button type="button" class="queue-text" title={t('queue.edit')} onClick={() => post({ type: 'queue_remove', id: q.id, edit: true })}>
              {q.text || q.attachments.map((a) => a.label).join(', ')}
            </button>
            {q.attachments.length > 0 && (
              <span class="queue-att" title={q.attachments.map((a) => a.label).join(', ')}>
                <Icon name="paperclip" size={12} />
                {q.attachments.length}
              </span>
            )}
            <button type="button" class="queue-now" onClick={() => post({ type: 'queue_send_now', id: q.id })} title={t('queue.sendNow.hint')} aria-label={t('queue.sendNow.hint')}>
              <Icon name="send" size={11} />
              <span>{t('queue.sendNow')}</span>
            </button>
            <button type="button" class="queue-x" onClick={() => post({ type: 'queue_remove', id: q.id })} title={t('queue.remove')} aria-label={t('queue.remove')}>
              <Icon name="x" size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Composer({ view }: { view: ViewState }) {
  const { t, lang, toast, editor, platform, openSettings } = useApp();
  const isBrowser = platform === 'browser';
  const placeholderKey = isBrowser ? 'composer.placeholder.browser' : 'composer.placeholder';
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const lastCompositionEnd = useRef(0);
  const dismissed = useRef<{ start: number; query: string } | null>(null);
  const mentionPaths = useRef(new Set<string>());
  const reqCounter = useRef(0);
  const imageCounter = useRef(0);
  const draftTimer = useRef<number | undefined>(undefined);
  const warnedDrop = useRef(false);
  const docReqCounter = useRef(0);
  /** Bản sao đồng bộ của `reading` để các hàm bất đồng bộ/vòng lặp thấy ngay giá trị mới nhất. */
  const readingRef = useRef<ReadingDoc[]>([]);
  const docTimers = useRef(new Map<number, number>());

  const [attachments, setAttachments] = useState<AttachmentInfo[]>(() => loadUiState().attachments ?? []);
  const [reading, setReadingState] = useState<ReadingDoc[]>([]);
  const [hasText, setHasText] = useState(false);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [slash, setSlash] = useState<{ query: string } | null>(null);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [filesBusy, setFilesBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [picker, setPicker] = useState<PickerId | null>(null);
  const [dropping, setDropping] = useState(false);

  const running = view.running;
  /** Host cho xếp hàng tin khi trợ lý đang chạy (VS Code). Bản trình duyệt chưa có: đang chạy thì chỉ có Dừng. */
  const canQueue = !!view.canQueue;
  const queued = view.queued ?? [];

  const slashItems = useMemo(
    () => (slash ? filterByQuery(view.slashCommands, slash.query, (c) => [c.name.replace(/^\//, ''), c.description]) : []),
    [slash, view.slashCommands],
  );
  const menuOpen = mention !== null || (slash !== null && slashItems.length > 0);

  // ── thao tác trên textarea ──
  const autoGrow = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const extra = ta.offsetHeight - ta.clientHeight; // viền
    ta.style.height = `${Math.min(ta.scrollHeight + extra, MAX_TEXTAREA_PX)}px`;
  }, []);

  const persistDraft = useCallback(() => {
    window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      saveUiState({ draft: taRef.current?.value ?? '' });
    }, 300);
  }, []);

  /** Đặt nội dung ô nhập. Chỉ gọi khi KHÔNG đang ghép chữ. */
  const setTextValue = useCallback(
    (value: string, caret?: number) => {
      const ta = taRef.current;
      if (!ta || composing.current) return;
      ta.value = value;
      const pos = caret ?? value.length;
      ta.setSelectionRange(pos, pos);
      setHasText(value.trim().length > 0);
      autoGrow();
      persistDraft();
      ta.focus();
    },
    [autoGrow, persistDraft],
  );

  const addAttachment = useCallback((a: AttachmentInfo) => {
    setAttachments((prev) => (prev.some((p) => sameAttachment(p, a)) ? prev : [...prev, a]));
  }, []);

  const updateReading = useCallback((fn: (prev: ReadingDoc[]) => ReadingDoc[]) => {
    readingRef.current = fn(readingRef.current);
    setReadingState(readingRef.current);
  }, []);

  /** Thôi chờ một tệp (đã đọc xong, người dùng bấm ×, hoặc quá hạn). */
  const stopReading = useCallback(
    (id: number) => {
      const timer = docTimers.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      docTimers.current.delete(id);
      updateReading((prev) => prev.filter((r) => r.id !== id));
    },
    [updateReading],
  );

  const refreshTriggers = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? ta.value.length;
    const m = mentionAtCaret(ta.value, caret);
    const s = m ? null : slashAtCaret(ta.value, caret);
    const d = dismissed.current;
    const isDismissed = (start: number, query: string) => !!d && d.start === start && d.query === query;
    setMention(m && !isDismissed(m.start, m.query) ? m : null);
    setSlash(s && !isDismissed(0, s.query) ? s : null);
    if (!m && !s) dismissed.current = null;
  }, []);

  useEffect(() => setActive(0), [mention?.query, slash?.query]);

  // ── khởi tạo: khôi phục bản nháp, lắng nghe composition và bus ──
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const draft = loadUiState().draft;
    if (draft) {
      ta.value = draft;
      setHasText(draft.trim().length > 0);
      autoGrow();
    }
    // Dùng addEventListener trực tiếp: tên sự kiện composition của Preact dễ sai chữ hoa/thường.
    const onStart = () => {
      composing.current = true;
    };
    const onEnd = () => {
      composing.current = false;
      lastCompositionEnd.current = Date.now();
      refreshTriggers();
    };
    ta.addEventListener('compositionstart', onStart);
    ta.addEventListener('compositionend', onEnd);

    const offs = [
      bus.insert.on(({ text, attachments: atts }) => {
        if (text) {
          const cur = ta.value;
          const pos = ta.selectionStart ?? cur.length;
          const insert = (pos > 0 && !/\s$/.test(cur.slice(0, pos)) ? ' ' : '') + text;
          setTextValue(cur.slice(0, pos) + insert + cur.slice(pos), pos + insert.length);
        }
        atts?.forEach(addAttachment);
        ta.focus();
      }),
      bus.draft.on(({ text, attachments: atts }) => {
        setTextValue(text);
        if (atts) setAttachments(atts);
      }),
      bus.prefill.on((text) => setTextValue(text)),
      bus.focus.on(() => ta.focus()),
      bus.files.on(({ reqId, items }) => {
        if (reqId === reqCounter.current) {
          setFiles(items);
          setFilesBusy(false);
        }
      }),
    ];
    return () => {
      ta.removeEventListener('compositionstart', onStart);
      ta.removeEventListener('compositionend', onEnd);
      offs.forEach((off) => off());
      window.clearTimeout(draftTimer.current);
    };
  }, [addAttachment, autoGrow, refreshTriggers, setTextValue]);

  // Lưu tệp/vùng chọn (không lưu ảnh và tệp tải lên — quá nặng) để sống sót qua việc webview bị tạo lại.
  useEffect(() => {
    // 0.6.17: giữ NGUYÊN tệp đính kèm (kể cả ảnh và tài liệu) khi ẩn/hiện webview — trước đây lọc bỏ nên chuyển tab là mất.
    const { kept, dropped } = persistableAttachments(attachments);
    if (dropped > 0 && !warnedDrop.current) {
      warnedDrop.current = true;
      toast('warn', t('composer.attach.tooLarge', { n: dropped }));
    }
    saveUiState({ attachments: kept });
  }, [attachments]);

  // Host đọc xong một tệp tải lên: đổi chip "đang đọc" thành chip tệp (hoặc báo lỗi).
  useEffect(
    () =>
      bus.documentParsed.on(({ reqId, name, doc, error }) => {
        const r = readingRef.current.find((x) => x.id === reqId);
        if (!r) return; // người dùng đã bấm × (hoặc quá hạn) → bỏ kết quả
        stopReading(reqId);
        if (error || !doc) {
          toast('error', error || t('composer.doc.readFail', { name }));
          return;
        }
        const att: AttachmentInfo = { kind: 'doc', label: name, sizeBytes: r.size, doc };
        docSeq.set(att, reqId);
        setAttachments((prev) => {
          if (prev.some((p) => sameAttachment(p, att))) return prev;
          const at = prev.findIndex((p) => p.kind === 'doc' && (docSeq.get(p) ?? -1) > reqId); // chen trước tệp được chọn SAU nó
          return at < 0 ? [...prev, att] : [...prev.slice(0, at), att, ...prev.slice(at)];
        });
      }),
    [stopReading, t, toast],
  );

  // Khung chat đóng/đổi: huỷ các bộ đếm giờ còn treo.
  useEffect(
    () => () => {
      docTimers.current.forEach((timer) => window.clearTimeout(timer));
      docTimers.current.clear();
    },
    [],
  );

  // ── tìm tệp khi gõ @ ──
  const mentionQuery = mention?.query;
  const mentionOpen = mention !== null;
  useEffect(() => {
    if (!mentionOpen) {
      setFiles([]);
      setFilesBusy(false);
      return;
    }
    setFilesBusy(true);
    const timer = window.setTimeout(() => {
      const reqId = ++reqCounter.current;
      post({ type: 'search_files', reqId, query: mentionQuery ?? '' });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [mentionOpen, mentionQuery]);

  // ── hành động ──
  const clearAll = () => {
    const ta = taRef.current;
    if (ta) {
      ta.value = '';
      ta.style.height = 'auto';
    }
    setHasText(false);
    setAttachments([]);
    readingRef.current.forEach((r) => stopReading(r.id));
    setMention(null);
    setSlash(null);
    mentionPaths.current.clear();
    window.clearTimeout(draftTimer.current);
    saveUiState({ draft: '', attachments: [] });
  };

  const submit = () => {
    const ta = taRef.current;
    if (!ta || (running && !canQueue)) return;
    const text = ta.value.trim();
    const cmd = parseSlashCommand(text, view.slashCommands);
    if (cmd) {
      if (running) {
        toast('info', t('composer.queue.noCommand'));
        return;
      }
      post({ type: 'slash', command: cmd.command, args: cmd.args });
      clearAll();
      return;
    }
    if (readingRef.current.length > 0) {
      toast('info', t('composer.doc.wait'));
      return;
    }
    if (!text && attachments.length === 0) return;
    // Bỏ chip tệp tạo từ @mention mà người dùng đã xoá khỏi nội dung.
    const atts = attachments.filter((a) => !(a.path && mentionPaths.current.has(a.path)) || text.includes(`@${a.path}`));
    post({ type: 'send', text, attachments: atts });
    clearAll();
  };

  const pickMention = (hit: FileHit) => {
    const ta = taRef.current;
    if (!ta || !mention) return;
    const before = ta.value.slice(0, mention.start);
    const after = ta.value.slice(mention.end);
    if (hit.path.startsWith('tab:')) {
      // Tab trình duyệt: chỉ thêm chip đính kèm; chữ "@truy vấn" đang gõ được bỏ đi (không để lộ mã tab).
      addAttachment({ kind: 'tab', label: hit.name, path: hit.path });
      setMention(null);
      setTextValue(before + after.replace(/^s+/, ''), before.length);
      return;
    }
    const insert = `@${hit.path}${hit.isDir && !hit.path.endsWith('/') ? '/' : ''} `;
    mentionPaths.current.add(hit.path);
    addAttachment({ kind: hit.isDir ? 'folder' : 'file', label: hit.name, path: hit.path });
    setMention(null);
    setTextValue(before + insert + after.replace(/^\s+/, ''), (before + insert).length);
  };

  const pickSlash = (cmd: SlashCommandInfo, forceInsert = false) => {
    const name = cmd.name.replace(/^\//, '');
    setSlash(null);
    if (forceInsert || SLASH_COMMANDS_WITH_ARGS.has(name)) {
      setTextValue(`/${name} `);
    } else {
      post({ type: 'slash', command: name, args: '' });
      clearAll();
    }
  };

  const addImage = async (file: Blob, name?: string) => {
    if (file.size > MAX_IMAGE_BYTES) {
      toast('error', t('composer.imageTooBig'));
      return;
    }
    try {
      const data = await readFileAsBase64(file);
      imageCounter.current += 1;
      addAttachment({
        kind: 'image',
        label: name || t('composer.imageName', { n: imageCounter.current }),
        mediaType: file.type || 'image/png',
        data,
        sizeBytes: file.size,
        thumb: await makeThumb(file),
        imgKey: imageKey(data),
      });
    } catch {
      toast('error', t('composer.imageTooBig'));
    }
  };

  /** Tệp PDF/Word/Excel/HTML/CSV/TXT: đọc thành base64, nhờ host trích chữ (trả lời bằng `document_parsed`), trong lúc chờ hiện chip "đang đọc". */
  const addDocument = async (file: File) => {
    const name = file.name || t('composer.doc.unnamed');
    if (isLegacyOffice(name)) {
      toast('error', t('composer.doc.legacy', { name }));
      return;
    }
    if (!docKindOf(name)) {
      toast('error', t('composer.doc.unsupported', { name }));
      return;
    }
    if (file.size > MAX_DOC_BYTES) {
      toast('error', t('composer.doc.tooBig', { name, max: Math.round(MAX_DOC_BYTES / 1048576) }));
      return;
    }
    const have = attachments.filter((a) => a.kind === 'doc').length + readingRef.current.length;
    if (have >= MAX_DOCS_PER_MESSAGE) {
      toast('error', t('composer.doc.tooMany', { n: MAX_DOCS_PER_MESSAGE }));
      return;
    }
    const id = ++docReqCounter.current;
    updateReading((prev) => [...prev, { id, name, size: file.size }]);
    docTimers.current.set(
      id,
      window.setTimeout(() => {
        if (!readingRef.current.some((r) => r.id === id)) return;
        stopReading(id);
        toast('error', t('composer.doc.timeout', { name }));
      }, DOC_READ_TIMEOUT_MS),
    );
    try {
      const data = await readFileAsBase64(file);
      if (!readingRef.current.some((r) => r.id === id)) return; // người dùng đã bấm ×
      post({ type: 'parse_document', reqId: id, name, data });
    } catch {
      stopReading(id);
      toast('error', t('composer.doc.readFail', { name }));
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Bộ gõ đang ghép chữ (Telex/VNI/IME): để nguyên cho bộ gõ xử lý.
    if (e.isComposing || composing.current || e.keyCode === 229) return;

    // (lane:perm-rules) Shift+Tab xoay vòng chế độ quyền (default → acceptEdits → plan), như Claude Code; không áp khi menu @/ / đang mở.
    if (!menuOpen && isModeCycleKey(e)) {
      e.preventDefault();
      post({ type: 'set_mode', mode: nextMode(view.mode) });
      return;
    }

    if (menuOpen) {
      const count = mention ? files.length : slashItems.length;
      if (e.key === 'ArrowDown' && count > 0) {
        e.preventDefault();
        setActive((i) => (i + 1) % count);
        return;
      }
      if (e.key === 'ArrowUp' && count > 0) {
        e.preventDefault();
        setActive((i) => (i - 1 + count) % count);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (mention && files[active]) {
          e.preventDefault();
          pickMention(files[active]);
          return;
        }
        if (slash && slashItems[active]) {
          e.preventDefault();
          pickSlash(slashItems[active], e.key === 'Tab');
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        dismissed.current = mention ? { start: mention.start, query: mention.query } : { start: 0, query: slash?.query ?? '' };
        setMention(null);
        setSlash(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // Chặn thêm một nhịp sau khi bộ gõ chốt chữ (Safari/WebKit bắn keydown Enter sau compositionend).
      if (Date.now() - lastCompositionEnd.current < 40) return;
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Escape' && running) {
      e.preventDefault();
      post({ type: 'stop' });
      return;
    }
    if (e.key === 'ArrowUp' && !taRef.current?.value && attachments.length === 0 && !running) {
      e.preventDefault();
      post({ type: 'edit_last' });
    }
  };

  /** Một tệp người dùng đưa vào (chọn / kéo thả / dán): ảnh → đính kèm ảnh; PDF, Word, Excel… → đọc thành chữ; loại khác → báo không hỗ trợ. */
  const addFile = (f: File, fromPaste = false) => {
    if (f.type.startsWith('image/')) void addImage(f, fromPaste ? undefined : f.name);
    else void addDocument(f);
  };

  const onPaste = (e: ClipboardEvent) => {
    // Dán tệp (ảnh chụp màn hình, hoặc tệp chép từ trình quản lý tệp). Chữ thường dán như cũ.
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.kind === 'file')
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f && (f.type.startsWith('image/') || !!docKindOf(f.name) || isLegacyOffice(f.name)));
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) addFile(f, true);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    for (const f of Array.from(dt.files)) addFile(f);
    const folders = view.workspace?.folders ?? [];
    const uris = new Set<string>();
    const list = dt.getData('text/uri-list');
    if (list) list.split(/\r?\n/).forEach((u) => u && !u.startsWith('#') && uris.add(u));
    const res = dt.getData('resourceurls');
    if (res) {
      try {
        (JSON.parse(res) as string[]).forEach((u) => uris.add(u));
      } catch {
        /* bỏ qua */
      }
    }
    for (const u of uris) {
      const rel = relativizeUri(u, folders);
      if (rel) addAttachment({ kind: 'file', label: basename(rel), path: rel });
    }
  };

  const togglePicker = (id: PickerId) => setPicker((p) => (p === id ? null : id));
  const closePicker = useCallback(() => setPicker(null), []);

  const canSend = (hasText || attachments.length > 0) && reading.length === 0;
  const tabInfo = isBrowser ? view.browser?.tab ?? null : null;
  /** Tab người dùng đang xem khi khác tab trợ lý đã gắn (để gắn lại). */
  const viewingTab = isBrowser ? view.browser?.viewing ?? null : null;
  const editorChip = editor?.file
    ? [
        t('composer.editor.viewing', { file: basename(editor.file) }),
        editor.selection
          ? editor.selection.startLine === editor.selection.endLine
            ? t('composer.editor.line', { a: editor.selection.startLine })
            : t('composer.editor.lines', { a: editor.selection.startLine, b: editor.selection.endLine })
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div
      class={cx('composer', dropping && 'is-dropping')}
      onDragOver={(e) => {
        if (e.dataTransfer && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list') || e.dataTransfer.types.includes('resourceurls'))) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      {mention && <MentionMenu items={files} busy={filesBusy} active={active} onPick={pickMention} onHover={setActive} />}
      {slash && slashItems.length > 0 && <SlashMenu items={slashItems} active={active} onPick={(c) => pickSlash(c)} onHover={setActive} />}

      <div class="composer-card">
        {canQueue && queued.length > 0 && <QueueList items={queued} />}
        {(attachments.length > 0 || reading.length > 0 || editorChip || tabInfo) && (
          <div class="chip-row">
            {attachments.map((a, i) => (
              <AttachmentChip
                key={`${a.kind}:${a.path ?? attachmentText(a)}:${i}`}
                a={a}
                onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
              />
            ))}
            {reading.map((r) => (
              <span key={`reading:${r.id}`} class="chip chip-doc is-reading" title={r.name} aria-busy="true">
                <span class="chip-main">
                  <Spinner size={12} />
                  <span class="chip-text">{t('composer.doc.reading', { name: r.name })}</span>
                </span>
                <button type="button" class="chip-x" onClick={() => stopReading(r.id)} aria-label={t('composer.removeAttachment', { name: r.name })}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
            {tabInfo && (
              <span
                class={cx('chip', 'chip-editor', 'chip-tab', tabInfo.pinned && 'is-pinned', !tabInfo.readable && 'is-locked')}
                title={tabInfo.readable ? (tabInfo.pinned ? t('composer.tab.pinned.title') : t('composer.tab.title')) : t('composer.tab.locked')}
              >
                <button type="button" class="chip-main" onClick={() => (tabInfo.readable ? post({ type: 'refresh_tab' }) : openSettings())}>
                  <Icon name={tabInfo.readable ? (tabInfo.pinned ? 'link' : 'eye') : 'shield'} size={13} />
                  <span class="chip-text">
                    {tabInfo.readable ? t(tabInfo.pinned ? 'composer.tab.pinned' : 'composer.tab.viewing', { host: tabInfo.host }) : t('composer.tab.locked.short', { host: tabInfo.host })}
                  </span>
                </button>
                {tabInfo.pinned && (
                  <button type="button" class="chip-x" onClick={() => post({ type: 'unpin_tab' })} title={t('composer.tab.unpin')} aria-label={t('composer.tab.unpin')}>
                    <Icon name="x" size={12} />
                  </button>
                )}
              </span>
            )}
            {tabInfo?.pinned && viewingTab && (
              <span class="chip chip-plain chip-tab chip-pin-to" title={t('composer.tab.pinTo.title', { host: viewingTab.host })}>
                <button type="button" class="chip-main" onClick={() => post({ type: 'pin_tab' })}>
                  <Icon name="refresh" size={13} />
                  <span class="chip-text">{t('composer.tab.pinTo', { host: viewingTab.host })}</span>
                </button>
              </span>
            )}
            {editorChip && (
              <span class="chip chip-editor" title={t('composer.editor.title')}>
                <span class="chip-main">
                  <Icon name="eye" size={13} />
                  <span class="chip-text">{editorChip}</span>
                </span>
              </span>
            )}
          </div>
        )}

        <textarea
          ref={taRef}
          class="composer-input"
          rows={1}
          lang={lang}
          spellcheck={false}
          autocomplete="off"
          autocapitalize="off"
          aria-label={t(placeholderKey)}
          placeholder={running ? t(canQueue ? 'composer.placeholderQueue' : 'composer.placeholderBusy') : t(placeholderKey)}
          onInput={() => {
            autoGrow();
            setHasText((taRef.current?.value.trim().length ?? 0) > 0);
            persistDraft();
            refreshTriggers();
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (!['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) refreshTriggers();
          }}
          onClick={refreshTriggers}
          onPaste={onPaste}
        />

        <div class="composer-bar">
          <div class="bar-left">
            <button
              type="button"
              class="icon-btn bar-at"
              title="@"
              aria-label={t('composer.mention.hint')}
              onClick={() => {
                const ta = taRef.current;
                if (!ta) return;
                const pos = ta.selectionStart ?? ta.value.length;
                const lead = pos > 0 && !/\s$/.test(ta.value.slice(0, pos)) ? ' ' : '';
                setTextValue(ta.value.slice(0, pos) + lead + '@' + ta.value.slice(pos), pos + lead.length + 1);
                refreshTriggers();
              }}
            >
              <Icon name="at" size={16} />
            </button>
            <button
              type="button"
              class="icon-btn bar-attach"
              title={t('composer.dropHint')}
              aria-label={t('composer.dropHint')}
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="paperclip" size={16} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={`image/*,${DOC_ACCEPT}`}
              multiple
              hidden
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                Array.from(input.files ?? []).forEach((f) => addFile(f));
                input.value = '';
              }}
            />
            <ModelPicker view={view} open={picker === 'model'} onToggle={() => togglePicker('model')} onClose={closePicker} />
            <ModePicker view={view} open={picker === 'mode'} onToggle={() => togglePicker('mode')} onClose={closePicker} />
            <ThinkingPicker view={view} open={picker === 'think'} onToggle={() => togglePicker('think')} onClose={closePicker} />
            <SwarmToggle view={view} />
            <AgentChip view={view} />
          </div>
          <div class="bar-right">
            <ContextMeter view={view} open={picker === 'ctx'} onToggle={() => togglePicker('ctx')} onClose={closePicker} />
            {running && (
              <button type="button" class="send-btn is-stop" onClick={() => post({ type: 'stop' })} title={t('composer.stop')} aria-label={t('composer.stop')}>
                <Icon name="stop" size={16} />
              </button>
            )}
            {(!running || canQueue) && (
              <button
                type="button"
                class={cx('send-btn', running && 'is-queue')}
                disabled={!canSend}
                onClick={submit}
                title={running ? t('composer.queue') : t('composer.send')}
                aria-label={running ? t('composer.queue') : t('composer.send')}
              >
                <Icon name="send" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      {dropping && <div class="drop-hint">{t('composer.dropHint')}</div>}
    </div>
  );
}
