/**
 * The feedback queue CLI's logic. server/scripts/feedback.ts is the thin
 * entry point; everything lives here so it can be tested with an in-memory
 * output sink and the test DB.
 *
 *   npm run feedback --workspace server -- list [--status open|NEW|SEEN|DONE|DECLINED|all] [--limit N] [--json]
 *   npm run feedback --workspace server -- show <id> [--json]
 *   npm run feedback --workspace server -- resolve <id> --status SEEN|DONE|DECLINED [--pr <url>] [--note "<answer>"] --as <email|donorId>
 *
 * Deliberately imports no route/middleware code: the resolve path goes through
 * the very same parseFeedbackUpdate + applyFeedbackUpdate the admin API uses,
 * so validation and the resolver stamp are identical.
 */

import { stat } from 'node:fs/promises';
import prisma from '../lib/prisma.js';
import { ROLE, resolveEffectiveRole } from '../lib/roles.js';
import {
  FEEDBACK_STATUSES,
  feedbackRef,
  firstChars,
  isFeedbackStatus,
  isOpenFeedbackStatus,
  isStaleFeedbackBuild,
  parseFeedbackDiagnostics,
} from '@dono/shared';
import {
  applyFeedbackUpdate,
  FEEDBACK_UPDATE_ERRORS,
  loadFeedbackItem,
  parseFeedbackUpdate,
  type FeedbackUpdate,
} from './feedbackQueue.js';
import { absoluteFeedbackPath } from './feedbackStorage.js';

export type FeedbackCliIo = { out: (line: string) => void; err: (line: string) => void };

export const FEEDBACK_CLI_LIST_STATUSES = ['open', ...FEEDBACK_STATUSES, 'all'] as const;
export type FeedbackCliListStatus = (typeof FEEDBACK_CLI_LIST_STATUSES)[number];

export const FEEDBACK_CLI_USAGE = [
  'Usage:',
  '  feedback list [--status open|NEW|SEEN|DONE|DECLINED|all] [--limit N] [--json]',
  '  feedback show <id> [--json]',
  '  feedback resolve <id> --status SEEN|DONE|DECLINED [--pr <url>] [--note "<answer>"] --as <email|donorId>',
].join('\n');

export class FeedbackCliUsageError extends Error {}

type ParsedArgs = { flags: Map<string, string | true>; positional: string[] };

const VALUE_FLAGS = new Set(['status', 'limit', 'pr', 'note', 'as']);
const BOOL_FLAGS = new Set(['json']);

/** `--flag value`, `--flag=value`, `--json`; everything else is positional. */
export function parseFeedbackCliArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOL_FLAGS.has(name)) {
      if (eq !== -1) throw new FeedbackCliUsageError(`--${name} takes no value`);
      flags.set(name, true);
    } else if (VALUE_FLAGS.has(name)) {
      let value: string;
      if (eq !== -1) value = arg.slice(eq + 1);
      else if (i + 1 < argv.length) value = argv[++i] ?? '';
      else throw new FeedbackCliUsageError(`--${name} needs a value`);
      if (flags.has(name)) throw new FeedbackCliUsageError(`--${name} given twice`);
      flags.set(name, value);
    } else {
      throw new FeedbackCliUsageError(`unknown option --${name}`);
    }
  }
  return { flags, positional };
}

