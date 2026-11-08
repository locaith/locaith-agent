/**
 * Chia cÃƒÂ¡c khÃ¡Â»â€˜i cÃ¡Â»Â§a mÃ¡Â»â„¢t lÃ†Â°Ã¡Â»Â£t trÃ¡ÂºÂ£ lÃ¡Â»Âi thÃƒÂ nh cÃƒÂ¡c "Ã„â€˜oÃ¡ÂºÂ¡n" hiÃ¡Â»Æ’n thÃ¡Â»â€¹ (thuÃ¡ÂºÂ§n tÃƒÂºy, test Ã„â€˜Ã†Â°Ã¡Â»Â£c):
 *  - activity   : chuÃ¡Â»â€”i liÃ¡Â»Ân nhau gÃ¡Â»â€œm tÃƒÂ¡c vÃ¡Â»Â¥ / kÃ¡Â»Â¹ nÃ„Æ’ng / cÃƒÂ´ng cÃ¡Â»Â¥ / dÃƒÂ²ng trÃ¡ÂºÂ¡ng thÃƒÂ¡i / suy nghÃ„Â© (cÃƒÂ³ Ã„â€˜Ã†Â°Ã¡Â»Âng ray dÃ¡Â»Âc)
 *  - text       : vÃ„Æ’n bÃ¡ÂºÂ£n Markdown
 *  - artifact   : thÃ¡ÂºÂ» artifact
 *  - permission : thÃ¡ÂºÂ» xin quyÃ¡Â»Ân (nÃ¡Â»â€¢i bÃ¡ÂºÂ­t, nÃ¡ÂºÂ±m ngoÃƒÂ i Ã„â€˜Ã†Â°Ã¡Â»Âng ray)
 *  - notice     : thÃƒÂ´ng bÃƒÂ¡o / lÃ¡Â»â€”i
 *
 * GÃ¡Â»Ân khi nhiÃ¡Â»Âu viÃ¡Â»â€¡c chÃ¡ÂºÂ¡y cÃƒÂ¹ng lÃƒÂºc (0.6.0): mÃ¡Â»â„¢t chuÃ¡Â»â€”i Ã¢â€°Â¥ 3 lÃ¡Â»â€¡nh gÃ¡Â»Âi cÃƒÂ´ng cÃ¡Â»Â¥ liÃ¡Â»Ân nhau Ã¢â‚¬â€ Ã„â€˜ang chÃ¡ÂºÂ¡y hay Ã„â€˜ÃƒÂ£ xong, tÃƒÂªn nÃƒÂ o cÃ…Â©ng Ã„â€˜Ã†Â°Ã¡Â»Â£c Ã¢â‚¬â€ thÃƒÂ nh MÃ¡Â»ËœT dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t
 * thu gÃ¡Â»Ân (Ã‚Â«89 lÃ¡Â»â€¡nh gÃ¡Â»Âi cÃƒÂ´ng cÃ¡Â»Â¥ Ã‚Â· 1 lÃ¡Â»â€”iÃ‚Â», Ã„â€˜ang chÃ¡ÂºÂ¡y thÃƒÂ¬ kÃƒÂ¨m viÃ¡Â»â€¡c mÃ¡Â»â€ºi nhÃ¡ÂºÂ¥t); agent con Ã„â€˜ang chÃ¡ÂºÂ¡y luÃƒÂ´n cÃƒÂ³ dÃƒÂ²ng riÃƒÂªng vÃ¡Â»â€ºi sÃ¡Â»â€˜ liÃ¡Â»â€¡u sÃ¡Â»â€˜ng.
 * Khi lÃ†Â°Ã¡Â»Â£t Ã„â€˜ÃƒÂ£ xong, cÃƒÂ¡c dÃƒÂ²ng giÃ¡Â»â€˜ng nhau liÃ¡Â»Ân kÃ¡Â»Â cÃ…Â©ng Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃ¡Â»â„¢p lÃ¡ÂºÂ¡i (5 lÃ¡Â»â€¡nh tÃƒÂ¬m kiÃ¡ÂºÂ¿m Ã¢â€ â€™ 1 dÃƒÂ²ng mÃ¡Â»Å¸ rÃ¡Â»â„¢ng Ã„â€˜Ã†Â°Ã¡Â»Â£c).
 */
import type { ABlock, ToolBlock } from '../../src/shared/protocol';
import { AGENT_TOOLS, GROUPABLE, describeTool } from './toolLabels';

type Pick<T extends ABlock['type']> = Extract<ABlock, { type: T }>;
export type TextBlockT = Pick<'text'>;
export type ThinkingBlockT = Pick<'thinking'>;
export type PillBlockT = Pick<'pill'>;
export type TasksBlockT = Pick<'tasks'>;
export type SkillBlockT = Pick<'skill'>;
export type ArtifactBlockT = Pick<'artifact'>;
export type NoticeBlockT = Pick<'notice'>;

/** SÃ¡Â»â€˜ liÃ¡Â»â€¡u cÃ¡Â»Â§a dÃƒÂ²ng Ã‚Â«N lÃ¡Â»â€¡nh gÃ¡Â»Âi cÃƒÂ´ng cÃ¡Â»Â¥Ã‚Â». */
export interface ToolSummaryInfo {
  /** CÃƒÂ¡c lÃ¡Â»â€¡nh hiÃ¡Â»â€¡n ra khi mÃ¡Â»Å¸ rÃ¡Â»â„¢ng (khÃƒÂ´ng gÃ¡Â»â€œm agent con Ã„â€˜ang chÃ¡ÂºÂ¡y: chÃƒÂºng cÃƒÂ³ dÃƒÂ²ng riÃƒÂªng ngay bÃƒÂªn dÃ†Â°Ã¡Â»â€ºi). */
  blocks: ToolBlock[];
  /** TÃ¡Â»â€¢ng lÃ¡Â»â€¡nh gÃ¡Â»Âi, TÃƒÂNH CÃ¡ÂºÂ¢ lÃ¡Â»â€¡nh bÃƒÂªn trong agent con (nhÃ†Â° Ã‚Â«89 tool callsÃ‚Â» cÃ¡Â»Â§a Claude Code): sÃ¡Â»â€˜ khÃ¡Â»â€˜i + sÃ¡Â»â€˜ lÃ¡Â»â€¡nh agent con bÃƒÂ¡o vÃ¡Â»Â. */
  total: number;
  /** LÃ¡Â»â€¡nh lÃ¡Â»â€”i: khÃ¡Â»â€˜i lÃ¡Â»â€”i + lÃ¡Â»â€¡nh lÃ¡Â»â€”i bÃƒÂªn trong agent con. */
  failed: number;
  /** CÃƒÂ²n lÃ¡Â»â€¡nh nÃƒÂ o Ã„â€˜ang chÃ¡ÂºÂ¡y trong `blocks` khÃƒÂ´ng (Ã„â€˜ang chÃ¡ÂºÂ¡y Ã¢â€ â€™ hiÃ¡Â»â€¡n vÃƒÂ²ng quay + viÃ¡Â»â€¡c mÃ¡Â»â€ºi nhÃ¡ÂºÂ¥t). */
  running: boolean;
  /** LÃ¡Â»â€¡nh Ã„â€˜ang chÃ¡ÂºÂ¡y mÃ¡Â»â€ºi nhÃ¡ÂºÂ¥t (Ã„â€˜Ã¡Â»Æ’ hiÃ¡Â»â€¡n Ã‚Â«Ã„Âang Ã„â€˜Ã¡Â»Âc src/a.tsÃ¢â‚¬Â¦Ã‚Â» ngay trÃƒÂªn dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t). */
  latest?: ToolBlock;
  /** (lane:cc-timeline-ui) Phần của `total` thuộc agent đang chạy (có dòng riêng bên dưới) — để dòng gộp cả cụm không đếm hai lần. */
  liveCalls?: number;
}

