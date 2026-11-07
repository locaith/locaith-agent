import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { MAX_BACKUP_BYTES, TRASH_DAYS, type SessionSearchHit, type SessionSummary, type TrashSummary, type ViewState } from '../../../src/shared/protocol';
import { groupSessions } from '../../../src/shared/sessionGroups'; // (lane:sessions-ux)
import { useHistorySearch } from '../historySearch'; // (lane:sessions-ux)
import { useApp } from '../ctx';
import { formatRelativeTime } from '../format';
import { filterByQuery } from '../text';
import { cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icons';
import { Marked } from './Marked'; // (lane:sessions-ux)
import { Button, IconButton } from './ui';

const DAY_MS = 24 * 60 * 60 * 1000;

function SessionRow({
  s,
  current,
  now,
  onOpen,
  hit,
  selecting,
  picked,
  onPick,
}: {
  s: SessionSummary;
  current: boolean;
  now: number;
  onOpen: () => void;
  /** (lane:sessions-ux) Kết quả tìm toàn văn của cuộc này (trích đoạn + chữ khớp). */
  hit?: SessionSearchHit;
  /** (lane:sessions-ux) Đang ở chế độ chọn nhiều. */
  selecting?: boolean;
  picked?: boolean;
  onPick?: () => void;
}) {
  const { t, lang } = useApp();
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm'>('view');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'rename') {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [mode]);

  const save = () => {
    const v = inputRef.current?.value.trim();
    if (v && v !== s.title) post({ type: 'rename_session', id: s.id, title: v });
    setMode('view');
  };

  if (mode === 'rename') {
    return (
      <li class="hist-row is-editing">
        <input
          ref={inputRef}
          class="text-input"
          type="text"
          defaultValue={s.title}
          aria-label={t('hist.rename')}
          spellcheck={false}
          onKeyDown={(e) => {
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setMode('view');
            }
          }}
        />
        <IconButton icon="check" label={t('hist.save')} onClick={save} />
        <IconButton icon="x" label={t('hist.cancel')} onClick={() => setMode('view')} />
      </li>
    );
  }

  if (mode === 'confirm') {
    return (
      <li class="hist-row is-confirm" role="alert">
        <span class="hist-confirm-text">{t('hist.confirmDelete', { days: TRASH_DAYS })}</span>
        <button type="button" class="btn btn-danger btn-sm" onClick={() => post({ type: 'delete_session', id: s.id })}>
          <span class="btn-label">{t('hist.confirmYes')}</span>
        </button>
        <button type="button" class="btn btn-ghost btn-sm" onClick={() => setMode('view')}>
          <span class="btn-label">{t('hist.cancel')}</span>
        </button>
      </li>
    );
  }

  if (selecting) {
    // (lane:sessions-ux) chọn nhiều: cuộc đang mở không chọn được (xoá nó qua nút Xoá thường để app chuyển sang cuộc mới cho đúng).
    return (
      <li class={cx('hist-row', picked && 'is-picked')}>
        <input type="checkbox" class="hist-check" checked={!!picked} disabled={current} title={current ? t('sx.hist.noPick') : undefined} aria-label={s.title || t('app.untitled')} onChange={() => onPick?.()} />
        <button type="button" class="hist-main" disabled={current} onClick={() => onPick?.()}>
          <span class="hist-titlerow">
            <span class="hist-title">{s.title || t('app.untitled')}</span>
            {current && <span class="badge badge-accent">{t('hist.current')}</span>}
          </span>
          <span class="hist-meta">
            {s.model} · {t('hist.messages', { n: s.messageCount })} · {formatRelativeTime(s.updatedAt, now, lang)}
          </span>
        </button>
      </li>
    );
  }

  return (
    <li class={cx('hist-row', current && 'is-current')}>
      <button type="button" class="hist-main" onClick={onOpen}>
        <span class="hist-titlerow">
          {s.pinned && <Icon name="pin" size={12} class="hist-pinmark" />}
          <span class="hist-title">{s.title || t('app.untitled')}</span>
          {current && <span class="badge badge-accent">{t('hist.current')}</span>}
          {s.other && (
            <span class="badge" title={t('hist.others.hint')}>
              {s.workspaceName || t('hist.otherFolder')}
            </span>
          )}
        </span>
        <span class="hist-meta">
          {s.model} · {t('hist.messages', { n: s.messageCount })} · {formatRelativeTime(s.updatedAt, now, lang)}
          {hit && hit.count > 0 ? ` · ${t('sx.hist.hits', { n: hit.count })}` : ''}
        </span>
        {hit?.snippet && (
          <span class="hist-snippet">
            <Marked text={hit.snippet} marks={hit.marks} />
          </span>
        )}
      </button>
      <div class={cx('hist-actions', s.pinned && 'is-pinned')}>
        <IconButton icon="pin" label={s.pinned ? t('sx.hist.unpin') : t('sx.hist.pin')} active={!!s.pinned} onClick={() => post({ type: 'pin_session', id: s.id, pinned: !s.pinned })} size={14} />
        <IconButton icon="download" label={t('hist.backupOne')} onClick={() => post({ type: 'export_backup', id: s.id })} size={14} />
        <IconButton icon="pencil" label={t('hist.rename')} onClick={() => setMode('rename')} size={14} />
        <IconButton icon="trash" label={t('hist.delete')} onClick={() => setMode('confirm')} size={14} />
      </div>
    </li>
  );
}