function flag(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

/** An exact uuid, or a unique FB-<short id> prefix. */
export async function resolveFeedbackId(raw: string | undefined): Promise<string> {
  if (!raw) throw new FeedbackCliUsageError('expected a report id (e.g. FB-1a2b3c4d or the uuid)');
  const cleaned = raw.replace(/^FB-/i, '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned)) {
    return cleaned;
  }
  if (!/^[0-9a-f]{1,8}$/i.test(cleaned)) {
    throw new FeedbackCliUsageError(`bad report id "${raw}"`);
  }
  const rows = await prisma.feedback.findMany({
    where: { id: { startsWith: cleaned } },
    select: { id: true },
    take: 2,
  });
  if (rows.length === 0) throw new FeedbackCliUsageError(`no report matches "${raw}"`);
  if (rows.length > 1) {
    throw new FeedbackCliUsageError(`"${raw}" matches several reports; use the full id`);
  }
  return rows[0]!.id;
}

async function cmdList(p: ParsedArgs, io: FeedbackCliIo): Promise<number> {
  if (p.positional.length > 1)
    throw new FeedbackCliUsageError(`unexpected argument "${p.positional[1]}"`);
  const status = flag(p, 'status') ?? 'open';
  if (!(FEEDBACK_CLI_LIST_STATUSES as readonly string[]).includes(status)) {
    throw new FeedbackCliUsageError(
      `--status must be one of ${FEEDBACK_CLI_LIST_STATUSES.join('|')}`,
    );
  }
  const limitRaw = flag(p, 'limit') ?? '20';
  if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 500) {
    throw new FeedbackCliUsageError('--limit must be a whole number from 1 to 500');
  }
  const json = p.flags.has('json');
  const where =
    status === 'all' ? {} : status === 'open' ? { status: { in: ['NEW', 'SEEN'] } } : { status }; // exactly this status: DONE does NOT include DECLINED here
  const rows = await prisma.feedback.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: Number(limitRaw),
    select: {
      id: true,
      status: true,
      message: true,
      route: true,
      created_at: true,
      screenshot_path: true,
      snapshot_path: true,
      diagnostics: true,
      sender: { select: { id: true, email: true } },
    },
  });
  const items = rows.map((r) => ({
    id: r.id,
    ref: feedbackRef(r.id),
    status: r.status,
    created_at: r.created_at.toISOString(),
    sender: r.sender?.email ?? r.sender?.id ?? null,
    route: r.route,
    message: r.message,
    has_screenshot: r.screenshot_path != null,
    has_snapshot: r.snapshot_path != null,
    error_count: parseFeedbackDiagnostics(r.diagnostics)?.error_count ?? null,
  }));
  if (json) {
    io.out(JSON.stringify(items, null, 2));
    return 0;
  }
  if (items.length === 0) {
    io.out(`No ${status === 'all' ? '' : `${status} `}reports.`);
    return 0;
  }
  for (const it of items) {
    const flags = `${it.has_screenshot ? 'S' : '-'}${it.has_snapshot ? 'D' : '-'}${it.error_count ? `E${it.error_count}` : ''}`;
    io.out(
      `${it.ref.padEnd(11)} ${it.status.padEnd(8)} ${it.created_at.slice(0, 16).replace('T', ' ')}Z  ${(it.sender ?? '(removed)').slice(0, 24).padEnd(24)} ${flags.padEnd(4)} ${it.route.slice(0, 40).padEnd(40)} ${firstChars(it.message, 70)}`,
    );
  }
  io.out('(flags: S screenshot, D DOM snapshot, En diagnostics errors)');
  return 0;
}

async function fileInfo(
  rel: string | null,
): Promise<{ path: string; exists: boolean; bytes: number | null } | null> {
  if (!rel) return null;
  const path = absoluteFeedbackPath(rel);
  try {
    const s = await stat(path);
    return { path, exists: true, bytes: s.size };
  } catch {
    return { path, exists: false, bytes: null };
  }
}

export async function loadFeedbackCliShow(id: string) {
  const item = await loadFeedbackItem(id);
  if (!item) return null;
  const row = await prisma.feedback.findUnique({
    where: { id },
    select: { screenshot_path: true, snapshot_path: true, user_agent: true },
  });
  return {
    ...item,
    created_at: item.created_at.toISOString(),
    resolved_at: item.resolved_at?.toISOString() ?? null,
    user_agent: row?.user_agent ?? '',
    files: {
      screenshot: row ? await fileInfo(row.screenshot_path) : null,
      snapshot: row ? await fileInfo(row.snapshot_path) : null,
    },
  };
}

async function cmdShow(p: ParsedArgs, io: FeedbackCliIo): Promise<number> {
  if (p.positional.length !== 2)
    throw new FeedbackCliUsageError('show needs exactly one report id');
  const id = await resolveFeedbackId(p.positional[1]);
  const data = await loadFeedbackCliShow(id);
  if (!data) {
    io.err(`${feedbackRef(id)}: not found`);
    return 1;
  }
  if (p.flags.has('json')) {
    io.out(JSON.stringify(data, null, 2));
    return 0;
  }
  io.out(
    `${data.ref}  ${data.status}  ${data.created_at}  from ${data.sender?.email ?? data.sender?.id ?? '(removed)'}`,
  );
  io.out(`Page:      ${data.page_url || '-'}`);
  io.out(
    `Route:     ${data.route || '-'}    Viewport: ${data.viewport || '-'}    Scroll: ${data.scroll_y}`,
  );
  io.out(`Agent:     ${data.user_agent || '-'}`);
  io.out('');
  io.out(data.message);
  io.out('');
  for (const [label, f] of [
    ['Screenshot', data.files.screenshot],
    ['Snapshot', data.files.snapshot],
  ] as const) {
    io.out(
      `${label.padEnd(11)}${f ? `${f.path}${f.exists ? ` (${f.bytes} bytes)` : '  [MISSING ON DISK]'}` : '-'}`,
    );
  }
  const d = data.diagnostics;
  if (d) {
    const c = d.context;
    io.out('');
    io.out(
      `Diagnostics: ${d.error_count} error(s)  build ${c.build_id} (browser ${c.client_build_id}${isStaleFeedbackBuild(c) ? ', STALE TAB' : ''})  instance ${c.instance ?? '-'}  role ${c.sender_role ?? '-'}`,
    );
    for (const e of d.entries) io.out(`  ${e.at} ${e.kind}: ${e.message}`);
  } else {
    io.out('');
    io.out('Diagnostics: none');
  }
  if (isOpenFeedbackStatus(data.status) === false || data.resolution_note) {
    io.out('');
    io.out(
      `Answer: ${data.resolution_note || '(no note)'}${data.resolution_pr ? `  ${data.resolution_pr}` : ''}${data.resolved_by ? `  - ${data.resolved_by}` : ''}`,
    );
  }
  return 0;
}