export interface WorkStats {
  /** LÃ¡Â»â€¡nh gÃ¡Â»Âi cÃƒÂ´ng cÃ¡Â»Â¥ (tÃƒÂ­nh cÃ¡ÂºÂ£ lÃ¡Â»â€¡nh bÃƒÂªn trong agent con). */
  calls: number;
  failed: number;
  /** LÃ¡Â»â€¡nh sÃ¡Â»Â­a / tÃ¡ÂºÂ¡o tÃ¡Â»â€¡p. */
  edits: number;
  /** DÃƒÂ²ng khÃƒÂ´ng phÃ¡ÂºÂ£i cÃƒÂ´ng cÃ¡Â»Â¥: suy nghÃ„Â©, trÃ¡ÂºÂ¡ng thÃƒÂ¡i, tÃƒÂ¡c vÃ¡Â»Â¥, kÃ¡Â»Â¹ nÃ„Æ’ng. */
  steps: number;
  /** TÃ¡Â»Â« lÃƒÂºc bÃ¡ÂºÂ¯t Ã„â€˜Ã¡ÂºÂ§u lÃ†Â°Ã¡Â»Â£t tÃ¡Â»â€ºi lÃƒÂºc xong (hoÃ¡ÂºÂ·c tÃ¡Â»â€ºi lÃ¡Â»â€¡nh cÃƒÂ´ng cÃ¡Â»Â¥ cuÃ¡Â»â€˜i, vÃ¡Â»â€ºi phiÃƒÂªn cÃ…Â© khÃƒÂ´ng ghi lÃƒÂºc xong). */
  durationMs?: number;
}

export type ActivityRow =
  | { kind: 'tasks'; key: string; block: TasksBlockT }
  | { kind: 'skill'; key: string; block: SkillBlockT }
  | { kind: 'thinking'; key: string; block: ThinkingBlockT }
  | { kind: 'pill'; key: string; block: PillBlockT }
  | { kind: 'tool'; key: string; block: ToolBlock }
  | { kind: 'toolgroup'; key: string; name: string; blocks: ToolBlock[] }
  | { kind: 'toolsum'; key: string; info: ToolSummaryInfo }
  | { kind: 'agent'; key: string; block: ToolBlock }
  /** Ã¢â€°Â¥ 2 lÃ¡ÂºÂ§n sÃ¡Â»Â­a/tÃ¡ÂºÂ¡o tÃ¡Â»â€¡p liÃ¡Â»Ân nhau Ã„â€˜ÃƒÂ£ xong Ã¢â€ â€™ mÃ¡Â»â„¢t dÃƒÂ²ng Ã‚Â«Ã„ÂÃƒÂ£ sÃ¡Â»Â­a N tÃ¡Â»â€¡pÃ‚Â» (mÃ¡Â»Å¸ ra xem tÃ¡Â»Â«ng tÃ¡Â»â€¡p, Ã„â€˜Ã¡Â»Â§ diff). */
  | { kind: 'editgroup'; key: string; blocks: ToolBlock[] }
  /** CÃ¡ÂºÂ£ mÃ¡Â»â„¢t Ã‚Â«viÃ¡Â»â€¡cÃ‚Â» (khÃ¡Â»â€˜i tasks + mÃ¡Â»Âi thao tÃƒÂ¡c sau nÃƒÂ³ tÃ¡Â»â€ºi viÃ¡Â»â€¡c kÃ¡ÂºÂ¿ tiÃ¡ÂºÂ¿p) gÃ¡Â»â„¢p thÃƒÂ nh mÃ¡Â»â„¢t dÃƒÂ²ng. */
  | { kind: 'taskgroup'; key: string; title: string; rows: ActivityRow[]; stats: WorkStats }
  | { kind: 'pillrun'; key: string; blocks: PillBlockT[] };

export type Segment =
  | { kind: 'activity'; key: string; rows: ActivityRow[] }
  | { kind: 'text'; key: string; block: TextBlockT }
  | { kind: 'artifact'; key: string; block: ArtifactBlockT }
  | { kind: 'permission'; key: string; block: ToolBlock }
  | { kind: 'notice'; key: string; block: NoticeBlockT };

const MIN_GROUP = 3;

const SETTLED: ReadonlySet<ToolBlock['state']> = new Set(['done', 'error', 'denied', 'cancelled']);

/** Agent con / workflow Ã„ÂANG chÃ¡ÂºÂ¡y: cÃƒÂ³ dÃƒÂ²ng riÃƒÂªng vÃ¡Â»â€ºi sÃ¡Â»â€˜ liÃ¡Â»â€¡u sÃ¡Â»â€˜ng thay vÃƒÂ¬ lÃ¡ÂºÂ«n trong dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t. */
export function isLiveAgent(b: ToolBlock): boolean {
  return AGENT_TOOLS.has(b.name) && b.state === 'running';
}

/** SÃ¡Â»â€˜ liÃ¡Â»â€¡u agent cÃ¡Â»Â§a mÃ¡Â»â„¢t khÃ¡Â»â€˜i, Ã„â€˜ÃƒÂ£ lÃƒÂ m sÃ¡ÂºÂ¡ch (dÃ¡Â»Â¯ liÃ¡Â»â€¡u khÃƒÂ´i phÃ¡Â»Â¥c tÃ¡Â»Â« tÃ¡Â»â€¡p sao lÃ†Â°u cÃƒÂ³ thÃ¡Â»Æ’ sai kiÃ¡Â»Æ’u Ã¢â‚¬â€ khÃƒÂ´ng bao giÃ¡Â»Â Ã„â€˜Ã¡Â»Æ’ NaN lÃ¡Â»Ât lÃƒÂªn mÃƒÂ n hÃƒÂ¬nh). */
export function agentStats(b: ToolBlock): { tokens: number; tools: number; failed: number; activity: string } {
  const a = b.agent as Partial<NonNullable<ToolBlock['agent']>> | undefined;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return { tokens: n(a?.tokens), tools: n(a?.tools), failed: n(a?.failed), activity: typeof a?.activity === 'string' ? a.activity : '' };
}

/** TÃƒÂ³m tÃ¡ÂºÂ¯t mÃ¡Â»â„¢t chuÃ¡Â»â€”i lÃ¡Â»â€¡nh: `rest` lÃƒÂ  cÃƒÂ¡c lÃ¡Â»â€¡nh sÃ¡ÂºÂ½ nÃ¡ÂºÂ±m trong dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t, `live` lÃƒÂ  agent Ã„â€˜ang chÃ¡ÂºÂ¡y (chÃ¡Â»â€° Ã„â€˜Ã¡Â»Æ’ cÃ¡Â»â„¢ng vÃƒÂ o tÃ¡Â»â€¢ng). */
export function summarizeTools(rest: readonly ToolBlock[], live: readonly ToolBlock[] = [], turnLive = true): ToolSummaryInfo {
  const all = [...rest, ...live];
  // (lane:cc-timeline-ui) Như ảnh Claude Code «54 tool calls · 2 failed» + dòng agent «249 tools» riêng: tổng của dòng nhóm chỉ đếm lệnh
  // CỦA LƯỢT (agent con = 1 lệnh); số lệnh/lỗi bên trong agent hiện trên dòng agent, không cộng dồn vào đây nữa.
  const subTools = 0;
  const subFailed = 0;
  // LÃ†Â°Ã¡Â»Â£t khÃƒÂ´ng cÃƒÂ²n chÃ¡ÂºÂ¡y (phiÃƒÂªn lÃ†Â°u giÃ¡Â»Â¯a chÃ¡Â»Â«ng): khÃ¡Â»â€˜i cÃƒÂ²n ghi 'running' lÃƒÂ  dÃ¡Â»Â¯ liÃ¡Â»â€¡u cÃ…Â© Ã¢â‚¬â€ khÃƒÂ´ng vÃƒÂ²ng quay, khÃƒÂ´ng Ã‚Â«Ã„â€˜ang lÃƒÂ mÃ‚Â».
  const running = turnLive ? rest.filter((b) => b.state === 'running') : [];
  const liveCalls = live.length;
  return {
    blocks: rest.slice(),
    total: all.length + subTools,
    failed: all.filter((b) => b.state === 'error').length + subFailed,
    running: running.length > 0,
    latest: running[running.length - 1],
    ...(liveCalls ? { liveCalls } : {}),
  };
}