/** Một cuộc trò chuyện trong Thùng rác: khôi phục, tải bản sao lưu, hoặc xoá vĩnh viễn (hỏi lại). */
function TrashRow({ s, now }: { s: TrashSummary; now: number }) {
  const { t, lang } = useApp();
  const [confirm, setConfirm] = useState(false);
  const daysLeft = Math.max(0, Math.ceil((s.deletedAt + TRASH_DAYS * DAY_MS - now) / DAY_MS));

  if (confirm) {
    return (
      <li class="hist-row is-confirm" role="alert">
        <span class="hist-confirm-text">{t('hist.purge.confirm')}</span>
        <button type="button" class="btn btn-danger btn-sm" onClick={() => post({ type: 'purge_session', id: s.id })}>
          <span class="btn-label">{t('hist.purge')}</span>
        </button>
        <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirm(false)}>
          <span class="btn-label">{t('hist.cancel')}</span>
        </button>
      </li>
    );
  }

  return (
    <li class="hist-row is-trashed">
      <div class="hist-main">
        <span class="hist-titlerow">
          <span class="hist-title">{s.title || t('app.untitled')}</span>
        </span>
        <span class="hist-meta">
          {t('hist.trash.deleted', { when: formatRelativeTime(s.deletedAt, now, lang) })} · {t('hist.trash.left', { n: daysLeft })} · {t('hist.messages', { n: s.messageCount })}
        </span>
      </div>
      <div class="hist-actions is-always">
        <IconButton icon="refresh" label={t('hist.restore')} onClick={() => post({ type: 'restore_session', id: s.id })} size={14} />
        <IconButton icon="download" label={t('hist.backupOne')} onClick={() => post({ type: 'export_backup', id: s.id })} size={14} />
        <IconButton icon="trash" label={t('hist.purge')} onClick={() => setConfirm(true)} size={14} />
      </div>
    </li>
  );
}