/** `--as` accepts an email or a donor id; must be an effective ADMIN (the adminAuth rule). */
export async function findFeedbackResolver(ref: string) {
  const lower = ref.toLowerCase();
  const donor = await prisma.donor.findFirst({
    // SQLite's Prisma connector has no case-insensitive `mode`; emails are
    // normally lowercase, so try the raw ref first and then the lowercased one.
    where: { OR: [{ email: { in: [ref, lower] } }, { id: ref }] },
  });
  if (!donor) throw new FeedbackCliUsageError(`--as "${ref}": no such donor`);
  if (donor.is_frozen) throw new FeedbackCliUsageError(`--as "${ref}": that account is frozen`);
  const effective = resolveEffectiveRole(donor.email, donor.role, donor.email_verified);
  if (effective !== ROLE.ADMIN) {
    throw new FeedbackCliUsageError(
      `--as "${ref}": ${donor.email} is not an admin (only resolvers may answer reports)`,
    );
  }
  return donor;
}

async function cmdResolve(p: ParsedArgs, io: FeedbackCliIo): Promise<number> {
  if (p.positional.length !== 2)
    throw new FeedbackCliUsageError('resolve needs exactly one report id');
  const id = await resolveFeedbackId(p.positional[1]);
  const status = flag(p, 'status');
  if (!status) throw new FeedbackCliUsageError('resolve needs --status SEEN|DONE|DECLINED');
  if (!isFeedbackStatus(status) || status === 'NEW') {
    throw new FeedbackCliUsageError('--status must be SEEN, DONE or DECLINED');
  }
  const asRef = flag(p, 'as');
  if (!asRef) throw new FeedbackCliUsageError('resolve needs --as <admin email or donorId>');
  const resolver = await findFeedbackResolver(asRef);

  const existing = await prisma.feedback.findUnique({
    where: { id },
    select: { resolution_note: true, resolution_pr: true },
  });
  if (!existing) {
    io.err(`${feedbackRef(id)}: not found`);
    return 1;
  }
  // The admin UI's Handle form pre-fills the current note and PR, so a bare
  // status change keeps them; an OMITTED flag means "keep", an explicit empty
  // value ("--note ''") means "clear".
  const update: FeedbackUpdate | { error: keyof typeof FEEDBACK_UPDATE_ERRORS } =
    parseFeedbackUpdate({
      id,
      status,
      resolution_note: flag(p, 'note') ?? existing.resolution_note,
      resolution_pr: flag(p, 'pr') ?? existing.resolution_pr,
    });
  if ('error' in update) {
    io.err(`${feedbackRef(id)}: ${FEEDBACK_UPDATE_ERRORS[update.error]}`);
    return 2;
  }
  const row = await applyFeedbackUpdate(update, resolver.email);
  io.out(
    `${feedbackRef(row.id)} -> ${row.status} by ${row.resolved_by}${row.resolution_pr ? ` (${row.resolution_pr})` : ''}`,
  );
  return 0;
}

export async function runFeedbackCli(argv: string[], io: FeedbackCliIo): Promise<number> {
  try {
    const p = parseFeedbackCliArgs(argv);
    const command = p.positional[0];
    switch (command) {
      case 'list':
        return await cmdList(p, io);
      case 'show':
        return await cmdShow(p, io);
      case 'resolve':
        return await cmdResolve(p, io);
      case undefined:
      case 'help':
        io.out(FEEDBACK_CLI_USAGE);
        return command === undefined ? 2 : 0;
      default:
        throw new FeedbackCliUsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof FeedbackCliUsageError) {
      io.err(`feedback: ${err.message}\n${FEEDBACK_CLI_USAGE}`);
      return 2;
    }
    throw err;
  }
}