/** LÃ¡Â»â€¡nh sÃ¡Â»Â­a tÃ¡Â»â€¡p (cÃƒÂ³ diff): luÃƒÂ´n hiÃ¡Â»â€¡n tÃ¡Â»Â«ng dÃƒÂ²ng riÃƒÂªng vÃ¡Â»â€ºi sÃ¡Â»â€˜ dÃƒÂ²ng thÃƒÂªm/bÃ¡Â»â€ºt Ã¢â‚¬â€ thay Ã„â€˜Ã¡Â»â€¢i trÃƒÂªn tÃ¡Â»â€¡p lÃƒÂ  kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ quan trÃ¡Â»Âng nhÃ¡ÂºÂ¥t, khÃƒÂ´ng gÃ¡ÂºÂ¥p vÃƒÂ o dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t (vÃƒÂ  tÃƒÂ¡ch cÃƒÂ¡c chuÃ¡Â»â€”i lÃ¡Â»â€¡nh Ã¡Â»Å¸ hai bÃƒÂªn thÃƒÂ nh hai dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t). */
export function isFileChange(b: ToolBlock): boolean {
  return !!b.diff || b.name === 'edit_file' || b.name === 'write_file';
}

const toolRowOf = (b: ToolBlock): ActivityRow => ({ kind: 'tool', key: b.id, block: b });
const agentRowOf = (b: ToolBlock): ActivityRow => ({ kind: 'agent', key: `agent:${b.id}`, block: b });

/** GÃ¡Â»â„¢p cÃƒÂ¡c dÃƒÂ²ng cÃƒÂ´ng cÃ¡Â»Â¥ liÃ¡Â»Ân kÃ¡Â»Â CÃƒâ„¢NG TÃƒÅ N gÃ¡Â»â„¢p Ã„â€˜Ã†Â°Ã¡Â»Â£c vÃƒÂ  Ã„â€˜ÃƒÂ£ xong (Ã¢â€°Â¥ 3) thÃƒÂ nh mÃ¡Â»â„¢t dÃƒÂ²ng Ã‚Â«Ã„ÂÃƒÂ£ Ã„â€˜Ã¡Â»Âc 5 tÃ¡Â»â€¡pÃ‚Â». */
function groupSameName(rows: ActivityRow[]): ActivityRow[] {
  const out: ActivityRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === 'tool' && GROUPABLE.has(row.block.name)) {
      let j = i;
      while (
        j < rows.length &&
        rows[j].kind === 'tool' &&
        (rows[j] as { block: ToolBlock }).block.name === row.block.name &&
        SETTLED.has((rows[j] as { block: ToolBlock }).block.state)
      )
        j++;
      if (j - i >= MIN_GROUP) {
        const blocks = rows.slice(i, j).map((r) => (r as { block: ToolBlock }).block);
        out.push({ kind: 'toolgroup', key: `group:${blocks[0].id}`, name: row.block.name, blocks });
        i = j;
        continue;
      }
    }
    out.push(row);
    i++;
  }
  return out;
}

/** CÃƒÂ¡c dÃƒÂ²ng hiÃ¡Â»â€¡n ra khi mÃ¡Â»Å¸ rÃ¡Â»â„¢ng dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t: tÃ¡Â»Â«ng lÃ¡Â»â€¡nh, vÃƒÂ  nhÃ¡Â»Â¯ng chuÃ¡Â»â€”i cÃƒÂ¹ng tÃƒÂªn Ã„â€˜ÃƒÂ£ xong vÃ¡ÂºÂ«n gÃ¡Â»â„¢p nhÃ†Â° trÃ†Â°Ã¡Â»â€ºc. */
export function nestedRows(blocks: readonly ToolBlock[]): ActivityRow[] {
  return groupSameName(blocks.map(toolRowOf));
}

/** MÃ¡Â»â„¢t chuÃ¡Â»â€”i lÃ¡Â»â€¡nh liÃ¡Â»Ân nhau (khÃƒÂ´ng cÃƒÂ³ thÃ¡ÂºÂ» xin phÃƒÂ©p chen giÃ¡Â»Â¯a) Ã¢â€ â€™ cÃƒÂ¡c dÃƒÂ²ng hiÃ¡Â»Æ’n thÃ¡Â»â€¹. */
function condenseRun(run: ToolBlock[], turnDone: boolean, turnLive: boolean): ActivityRow[] {
  const isLive = (b: ToolBlock): boolean => turnLive && isLiveAgent(b);
  const live = run.filter(isLive);
  const rest = run.filter((b) => !isLive(b));
  if (rest.length >= MIN_GROUP) {
    // CÃ¡ÂºÂ£ chuÃ¡Â»â€”i cÃƒÂ¹ng mÃ¡Â»â„¢t cÃƒÂ´ng cÃ¡Â»Â¥ gÃ¡Â»â„¢p Ã„â€˜Ã†Â°Ã¡Â»Â£c vÃƒÂ  Ã„â€˜ÃƒÂ£ xong, lÃ†Â°Ã¡Â»Â£t Ã„â€˜ÃƒÂ£ kÃ¡ÂºÂ¿t thÃƒÂºc: giÃ¡Â»Â¯ dÃƒÂ²ng cÃ…Â© Ã‚Â«Ã„ÂÃƒÂ£ Ã„â€˜Ã¡Â»Âc 5 tÃ¡Â»â€¡pÃ‚Â» (nhÃƒÂ£n cÃ¡Â»Â¥ thÃ¡Â»Æ’ hÃ†Â¡n Ã‚Â«5 lÃ¡Â»â€¡nh gÃ¡Â»Âi cÃƒÂ´ng cÃ¡Â»Â¥Ã‚Â»).
    const homogeneous = turnDone && live.length === 0 && rest.every((b) => b.name === rest[0].name && GROUPABLE.has(b.name) && SETTLED.has(b.state));
    const head: ActivityRow = homogeneous
      ? { kind: 'toolgroup', key: `group:${rest[0].id}`, name: rest[0].name, blocks: rest }
      : { kind: 'toolsum', key: `sum:${rest[0].id}`, info: summarizeTools(rest, live, turnLive) };
    return [head, ...live.map(agentRowOf)];
  }
  // DÃ†Â°Ã¡Â»â€ºi ngÃ†Â°Ã¡Â»Â¡ng: giÃ¡Â»Â¯ nguyÃƒÂªn thÃ¡Â»Â© tÃ¡Â»Â±, nhÃ†Â°ng agent Ã„â€˜ang chÃ¡ÂºÂ¡y vÃ¡ÂºÂ«n lÃƒÂ  dÃƒÂ²ng sÃ¡Â»â€˜ng.
  return run.map((b) => (isLive(b) ? agentRowOf(b) : toolRowOf(b)));
}

/**
 * CÃƒÂ¡c dÃƒÂ²ng giÃ¡Â»â€˜ng nhau liÃ¡Â»Ân kÃ¡Â»Â Ã¢â€ â€™ mÃ¡Â»â„¢t dÃƒÂ²ng. CÃƒÂ´ng cÃ¡Â»Â¥: luÃƒÂ´n (kÃ¡Â»Æ’ cÃ¡ÂºÂ£ Ã„â€˜ang chÃ¡ÂºÂ¡y); dÃƒÂ²ng trÃ¡ÂºÂ¡ng thÃƒÂ¡i Ã„â€˜ÃƒÂ£ xong: chÃ¡Â»â€° khi lÃ†Â°Ã¡Â»Â£t Ã„â€˜ÃƒÂ£ xong
 * (lÃƒÂºc Ã„â€˜ang chÃ¡ÂºÂ¡y vÃ¡ÂºÂ«n thÃ¡ÂºÂ¥y tÃ¡Â»Â«ng dÃƒÂ²ng hiÃ¡Â»â€¡n ra).
 */
