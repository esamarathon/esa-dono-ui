/**
 * Feedback queue — loader and resolver writes for the admin queue page.
 *
 * The queue is readable only through /api/admin/feedback (adminAuth), so the
 * "sender and resolvers" file-visibility rule of the crew-corner original
 * collapses to: admins see everything, donors see nothing here. The donor
 * widget's own flow (send → "Thanks, sent!") needs no read endpoint.
 *
 * The write path (parseFeedbackUpdate + applyFeedbackUpdate) is the ONLY way a
 * report changes; the CLI reuses both so validation and the resolver stamp are
 * identical everywhere.
 */

import prisma from '../lib/prisma.js';
import {
  FEEDBACK_RESOLUTION_MAX_CHARS,
  type FeedbackDiagnostics,
  type FeedbackQueueFilter,
  type FeedbackStatus,
  feedbackRef,
  isFeedbackStatus,
  isOpenFeedbackStatus,
  parseFeedbackDiagnostics,
  queueFilterFrom,
} from '@dono/shared';

export interface FeedbackSenderRef {
  id: string;
  email: string | null;
}

/** One queue row as the admin page renders it. */
export interface FeedbackQueueItem {
  id: string;
  ref: string;
  message: string;
  page_url: string;
  route: string;
  viewport: string;
  scroll_y: number;
  status: FeedbackStatus;
  created_at: Date;
  sender: FeedbackSenderRef | null;
  has_screenshot: boolean;
  has_snapshot: boolean;
  diagnostics_error_count: number;
  resolution_note: string;
  resolution_pr: string;
  /** Audit label: the admin donor's email, or 'admin' for the operational key. */
  resolved_by: string | null;
  resolved_at: Date | null;
}

export interface FeedbackQueueDetail extends FeedbackQueueItem {
  user_agent: string;
  diagnostics: FeedbackDiagnostics | null;
}

export function parseQueueFilter(raw: unknown): FeedbackQueueFilter {
  return queueFilterFrom(typeof raw === 'string' ? raw : undefined);
}

const SENDER_SELECT = { select: { id: true, email: true } };

function toItem(row: {
  id: string;
  message: string;
  page_url: string;
  route: string;
  viewport: string;
  scroll_y: number;
  status: string;
  created_at: Date;
  screenshot_path: string | null;
  snapshot_path: string | null;
  diagnostics: string | null;
  resolution_note: string;
  resolution_pr: string;
  resolved_by: string | null;
  sender: FeedbackSenderRef | null;
  resolved_at: Date | null;
}): FeedbackQueueItem {
  const status: FeedbackStatus = isFeedbackStatus(row.status) ? row.status : 'NEW';
  return {
    id: row.id,
    ref: feedbackRef(row.id),
    message: row.message,
    page_url: row.page_url,
    route: row.route,
    viewport: row.viewport,
    scroll_y: row.scroll_y,
    status,
    created_at: row.created_at,
    sender: row.sender,
    has_screenshot: row.screenshot_path != null,
    has_snapshot: row.snapshot_path != null,
    diagnostics_error_count: parseFeedbackDiagnostics(row.diagnostics)?.error_count ?? 0,
    resolution_note: row.resolution_note,
    resolution_pr: row.resolution_pr,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
  };
}

const QUEUE_LIMIT = 500;

export async function loadFeedbackQueue(filter: FeedbackQueueFilter): Promise<FeedbackQueueItem[]> {
  const where =
    filter === 'open'
      ? { status: { in: ['NEW', 'SEEN'] } }
      : filter === 'done'
        ? { status: { in: ['DONE', 'DECLINED'] } }
        : {};
  const rows = await prisma.feedback.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: QUEUE_LIMIT,
    include: {
      sender: SENDER_SELECT,
    },
  });
  return rows.map(toItem);
}

export async function countOpenFeedback(): Promise<number> {
  return prisma.feedback.count({ where: { status: { in: ['NEW', 'SEEN'] } } });
}

export async function loadFeedbackItem(id: string): Promise<FeedbackQueueDetail | null> {
  const row = await prisma.feedback.findUnique({
    where: { id },
    include: { sender: SENDER_SELECT },
  });
  if (!row) return null;
  return {
    ...toItem(row),
    user_agent: row.user_agent,
    diagnostics: parseFeedbackDiagnostics(row.diagnostics),
  };
}

// ---------------------------------------------------------------------------
// Resolver write

export interface FeedbackUpdate {
  id: string;
  status: FeedbackStatus;
  resolution_note: string;
  resolution_pr: string;
}

export const FEEDBACK_UPDATE_ERRORS = {
  'bad-id': 'Unknown report.',
  'bad-status': 'Pick a status.',
  'note-long': `Keep the answer under ${FEEDBACK_RESOLUTION_MAX_CHARS} characters.`,
  'bad-pr': 'The PR link must be an http(s) URL.',
} as const;
export type FeedbackUpdateErrorCode = keyof typeof FEEDBACK_UPDATE_ERRORS;

function cleanStatus(value: unknown): FeedbackStatus | null {
  return isFeedbackStatus(value) ? value : null;
}

function cleanNote(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanPr(value: unknown): string {
  const pr = typeof value === 'string' ? value.trim() : '';
  // Only a plausible http(s) link is kept; anything else is refused, not sanitized.
  return pr && /^https?:\/\/\S{1,490}$/.test(pr) ? pr : '';
}

/** Validate a resolver write from the admin API body (or the CLI). */
export function parseFeedbackUpdate(body: {
  id: unknown;
  status: unknown;
  resolution_note: unknown;
  resolution_pr: unknown;
}): FeedbackUpdate | { error: FeedbackUpdateErrorCode } {
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : null;
  if (!id) return { error: 'bad-id' };
  const status = cleanStatus(body.status);
  if (!status) return { error: 'bad-status' };
  const resolution_note = cleanNote(body.resolution_note);
  if (resolution_note.length > FEEDBACK_RESOLUTION_MAX_CHARS) return { error: 'note-long' };
  const requested = typeof body.resolution_pr === 'string' ? body.resolution_pr.trim() : '';
  if (requested && !cleanPr(requested)) return { error: 'bad-pr' };
  return { id, status, resolution_note, resolution_pr: requested };
}

/** Answering stamps who/when; reopening (NEW/SEEN) clears the stamp. */
export async function applyFeedbackUpdate(
  update: FeedbackUpdate,
  resolverId: string,
  now = new Date(),
) {
  const existing = await prisma.feedback.findUnique({
    where: { id: update.id },
    select: { id: true },
  });
  if (!existing) throw new Error('Unknown report.');
  const stamp = isOpenFeedbackStatus(update.status)
    ? { resolved_by: null, resolved_at: null }
    : { resolved_by: resolverId, resolved_at: now };
  return prisma.feedback.update({
    where: { id: update.id },
    data: {
      status: update.status,
      resolution_note: update.resolution_note,
      resolution_pr: update.resolution_pr,
      ...stamp,
    },
  });
}

/** Opening a fresh report marks it SEEN; a no-op beyond that state. */
export async function markFeedbackSeen(id: string): Promise<void> {
  await prisma.feedback.updateMany({ where: { id, status: 'NEW' }, data: { status: 'SEEN' } });
}