function TrashSection({ trash, now }: { trash: TrashSummary[]; now: number }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  if (trash.length === 0) return null;
  return (
    <section class="hist-trash" aria-label={t('hist.trash')}>
      <button type="button" class="hist-trash-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <Icon name="trash" size={14} />
        <span class="hist-trash-title">{t('hist.trash')}</span>
        <span class="badge">{trash.length}</span>
      </button>
      {open && (
        <>
          <p class="set-hint">{t('hist.trash.hint', { days: TRASH_DAYS })}</p>
          <ul class="hist-list">
            {trash.map((s) => (
              <TrashRow key={s.id} s={s} now={now} />
            ))}
          </ul>
          {confirmAll ? (
            <div class="hist-row is-confirm" role="alert">
              <span class="hist-confirm-text">{t('hist.emptyTrash.confirm', { n: trash.length })}</span>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                onClick={() => {
                  post({ type: 'empty_trash' });
                  setConfirmAll(false);
                }}
              >
                <span class="btn-label">{t('hist.purge')}</span>
              </button>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirmAll(false)}>
                <span class="btn-label">{t('hist.cancel')}</span>
              </button>
            </div>
          ) : (
            <div class="hist-trash-foot">
              <Button variant="ghost" small icon="trash" onClick={() => setConfirmAll(true)}>
                {t('hist.emptyTrash')}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

export function HistoryView({ view, onOpen }: { view: ViewState; onOpen: () => void }) {
  const { t, toast } = useApp();
  const [query, setQuery] = useState('');
  const search = useHistorySearch(query); // (lane:sessions-ux) tìm toàn văn, kết quả về dần
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const now = Date.now();
  const sorted = useMemo(() => [...view.sessions].sort((a, b) => b.updatedAt - a.updatedAt), [view.sessions]);
  const list = useMemo(() => {
    const local = filterByQuery(sorted, query, (s) => [s.title, s.model, s.provider]);
    if (!query.trim() || search.query !== query.trim() || search.hits.size === 0) return local;
    // (lane:sessions-ux) hợp kết quả lọc tại chỗ (tiêu đề/model) với kết quả toàn văn từ host, giữ thứ tự mới nhất trước.
    const ids = new Set(local.map((x) => x.id));
    return sorted.filter((x) => ids.has(x.id) || search.hits.has(x.id));
  }, [sorted, query, search]);
  const searching = query.trim().length > 0;
  const hitOf = (id: string) => (search.query === query.trim() ? search.hits.get(id) : undefined);
  const togglePick = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
    setConfirmBulk(false);
  };
  const hasAnything = view.sessions.length > 0 || view.trash.length > 0;
  const mine = list.filter((s) => !s.other);
  const others = list.filter((s) => s.other);
  const [showOthers, setShowOthers] = useState(false);
  const othersOpen = showOthers || mine.length === 0 || query.trim().length > 0;
  const renderRow = (s: SessionSummary) => (
    <SessionRow
      key={s.id}
      s={s}
      current={s.id === view.sessionId}
      now={now}
      onOpen={() => {
        post({ type: 'load_session', id: s.id });
        onOpen();
      }}
      hit={hitOf(s.id)}
      selecting={selecting}
      picked={picked.has(s.id)}
      onPick={() => togglePick(s.id)}
    />
  );

  /** Khôi phục từ tệp sao lưu: đọc chữ ở đây, host kiểm tra và chuẩn hoá rồi trả lời bằng thông báo. */
  const pickBackup = async (file: File) => {
    if (file.size > MAX_BACKUP_BYTES) {
      toast('error', t('hist.import.tooBig', { max: Math.round(MAX_BACKUP_BYTES / 1048576) }));
      return;
    }
    try {
      post({ type: 'import_backup', name: file.name, text: await file.text() });
    } catch {
      toast('error', t('hist.import.readFail'));
    }
  };

  return (
    <div class="screen screen-history">
      <div class="screen-search">
        <Icon name="search" size={15} />
        <input
          type="search"
          class="text-input text-input-bare"
          placeholder={t('hist.search')}
          aria-label={t('hist.search')}
          spellcheck={false}
          value={query}
          onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="hist-tools">
        <Button variant="outline" small icon="download" title={t('hist.backupAll.title')} disabled={!hasAnything} onClick={() => post({ type: 'export_backup' })}>
          {t('hist.backupAll')}
        </Button>
        <Button variant="outline" small icon="upload" title={t('hist.restoreFile.title')} onClick={() => fileRef.current?.click()}>
          {t('hist.restoreFile')}
        </Button>
        <Button variant="outline" small icon="check" disabled={view.sessions.length < 2} onClick={() => (selecting ? stopSelecting() : setSelecting(true))}>
          {selecting ? t('sx.hist.selectDone') : t('sx.hist.select')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const input = e.target as HTMLInputElement;
            const f = input.files?.[0];
            input.value = '';
            if (f) void pickBackup(f);
          }}
        />
      </div>
      <p class="set-hint hist-note">{t('hist.note')}</p>
      {searching && search.searching && <p class="hist-searching">{t('sx.hist.searching')}</p>}
      {selecting && (
        <div class="hist-bulk" role="group">
          {confirmBulk ? (
            <>
              <span class="hist-confirm-text">{t('sx.hist.deleteConfirm', { n: picked.size, days: TRASH_DAYS })}</span>
              <button
                type="button"
                class="btn btn-danger btn-sm"
                onClick={() => {
                  post({ type: 'delete_sessions', ids: [...picked] });
                  stopSelecting();
                }}
              >
                <span class="btn-label">{t('sx.hist.deleteN', { n: picked.size })}</span>
              </button>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirmBulk(false)}>
                <span class="btn-label">{t('hist.cancel')}</span>
              </button>
            </>
          ) : (
            <>
              <span class="hist-bulk-count">{t('sx.hist.selected', { n: picked.size })}</span>
              <Button variant="outline" small icon="trash" disabled={picked.size === 0} onClick={() => setConfirmBulk(true)}>
                {t('sx.hist.deleteN', { n: picked.size })}
              </Button>
            </>
          )}
        </div>
      )}

      {view.sessions.length === 0 ? (
        <div class="empty-state">
          <Icon name="history" size={28} />
          <p>{t('hist.empty')}</p>
        </div>
      ) : list.length === 0 ? (
        <div class="empty-state">
          <p>{t('hist.noMatch')}</p>
        </div>
      ) : (
        <>
          {mine.length > 0 &&
            (searching ? (
              <ul class="hist-list">{mine.map(renderRow)}</ul>
            ) : (
              // (lane:sessions-ux) nhóm theo ngày; đã ghim lên đầu
              groupSessions(mine, now).map((g) => (
                <section key={g.key} aria-label={t(`sx.hist.g.${g.key}`)}>
                  <h3 class="hist-group">{t(`sx.hist.g.${g.key}`)}</h3>
                  <ul class="hist-list">{g.items.map(renderRow)}</ul>
                </section>
              ))
            ))}
          {others.length > 0 && (
            <section class="hist-others" aria-label={t('hist.others')}>
              <button type="button" class="hist-trash-head" aria-expanded={othersOpen} onClick={() => setShowOthers((o) => !o)}>
                <Icon name={othersOpen ? 'chevron-down' : 'chevron-right'} size={14} />
                <Icon name="folder" size={14} />
                <span class="hist-trash-title">{t('hist.others')}</span>
                <span class="badge">{others.length}</span>
              </button>
              {othersOpen && (
                <>
                  <p class="set-hint">{t('hist.others.hint')}</p>
                  <ul class="hist-list">{others.map(renderRow)}</ul>
                </>
              )}
            </section>
          )}
        </>
      )}

      <TrashSection trash={view.trash ?? []} now={now} />
    </div>
  );
}