const COUNTABLE = new Set<ActivityRow['kind']>(['tool', 'toolgroup', 'toolsum', 'editgroup', 'agent', 'pill', 'pillrun', 'thinking', 'skill']);

/** ThÃ¡Â»â€˜ng kÃƒÂª nhanh sÃ¡Â»â€˜ lÃ¡Â»â€¡nh cÃ¡Â»Â§a mÃ¡Â»â„¢t cÃ¡Â»Â¥m dÃƒÂ²ng. */
function statsOf(rows: readonly ActivityRow[]): WorkStats {
  const s: WorkStats = { calls: 0, failed: 0, edits: 0, steps: 0 };
  for (const r of rows) rowStats(r, s);
  return s;
}

/**
 * MÃ¡Â»â„¢t khÃ¡Â»â€˜i `tasks` mÃ¡Â»Å¸ ra mÃ¡Â»â„¢t Ã‚Â«viÃ¡Â»â€¡cÃ‚Â»: mÃ¡Â»Âi dÃƒÂ²ng hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng sau nÃƒÂ³ (tÃ¡Â»â€ºi viÃ¡Â»â€¡c kÃ¡ÂºÂ¿ tiÃ¡ÂºÂ¿p) thuÃ¡Â»â„¢c viÃ¡Â»â€¡c Ã„â€˜ÃƒÂ³. Khi viÃ¡Â»â€¡c cÃƒÂ³ Ã¢â€°Â¥ 2 lÃ¡Â»â€¡nh gÃ¡Â»Âi cÃƒÂ´ng cÃ¡Â»Â¥,
 * gÃ¡Â»â„¢p cÃ¡ÂºÂ£ cÃ¡Â»Â¥m thÃƒÂ nh MÃ¡Â»ËœT dÃƒÂ²ng Ã‚Â«ViÃ¡Â»â€¡c: Ã¢â‚¬Â¦Ã‚Â» (mÃ¡Â»Å¸ ra vÃ¡ÂºÂ«n Ã„â€˜Ã¡Â»Â§ tÃ¡Â»Â«ng dÃƒÂ²ng nhÃ†Â° cÃ…Â©) Ã¢â‚¬â€ nhÃ†Â° Claude Code. ViÃ¡Â»â€¡c lÃ¡ÂºÂ» mÃ¡Â»â„¢t lÃ¡Â»â€¡nh thÃƒÂ¬ Ã„â€˜Ã¡Â»Æ’ nguyÃƒÂªn.
 */
function groupByTask(rows: ActivityRow[]): ActivityRow[] {
  const out: ActivityRow[] = [];
  let cur: Extract<ActivityRow, { kind: 'taskgroup' }> | null = null;
  const close = () => {
    if (!cur) return;
    const tools = statsOf(cur.rows.slice(1));
    if (tools.calls >= 2) out.push({ ...cur, stats: tools });
    else out.push(...cur.rows);
    cur = null;
  };
  for (const r of rows) {
    if (r.kind === 'tasks') {
      close();
      cur = { kind: 'taskgroup', key: `task:${r.block.id}`, title: r.block.added[r.block.added.length - 1] ?? '', rows: [r], stats: { calls: 0, failed: 0, edits: 0, steps: 0 } };
      continue;
    }
    if (cur && COUNTABLE.has(r.kind)) {
      cur.rows.push(r);
      continue;
    }
    close();
    out.push(r);
  }
  close();
  return out;
}

function condense(rows: ActivityRow[], turnDone: boolean, turnLive: boolean): ActivityRow[] {
  const out: ActivityRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (row.kind === 'tool' && row.block.state !== 'awaiting_permission' && !isFileChange(row.block)) {
      const run: ToolBlock[] = [];
      let j = i;
      while (j < rows.length) {
        const r = rows[j];
        if (r.kind !== 'tool' || r.block.state === 'awaiting_permission' || isFileChange(r.block)) break; // thÃ¡ÂºÂ» chÃ¡Â»Â duyÃ¡Â»â€¡t vÃƒÂ  lÃ¡Â»â€¡nh sÃ¡Â»Â­a tÃ¡Â»â€¡p luÃƒÂ´n nÃ¡ÂºÂ±m ngoÃƒÂ i chuÃ¡Â»â€”i
        run.push(r.block);
        j++;
      }
      out.push(...condenseRun(run, turnDone, turnLive));
      i = j;
      continue;
    }
    // CÃ¡Â»Â¥m sÃ¡Â»Â­a tÃ¡Â»â€¡p liÃ¡Â»Ân nhau: Ã„â€˜ang chÃ¡ÂºÂ¡y thÃƒÂ¬ tÃƒÂ¡ch riÃƒÂªng Ã„â€˜Ã¡Â»Æ’ vÃ¡ÂºÂ«n thÃ¡ÂºÂ¥y tiÃ¡ÂºÂ¿n Ã„â€˜Ã¡Â»â„¢, phÃ¡ÂºÂ§n Ã„â€˜ÃƒÂ£ xong Ã¢â€°Â¥ 2 thÃƒÂ¬ gÃ¡Â»â„¢p mÃ¡Â»â„¢t dÃƒÂ²ng.
    if (row.kind === 'tool' && isFileChange(row.block)) {
      let j = i;
      while (j < rows.length && rows[j].kind === 'tool' && isFileChange((rows[j] as { block: ToolBlock }).block)) j++;
      const blocks = rows.slice(i, j).map((r) => (r as { block: ToolBlock }).block);
      const settled = blocks.filter((b) => SETTLED.has(b.state));
      const live = blocks.filter((b) => !SETTLED.has(b.state));
      if (settled.length >= 2) out.push({ kind: 'editgroup', key: `edits:${settled[0].id}`, blocks: settled });
      else for (const b of settled) out.push(toolRowOf(b));
      for (const b of live) out.push(toolRowOf(b));
      i = j;
      continue;
    }
    if (turnDone && row.kind === 'pill') {
      let j = i;
      while (j < rows.length && rows[j].kind === 'pill' && !(rows[j] as { block: PillBlockT }).block.active) j++;
      if (j - i >= MIN_GROUP) {
        const blocks = rows.slice(i, j).map((r) => (r as { block: PillBlockT }).block);
        out.push({ kind: 'pillrun', key: `pills:${blocks[0].id}`, blocks });
        i = j;
        continue;
      }
    }
    out.push(row);
    i++;
  }
  return groupByTask(out);
}

/**
 * `turnLive`: lÃ†Â°Ã¡Â»Â£t nÃƒÂ y Ã„â€˜ang thÃ¡ÂºÂ­t sÃ¡Â»Â± chÃ¡ÂºÂ¡y (mÃ¡ÂºÂ·c Ã„â€˜Ã¡Â»â€¹nh = chÃ†Â°a xong). Khi sai, khÃ¡Â»â€˜i agent cÃƒÂ²n ghi 'running' lÃƒÂ  dÃ¡Â»Â¯ liÃ¡Â»â€¡u cÃ…Â© vÃƒÂ  khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c thÃƒÂ nh dÃƒÂ²ng sÃ¡Â»â€˜ng.
 */
export function buildSegments(blocks: readonly ABlock[], turnDone: boolean, showThinking: boolean, turnLive: boolean = !turnDone): Segment[] {
  const segments: Segment[] = [];
  let rows: ActivityRow[] = [];

  const flush = () => {
    if (rows.length === 0) return;
    // KhoÃƒÂ¡ Ã„â€˜oÃ¡ÂºÂ¡n lÃ¡ÂºÂ¥y tÃ¡Â»Â« dÃƒÂ²ng NGUÃ¡Â»â€™N Ã„â€˜Ã¡ÂºÂ§u tiÃƒÂªn (khÃƒÂ´ng phÃ¡ÂºÂ£i dÃƒÂ²ng sau khi gÃ¡Â»â„¢p): chuÃ¡Â»â€”i lÃ¡Â»â€¡nh Ã„â€˜Ã¡Â»â€¢i tÃ¡Â»Â« Ã‚Â«tÃ¡Â»Â«ng dÃƒÂ²ngÃ‚Â» sang Ã‚Â«dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯tÃ‚Â» khi Ã„â€˜Ã¡Â»Â§ 3 lÃ¡Â»â€¡nh thÃƒÂ¬ cÃ¡ÂºÂ£ Ã„â€˜oÃ¡ÂºÂ¡n
    // khÃƒÂ´ng bÃ¡Â»â€¹ dÃ¡Â»Â±ng lÃ¡ÂºÂ¡i (mÃ¡ÂºÂ¥t trÃ¡ÂºÂ¡ng thÃƒÂ¡i mÃ¡Â»Å¸/Ã„â€˜ÃƒÂ³ng cÃ¡Â»Â§a cÃƒÂ¡c dÃƒÂ²ng suy nghÃ„Â© trong Ã„â€˜ÃƒÂ³).
    const firstKey = rows[0].key;
    const final = condense(rows, turnDone, turnLive);
    segments.push({ kind: 'activity', key: `act:${firstKey}`, rows: final });
    rows = [];
  };

  for (const b of blocks) {
    switch (b.type) {
      case 'text':
        flush();
        segments.push({ kind: 'text', key: b.id, block: b });
        break;
      case 'artifact':
        flush();
        segments.push({ kind: 'artifact', key: b.id, block: b });
        break;
      case 'notice':
        flush();
        segments.push({ kind: 'notice', key: b.id, block: b });
        break;
      case 'tasks':
        rows.push({ kind: 'tasks', key: b.id, block: b });
        break;
      case 'skill':
        rows.push({ kind: 'skill', key: b.id, block: b });
        break;
      case 'pill':
        rows.push({ kind: 'pill', key: b.id, block: b });
        break;
      case 'thinking':
        if (showThinking && b.text.trim()) rows.push({ kind: 'thinking', key: b.id, block: b });
        break;
      case 'tool': {
        if (b.state === 'awaiting_permission' && b.permission) {
          flush();
          segments.push({ kind: 'permission', key: `perm:${b.id}`, block: b });
        } else if (!describeTool('vi', b.name, b.args, b.state).hidden) {
          rows.push({ kind: 'tool', key: b.id, block: b });
        }
        break;
      }
    }
  }
  flush();
  return segments;
}

// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// (0.6.3) LÃ†Â°Ã¡Â»Â£t Ã„â€˜ÃƒÂ£ xong: gÃ¡ÂºÂ¥p Ã‚Â«quÃƒÂ¡ trÃƒÂ¬nh lÃƒÂ m viÃ¡Â»â€¡cÃ‚Â» thÃƒÂ nh mÃ¡Â»â„¢t dÃƒÂ²ng
// Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

export interface WorkSplit {
  /** CÃƒÂ¡c Ã„â€˜oÃ¡ÂºÂ¡n Ã„â€˜Ã†Â°Ã¡Â»Â£c gÃ¡ÂºÂ¥p, Ã„â€˜ÃƒÂºng thÃ¡Â»Â© tÃ¡Â»Â± gÃ¡Â»â€˜c: dÃƒÂ²ng hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng, Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ xen giÃ¡Â»Â¯a, thÃƒÂ´ng bÃƒÂ¡o thÃ†Â°Ã¡Â»Âng. */
  work: Segment[];
  /** KÃ¡ÂºÂ¿t quÃ¡ÂºÂ£ nÃ¡ÂºÂ±m giÃ¡Â»Â¯a quÃƒÂ¡ trÃƒÂ¬nh nhÃ†Â°ng KHÃƒâ€NG gÃ¡ÂºÂ¥p: thÃ¡ÂºÂ» artifact, thÃ¡ÂºÂ» xin phÃƒÂ©p, thÃƒÂ´ng bÃƒÂ¡o lÃ¡Â»â€”i/cÃ¡ÂºÂ£nh bÃƒÂ¡o. */
  kept: Segment[];
  /** CÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi cuÃ¡Â»â€˜i: **dÃƒÂ£y** Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ Ã¡Â»Å¸ cuÃ¡Â»â€˜i lÃ†Â°Ã¡Â»Â£t (kÃƒÂ¨m artifact/thÃƒÂ´ng bÃƒÂ¡o thÃ†Â°Ã¡Â»Âng xen trong dÃƒÂ£y), khÃƒÂ´ng chÃ¡Â»â€° Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ cuÃ¡Â»â€˜i. */
  tail: Segment[];
  stats: WorkStats;
  /**
   * TÃ¡Â»â€¡p Ã„â€˜ÃƒÂ£ sÃ¡Â»Â­a / tÃ¡ÂºÂ¡o thÃƒÂ nh cÃƒÂ´ng (dÃƒÂ²ng cÃƒÂ³ diff, bÃ¡ÂºÂ¥m Ã„â€˜Ã¡Â»Æ’ xem thay Ã„â€˜Ã¡Â»â€¢i) Ã¢â‚¬â€ cÃ…Â©ng lÃƒÂ  KÃ¡ÂºÂ¾T QUÃ¡ÂºÂ¢ nÃƒÂªn vÃ¡ÂºÂ«n hiÃ¡Â»â€¡n ngay dÃ†Â°Ã¡Â»â€ºi dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t khi Ã„â€˜ang gÃ¡ÂºÂ¥p.
   * null khi khÃƒÂ´ng sÃ¡Â»Â­a tÃ¡Â»â€¡p nÃƒÂ o hoÃ¡ÂºÂ·c sÃ¡Â»Â­a quÃƒÂ¡ nhiÃ¡Â»Âu (> MAX_CHANGE_ROWS: chÃ¡Â»â€° cÃƒÂ²n con sÃ¡Â»â€˜ Ã‚Â«sÃ¡Â»Â­a N tÃ¡Â»â€¡pÃ‚Â» trÃƒÂªn dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t).
   */
  changes: Segment | null;
}

/** QuÃƒÂ¡ sÃ¡Â»â€˜ dÃƒÂ²ng sÃ¡Â»Â­a tÃ¡Â»â€¡p nÃƒÂ y thÃƒÂ¬ khÃƒÂ´ng bÃƒÂ y ra ngoÃƒÂ i dÃƒÂ²ng tÃƒÂ³m tÃ¡ÂºÂ¯t nÃ¡Â»Â¯a. */
export const MAX_CHANGE_ROWS = 6;

function rowStats(r: ActivityRow, s: WorkStats): void {
  switch (r.kind) {
    case 'tool':
      s.calls++;
      if (r.block.state === 'error') s.failed++;
      if (isFileChange(r.block)) s.edits++;
      return;
    case 'toolgroup':
      s.calls += r.blocks.length;
      s.failed += r.blocks.filter((b) => b.state === 'error').length;
      s.edits += r.blocks.filter(isFileChange).length;
      return;
    case 'toolsum':
      // (lane:cc-timeline-ui) agent đang chạy có dòng 'agent' riêng trong cùng cụm → đã đếm ở đó, không cộng lại ở đây.
      s.calls += r.info.total - (r.info.liveCalls ?? 0);
      s.failed += r.info.failed;
      s.edits += r.info.blocks.filter(isFileChange).length;
      return;
    case 'agent':
      // (lane:cc-timeline-ui) agent con = MỘT lệnh của lượt; lệnh/lỗi bên trong hiện trên dòng agent riêng.
      s.calls += 1;
      s.failed += r.block.state === 'error' ? 1 : 0;
      return;
    case 'editgroup':
      s.calls += r.blocks.length;
      s.edits += r.blocks.length;
      s.failed += r.blocks.filter((b) => b.state === 'error').length;
      return;
    case 'taskgroup':
      for (const x of r.rows) rowStats(x, s);
      return;
    case 'pillrun':
      s.steps += r.blocks.length;
      return;
    default:
      s.steps++;
  }
}

/** ThÃ¡Â»Âi gian lÃƒÂ m viÃ¡Â»â€¡c: lÃƒÂºc xong nÃ¡ÂºÂ¿u cÃƒÂ³, khÃƒÂ´ng thÃƒÂ¬ lÃƒÂºc lÃ¡Â»â€¡nh cÃƒÂ´ng cÃ¡Â»Â¥ cuÃ¡Â»â€˜i xong. DÃ¡Â»Â¯ liÃ¡Â»â€¡u vÃƒÂ´ lÃƒÂ½ (Ã„â€˜Ã¡Â»â€œng hÃ¡Â»â€œ lÃ¡Â»â€¡ch, khÃ¡Â»â€˜i cÃ…Â© startedAt = 0) Ã¢â€ â€™ bÃ¡Â»Â. */
export function workDuration(blocks: readonly ABlock[], startedAt: number, endedAt?: number): number | undefined {
  if (!Number.isFinite(startedAt) || startedAt <= 0) return undefined;
  let end = typeof endedAt === 'number' && Number.isFinite(endedAt) ? endedAt : 0;
  if (!end) {
    for (const b of blocks) {
      if (b.type !== 'tool' || !Number.isFinite(b.startedAt) || b.startedAt < startedAt - 2000 || b.startedAt - startedAt > 12 * 3600_000) continue;
      end = Math.max(end, b.startedAt + Math.max(0, Number(b.durationMs) || 0));
    }
  }
  const d = end - startedAt;
  return d >= 1000 && d < 24 * 3600_000 ? d : undefined;
}

/**
 * Ã„ÂoÃ¡ÂºÂ¡n chÃ¡Â»Â¯ dÃƒÂ i tÃ¡Â»Â« mÃ¡Â»Â©c nÃƒÂ y Ã„â€˜Ã†Â°Ã¡Â»Â£c coi lÃƒÂ  CÃƒâ€šU TRÃ¡ÂºÂ¢ LÃ¡Â»Å“I, khÃƒÂ´ng phÃ¡ÂºÂ£i lÃ¡Â»Âi dÃ¡ÂºÂ«n Ã¢â‚¬â€ KHÃƒâ€NG BAO GIÃ¡Â»Å“ bÃ¡Â»â€¹ gÃ¡ÂºÂ¥p.
 * LÃƒÂ½ do: model thÃ†Â°Ã¡Â»Âng viÃ¡ÂºÂ¿t cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§, rÃ¡Â»â€œi gÃ¡Â»Âi thÃƒÂªm cÃƒÂ´ng cÃ¡Â»Â¥ (cÃ¡ÂºÂ­p nhÃ¡ÂºÂ­t viÃ¡Â»â€¡c, kiÃ¡Â»Æ’m tra), rÃ¡Â»â€œi chÃ¡Â»â€˜t mÃ¡Â»â„¢t cÃƒÂ¢u ngÃ¡ÂºÂ¯n.
 * NÃ¡ÂºÂ¿u chÃ¡Â»â€° giÃ¡Â»Â¯ Ã‚Â«dÃƒÂ£y chÃ¡Â»Â¯ cuÃ¡Â»â€˜iÃ‚Â» thÃƒÂ¬ cÃƒÂ¢u ngÃ¡ÂºÂ¯n hiÃ¡Â»â€¡n ra cÃƒÂ²n cÃ¡ÂºÂ£ cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi nÃ¡ÂºÂ±m trong Ã‚Â«Worked forÃ‚Â».
 */
export const LONG_ANSWER_CHARS = 280;

/**
 * GÃ¡ÂºÂ¥p phÃ¡ÂºÂ§n quÃƒÂ¡ trÃƒÂ¬nh cÃ¡Â»Â§a mÃ¡Â»â„¢t lÃ†Â°Ã¡Â»Â£t Ã„ÂÃƒÆ’ XONG (nhÃ†Â° Ã‚Â«Worked for 2m 13sÃ‚Â» cÃ¡Â»Â§a Codex): mÃ¡Â»Âi thÃ¡Â»Â© trÃ†Â°Ã¡Â»â€ºc VÃƒâ„¢NG CÃƒâ€šU TRÃ¡ÂºÂ¢ LÃ¡Â»Å“I Ã¢â‚¬â€
 * dÃƒÂ²ng hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng, suy nghÃ„Â©, Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ xen giÃ¡Â»Â¯a Ã¢â‚¬â€ thÃƒÂ nh MÃ¡Â»ËœT dÃƒÂ²ng bÃ¡ÂºÂ¥m Ã„â€˜Ã¡Â»Æ’ mÃ¡Â»Å¸ lÃ¡ÂºÂ¡i. KhÃƒÂ´ng gÃ¡ÂºÂ¥p: cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi cuÃ¡Â»â€˜i, thÃ¡ÂºÂ» artifact,
 * thÃ¡ÂºÂ» xin phÃƒÂ©p, thÃƒÂ´ng bÃƒÂ¡o lÃ¡Â»â€”i/cÃ¡ÂºÂ£nh bÃƒÂ¡o.
 *
 * VÃƒâ„¢NG CÃƒâ€šU TRÃ¡ÂºÂ¢ LÃ¡Â»Å“I = **DÃƒÆ’Y Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ Ã¡Â»Å¸ cuÃ¡Â»â€˜i lÃ†Â°Ã¡Â»Â£t**, khÃƒÂ´ng phÃ¡ÂºÂ£i "Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ cuÃ¡Â»â€˜i cÃƒÂ¹ng". Model rÃ¡ÂºÂ¥t hay viÃ¡ÂºÂ¿t cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi Ã„â€˜Ã¡ÂºÂ§y Ã„â€˜Ã¡Â»Â§
 * rÃ¡Â»â€œi thÃƒÂªm mÃ¡Â»â„¢t cÃƒÂ¢u chÃ¡Â»â€˜t ngÃ¡ÂºÂ¯n (Ã‚Â«Anh xem giÃƒÂºp em nhÃƒÂ©.Ã‚Â»). NÃ¡ÂºÂ¿u cÃ¡ÂºÂ¯t Ã¡Â»Å¸ Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ cuÃ¡Â»â€˜i thÃƒÂ¬ cÃƒÂ¢u chÃ¡Â»â€˜t hiÃ¡Â»â€¡n lÃƒÂªn cÃƒÂ²n TOÃƒâ‚¬N BÃ¡Â»Ëœ cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi
 * bÃ¡Â»â€¹ gÃ¡ÂºÂ¥p vÃƒÂ o Ã‚Â«Worked forÃ‚Â» Ã¢â‚¬â€ ngÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng chÃ¡Â»â€° Ã„â€˜Ã¡Â»Âc Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃƒÂ¢u chÃ¡Â»â€˜t vÃƒÂ  tÃ†Â°Ã¡Â»Å¸ng Ã„â€˜ÃƒÂ³ lÃƒÂ  kÃ¡ÂºÂ¿t quÃ¡ÂºÂ£. VÃƒÂ¬ vÃ¡ÂºÂ­y chÃ¡Â»â€° gÃ¡ÂºÂ¥p phÃ¡ÂºÂ§n Ã„â€˜Ã¡Â»Â©ng TRÃ†Â¯Ã¡Â»Å¡C
 * dÃƒÂ£y chÃ¡Â»Â¯ cuÃ¡Â»â€˜i cÃƒÂ¹ng; mÃ¡Â»Âi Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ liÃ¡Â»Ân nhau Ã¡Â»Å¸ cuÃ¡Â»â€˜i lÃ†Â°Ã¡Â»Â£t Ã„â€˜Ã¡Â»Âu hiÃ¡Â»â€¡n ra.
 *
 * null = khÃƒÂ´ng cÃƒÂ³ gÃƒÂ¬ Ã„â€˜ÃƒÂ¡ng gÃ¡ÂºÂ¥p (khÃƒÂ´ng cÃƒÂ³ cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi chÃ¡Â»Â¯, hay chÃ¡Â»â€° cÃƒÂ³ mÃ¡Â»â„¢t dÃƒÂ²ng hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng vÃƒÂ  khÃƒÂ´ng cÃƒÂ³ Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ xen giÃ¡Â»Â¯a).
 */
export function splitWork(segments: readonly Segment[], blocks: readonly ABlock[] = [], startedAt = 0, endedAt?: number): WorkSplit | null {
  // DuyÃ¡Â»â€¡t ngÃ†Â°Ã¡Â»Â£c gom DÃƒÆ’Y Ã„â€˜oÃ¡ÂºÂ¡n cuÃ¡Â»â€˜i lÃ†Â°Ã¡Â»Â£t: chÃ¡Â»Â¯, artifact, thÃƒÂ´ng bÃƒÂ¡o thÃ†Â°Ã¡Â»Âng. GÃ¡ÂºÂ·p hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng / xin phÃƒÂ©p / thÃƒÂ´ng bÃƒÂ¡o lÃ¡Â»â€”i
  // thÃƒÂ¬ dÃ¡Â»Â«ng Ã¢â‚¬â€ Ã„â€˜ÃƒÂ³ lÃƒÂ  ranh giÃ¡Â»â€ºi Ã‚Â«hÃ¡ÂºÂ¿t quÃƒÂ¡ trÃƒÂ¬nh, bÃ¡ÂºÂ¯t Ã„â€˜Ã¡ÂºÂ§u cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»ÂiÃ‚Â».
  let answer = segments.length;
  let hasText = false;
  for (let i = segments.length - 1; i >= 0; i--) {
    const s = segments[i];
    if (s.kind === 'text') {
      if (s.block.text.trim()) hasText = true;
      answer = i; // Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ RÃ¡Â»â€“NG vÃ¡ÂºÂ«n thuÃ¡Â»â„¢c dÃƒÂ£y: khÃƒÂ´ng Ã„â€˜Ã†Â°Ã¡Â»Â£c cÃ¡ÂºÂ¯t nÃƒÂ³ ra khÃ¡Â»Âi cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi
      continue;
    }
    if (s.kind === 'artifact') {
      answer = i;
      continue;
    }
    if (s.kind === 'notice' && s.block.level === 'info') {
      answer = i;
      continue;
    }
    break;
  }
  // KhÃƒÂ´ng cÃƒÂ³ chÃ¡Â»Â¯ Ã¡Â»Å¸ CUÃ¡Â»ÂI lÃ†Â°Ã¡Â»Â£t (lÃ†Â°Ã¡Â»Â£t kÃ¡ÂºÂ¿t thÃƒÂºc bÃ¡ÂºÂ±ng hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng): lÃƒÂ¹i vÃ¡Â»Â quy tÃ¡ÂºÂ¯c cÃ…Â© Ã¢â‚¬â€ Ã„â€˜oÃ¡ÂºÂ¡n chÃ¡Â»Â¯ cuÃ¡Â»â€˜i cÃƒÂ¹ng lÃƒÂ  cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi,
  // mÃ¡Â»Âi thÃ¡Â»Â© sau nÃƒÂ³ (kÃ¡Â»Æ’ cÃ¡ÂºÂ£ hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng chÃ¡ÂºÂ¡y sau cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi) vÃ¡ÂºÂ«n hiÃ¡Â»â€¡n trong phÃ¡ÂºÂ§n Ã„â€˜uÃƒÂ´i.
  if (!hasText) {
    answer = -1;
    for (let i = segments.length - 1; i >= 0; i--) {
      const s = segments[i];
      if (s.kind === 'text' && s.block.text.trim()) {
        answer = i;
        break;
      }
    }
  }
  // KhÃƒÂ´ng cÃƒÂ³ cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi chÃ¡Â»Â¯, hoÃ¡ÂºÂ·c cÃ¡ÂºÂ£ lÃ†Â°Ã¡Â»Â£t chÃ¡Â»â€° lÃƒÂ  cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi (khÃƒÂ´ng cÃƒÂ³ quÃƒÂ¡ trÃƒÂ¬nh Ã„â€˜Ã¡Â»Â©ng trÃ†Â°Ã¡Â»â€ºc) Ã¢â€ â€™ khÃƒÂ´ng gÃ¡ÂºÂ¥p gÃƒÂ¬.
  if (answer <= 0) return null;
  const work: Segment[] = [];
  const kept: Segment[] = [];
  for (const s of segments.slice(0, answer)) {
    if (s.kind === 'artifact' || s.kind === 'permission' || (s.kind === 'notice' && s.block.level !== 'info')) kept.push(s);
    // CÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi DÃƒâ‚¬I khÃƒÂ´ng bao giÃ¡Â»Â bÃ¡Â»â€¹ gÃ¡ÂºÂ¥p, kÃ¡Â»Æ’ cÃ¡ÂºÂ£ khi sau nÃƒÂ³ cÃƒÂ²n gÃ¡Â»Âi cÃƒÂ´ng cÃ¡Â»Â¥ rÃ¡Â»â€œi chÃ¡Â»â€˜t mÃ¡Â»â„¢t cÃƒÂ¢u ngÃ¡ÂºÂ¯n.
    else if (s.kind === 'text' && s.block.text.trim().length >= LONG_ANSWER_CHARS) kept.push(s);
    else work.push(s);
  }
  const rows = work.flatMap((s) => (s.kind === 'activity' ? s.rows : []));
  const interim = work.some((s) => s.kind === 'text' && s.block.text.trim().length > 0);
  if (rows.length === 0) return null;
  const stats: WorkStats = { calls: 0, failed: 0, edits: 0, steps: 0 };
  for (const r of rows) rowStats(r, stats);
  // MÃ¡Â»â„¢t dÃƒÂ²ng hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng Ã„â€˜Ã†Â¡n Ã„â€˜Ã¡Â»â„¢c, khÃƒÂ´ng cÃƒÂ³ chÃ¡Â»Â¯ xen giÃ¡Â»Â¯a Ã¢â€ â€™ chÃ†Â°a Ã„â€˜ÃƒÂ¡ng gÃ¡ÂºÂ¥p (giÃ¡Â»Â¯ nhÃ†Â° thiÃ¡ÂºÂ¿t kÃ¡ÂºÂ¿ 0.6.3).
  if (!interim && rows.length < 2 && stats.calls < 2) return null;
  stats.durationMs = workDuration(blocks, startedAt, endedAt);
  // CÃ¡Â»Â¥m sÃ¡Â»Â­a tÃ¡Â»â€¡p Ã„â€˜ÃƒÂ£ gÃ¡Â»â„¢p vÃ¡ÂºÂ«n hiÃ¡Â»â€¡n preview thay Ã„â€˜Ã¡Â»â€¢i (bÃ¡ÂºÂ¥m xem diff tÃ¡Â»Â«ng tÃ¡Â»â€¡p) khi khÃƒÂ´ng quÃƒÂ¡ nhiÃ¡Â»Âu.
  const flat = rows.flatMap((r): ActivityRow[] => (r.kind === 'taskgroup' ? r.rows : [r]));
  const changeRows = flat.flatMap((r) =>
    r.kind === 'tool' && r.block.state === 'done' && isFileChange(r.block)
      ? [r]
      : r.kind === 'editgroup'
        ? r.blocks.filter((b) => b.state === 'done').map((b) => ({ kind: 'tool' as const, key: b.id, block: b }))
        : [],
  );
  const changes: Segment | null =
    changeRows.length > 0 && changeRows.length <= MAX_CHANGE_ROWS && stats.edits <= MAX_CHANGE_ROWS ? { kind: 'activity', key: `changes:${changeRows[0].key}`, rows: changeRows } : null;
  return { work, kept, tail: segments.slice(answer), stats, changes };
}

/** ToÃƒÂ n bÃ¡Â»â„¢ vÃ„Æ’n bÃ¡ÂºÂ£n trÃ¡ÂºÂ£ lÃ¡Â»Âi (Ã„â€˜Ã¡Â»Æ’ nÃƒÂºt "ChÃƒÂ©p cÃƒÂ¢u trÃ¡ÂºÂ£ lÃ¡Â»Âi"). */
export function turnPlainText(item: { blocks: readonly ABlock[] }): string {
  return item.blocks
    .filter((b): b is TextBlockT => b.type === 'text')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Lượt đang chạy → luôn có dòng «đang xử lý» (logo động + nhãn + đồng hồ + token) ở cuối, như Claude Code («✻ Wibbling…» hiện suốt,
 * cả khi dòng trên nó là «Thinking…» hay một lệnh đang chạy). Trước đây ẩn khi khối cuối đang nghĩ/đang chạy công cụ nên chính lúc chờ lâu
 * nhất — người dùng lại không thấy logo động nào (07–08/11/2026, ảnh chụp của anh Tuấn Anh). Chỉ ẩn khi đang chờ NGƯỜI DÙNG duyệt quyền.
 */
export function needsWorkingIndicator(blocks: readonly ABlock[]): boolean {
  const last = blocks[blocks.length - 1];
  if (!last) return true;
  if (last.type === 'tool' && last.state === 'awaiting_permission') return false;
  return true;
}

/** MÃ¡Â»â„¢t mÃ¡Â»Â¥c trong chuÃ¡Â»â€”i hoÃ¡ÂºÂ¡t Ã„â€˜Ã¡Â»â„¢ng: mÃ¡Â»â„¢t dÃƒÂ²ng Ã„â€˜Ã†Â¡n, hoÃ¡ÂºÂ·c MÃ¡Â»ËœT NHÃƒâ€œM cÃƒÂ¡c khÃ¡Â»â€˜i Ã‚Â«Suy nghÃ„Â©Ã‚Â» liÃ¡Â»Ân nhau. */
export interface ActItem {
  key: string;
  live: boolean;
  thinking?: ThinkingBlockT[];
  row?: ActivityRow;
}

/**
 * Gom TOÃƒâ‚¬N BÃ¡Â»Ëœ khÃ¡Â»â€˜i Ã‚Â«Suy nghÃ„Â©Ã‚Â» cÃ¡Â»Â§a mÃ¡Â»â„¢t lÃ†Â°Ã¡Â»Â£t vÃƒÂ o MÃ¡Â»ËœT dÃƒÂ²ng, Ã„â€˜Ã¡ÂºÂ·t Ã¡Â»Å¸ vÃ¡Â»â€¹ trÃƒÂ­ khÃ¡Â»â€˜i nghÃ„Â© Ã„â€˜Ã¡ÂºÂ§u tiÃƒÂªn.
 * (TrÃ†Â°Ã¡Â»â€ºc Ã„â€˜ÃƒÂ¢y chÃ¡Â»â€° gom cÃƒÂ¡c khÃ¡Â»â€˜i LIÃ¡Â»â‚¬N nhau Ã¢â‚¬â€ mÃƒÂ  thÃ¡Â»Â±c tÃ¡ÂºÂ¿ mÃ¡Â»â€”i lÃ¡ÂºÂ§n nghÃ„Â© lÃ¡ÂºÂ¡i chen mÃ¡Â»â„¢t thao tÃƒÂ¡c, nÃƒÂªn gÃ¡ÂºÂ§n nhÃ†Â° khÃƒÂ´ng bao giÃ¡Â»Â liÃ¡Â»Ân
 * vÃƒÂ  ngÃ†Â°Ã¡Â»Âi dÃƒÂ¹ng vÃ¡ÂºÂ«n thÃ¡ÂºÂ¥y hÃƒÂ ng chÃ¡Â»Â¥c dÃƒÂ²ng Ã‚Â«Thinking Ã‚Â· 2 tokensÃ‚Â», Ã‚Â«Thinking Ã‚Â· 842 tokensÃ‚Â»Ã¢â‚¬Â¦)
 */
export function groupThinking(rows: readonly ActivityRow[], live: boolean): ActItem[] {
  const thinks = rows.filter((r): r is Extract<ActivityRow, { kind: 'thinking' }> => r.kind === 'thinking');
  if (thinks.length === 0) return rows.map((r, i) => ({ key: r.key, live: live && i === rows.length - 1, row: r }));

  const out: ActItem[] = [];
  let placed = false;
  const thinkingLive = live && rows[rows.length - 1]?.kind === 'thinking';
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.kind === 'thinking') {
      if (!placed) {
        out.push({ key: `think:${r.key}`, live: thinkingLive, thinking: thinks.map((t) => t.block) });
        placed = true;
      }
      continue;
    }
    out.push({ key: r.key, live: live && i === rows.length - 1, row: r });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// (0.6.28) Cụm hoạt động của một lượt ĐANG CHẠY: thống kê + việc đang làm
// ─────────────────────────────────────────────────────────────────────────────

/** Thống kê của một cụm dòng hoạt động (đếm cả lệnh bên trong nhóm và bên trong agent con). */
export function activityStats(rows: readonly ActivityRow[]): WorkStats {
  return statsOf(rows);
}

/**
 * Lệnh gần nhất CÒN ĐANG chạy trong cụm (đi xuyên vào nhóm, dòng tóm tắt và việc của agent con).
 * Dùng để dòng gộp một dòng vẫn nói được «đang đọc src/a.ts» mà không phải mở ra.
 */
export function latestRunningTool(rows: readonly ActivityRow[]): ToolBlock | null {
  let found: ToolBlock | null = null;
  for (const r of rows) {
    switch (r.kind) {
      case 'tool':
        if (r.block.state === 'running') found = r.block;
        break;
      case 'toolgroup':
      case 'editgroup':
        for (const b of r.blocks) if (b.state === 'running') found = b;
        break;
      case 'toolsum':
        if (r.info.latest) found = r.info.latest;
        break;
      case 'taskgroup': {
        const inner = latestRunningTool(r.rows);
        if (inner) found = inner;
        break;
      }
      default:
        break;
    }
  }
  return found;
}
/** Một cụm hiển thị ở lượt đang chạy: nhiều đoạn hoạt động liền nhau gộp thành MỘT dòng, hoặc một đoạn lẻ. */
export type SegmentRun = { kind: 'run'; key: string; items: Segment[] } | { kind: 'one'; key: string; seg: Segment };

/**
 * Gom các đoạn hoạt động LIỀN nhau thành một dòng (thuần tuý, test được). Đoạn chữ / artifact / thông báo chen
 * giữa sẽ tách cụm, nên thứ tự đọc không bị đảo. Cụm chỉ có 1 dòng thì để nguyên — gộp chỉ thêm một lớp bấm.
 */
export function groupActivityRuns(segments: readonly Segment[], minRows = 2): SegmentRun[] {
  const out: SegmentRun[] = [];
  let cur: Segment[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    const rows = cur.flatMap((s) => (s.kind === 'activity' ? s.rows : []));
    if (rows.length >= minRows) out.push({ kind: 'run', key: `run:${cur[0].key}`, items: [...cur] });
    else for (const s of cur) out.push({ kind: 'one', key: s.key, seg: s });
    cur = [];
  };
  for (const s of segments) {
    if (s.kind === 'activity') cur.push(s);
    else {
      flush();
      out.push({ kind: 'one', key: s.key, seg: s });
    }
  }
  flush();
  return out;
}