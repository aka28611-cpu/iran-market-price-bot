import type { KVLike } from "../env";
import { logWarn } from "../logging";
import {
  readJson,
  TICKETS_CLOSED_PREFIX,
  TICKETS_COUNT_KEY,
  TICKETS_OPEN_KEY,
  writeJson,
} from "../state";

/**
 * سیستم پشتیبانی/تیکت مینیمال (KV-based).
 *
 * طراحی امنیتی:
 *  • فضای‌نام per-user برای تاریخچه — امکان enumeration تیکت دیگران وجود ندارد
 *    (کاربر فقط تیکتهای «خودش» را از طریق فیلتر سمت سرور userId می‌بیند)
 *  • متن خام بدون parse_mode ارسال می‌شود → هیچ تزریق HTML/Markdown ممکن نیست
 *  • سقفها: ۳ تیکت باز per user، ۱۰۰ تیکت باز کل، ۲۰ پاسخ per تیکت،
 *    تاریخچه ۲۰ تیکت بسته per user
 *  • id تیکت شمارنده KV است — نه شناسه کاربر و نه داده قابل جعل
 *  • نقش پاسخ‌دهنده (user/support) فقط سمت سرور تعیین می‌شود؛
 *    callback هیچ نقشی اعطا نمی‌کند
 */

/** پاسخ در گفتگوی تیکت — فرستنده فقط سمت سرور تعیین می‌شود */
export interface TicketReply {
  /** نقش نویسنده پاسخ: کاربر صاحب تیکت یا پشتیبانی (ادمین) */
  from: "user" | "support";
  /** متن پاسخ (≤۵۱۲ کاراکتر) */
  text: string;
  /** ISO زمان ثبت پاسخ */
  at: string;
}

export interface Ticket {
  /** شماره تیکت (شمارنده KV) */
  id: number;
  /** شناسه فرستنده — فقط سمت سرور از from.id */
  userId: number;
  /** موضوع کوتاه تیکت (≤۸۰ کاراکتر) */
  subject: string;
  /** متن تیکت (≤۵۱۲ کاراکتر) */
  text: string;
  /** ISO زمان ایجاد */
  createdAt: string;
  /** گفتگوی تیکت (جدیدترین آخر) */
  replies: TicketReply[];
}

export interface ClosedTicket extends Ticket {
  closedAt: string;
}

const MAX_OPEN_TICKETS_PER_USER = 3;
const MAX_OPEN_TICKETS_TOTAL = 100;
const MAX_CLOSED_HISTORY_PER_USER = 20;
const MAX_TICKET_TEXT_LENGTH = 512;
const MAX_TICKET_SUBJECT_LENGTH = 80;
const MAX_TICKET_REPLIES = 20;

function sanitizeReplies(raw: unknown): TicketReply[] {
  if (!Array.isArray(raw)) return [];
  const out: TicketReply[] = [];
  for (const entry of raw.slice(0, MAX_TICKET_REPLIES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (
      (record.from !== "user" && record.from !== "support") ||
      typeof record.text !== "string" ||
      typeof record.at !== "string"
    )
      continue;
    out.push({
      from: record.from,
      text: record.text.slice(0, MAX_TICKET_TEXT_LENGTH),
      at: record.at,
    });
  }
  return out;
}

function sanitizeTickets(raw: unknown): Ticket[] {
  if (!Array.isArray(raw)) return [];
  const out: Ticket[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (
      typeof record.id !== "number" ||
      !Number.isSafeInteger(record.id) ||
      typeof record.userId !== "number" ||
      !Number.isSafeInteger(record.userId) ||
      typeof record.text !== "string" ||
      typeof record.createdAt !== "string"
    )
      continue;
    // مهاجرت دفاعی: تیکت بدون subject/replies (فرمت قدیمی) → مشتق/خالی
    const subject =
      typeof record.subject === "string" && record.subject.length > 0
        ? record.subject.slice(0, MAX_TICKET_SUBJECT_LENGTH)
        : `${record.text.slice(0, 40)}${record.text.length > 40 ? "…" : ""}`;
    out.push({
      id: record.id,
      userId: record.userId,
      subject,
      text: record.text,
      createdAt: record.createdAt,
      replies: sanitizeReplies(record.replies),
    });
  }
  return out;
}

async function readOpenTickets(kv: KVLike): Promise<Ticket[]> {
  return sanitizeTickets(await readJson<unknown>(kv, TICKETS_OPEN_KEY));
}

async function writeOpenTickets(kv: KVLike, tickets: Ticket[]): Promise<void> {
  await writeJson(kv, TICKETS_OPEN_KEY, tickets);
}

async function nextTicketId(kv: KVLike): Promise<number> {
  const raw = await kv.get(TICKETS_COUNT_KEY);
  const current = raw !== null && /^\d{1,15}$/.test(raw) ? Number(raw) : 0;
  const next = current + 1;
  await kv.put(TICKETS_COUNT_KEY, String(next));
  return next;
}

export interface TicketResult {
  ok: boolean;
  reason?:
    | "EMPTY_SUBJECT"
    | "EMPTY_TEXT"
    | "SUBJECT_TOO_LONG"
    | "TEXT_TOO_LONG"
    | "USER_LIMIT_REACHED"
    | "TOTAL_LIMIT_REACHED";
  ticket?: Ticket;
}

/** ثبت تیکت جدید — کاربر هر شبکه‌ای میتواند (مسیر فرار پشتیبانی) */
export async function createTicket(
  kv: KVLike,
  userId: number,
  subject: string,
  text: string,
  now = () => new Date(),
): Promise<TicketResult> {
  const trimmedSubject = subject.trim();
  const trimmedText = text.trim();
  if (trimmedSubject.length === 0) return { ok: false, reason: "EMPTY_SUBJECT" };
  if (trimmedSubject.length > MAX_TICKET_SUBJECT_LENGTH)
    return { ok: false, reason: "SUBJECT_TOO_LONG" };
  if (trimmedText.length === 0) return { ok: false, reason: "EMPTY_TEXT" };
  if (trimmedText.length > MAX_TICKET_TEXT_LENGTH)
    return { ok: false, reason: "TEXT_TOO_LONG" };

  const open = await readOpenTickets(kv);
  const userOpen = open.filter((t) => t.userId === userId);
  if (userOpen.length >= MAX_OPEN_TICKETS_PER_USER)
    return { ok: false, reason: "USER_LIMIT_REACHED" };
  if (open.length >= MAX_OPEN_TICKETS_TOTAL)
    return { ok: false, reason: "TOTAL_LIMIT_REACHED" };

  const id = await nextTicketId(kv);
  const ticket: Ticket = {
    id,
    userId,
    subject: trimmedSubject,
    text: trimmedText,
    createdAt: now().toISOString(),
    replies: [],
  };
  await writeOpenTickets(kv, [...open, ticket]);
  return { ok: true, ticket };
}

/** فهرست تیکتهای باز — فقط برای ادمین */
export async function listOpenTickets(kv: KVLike): Promise<Ticket[]> {
  return readOpenTickets(kv);
}

/** تیکت باز با id — برای نمایش جزئیات (اعمال مالکیت در لایه فرمان) */
export async function getOpenTicket(
  kv: KVLike,
  ticketId: number,
): Promise<Ticket | null> {
  const open = await readOpenTickets(kv);
  return open.find((t) => t.id === ticketId) ?? null;
}

export interface ReplyResult {
  ok: boolean;
  reason?:
    | "NOT_FOUND"
    | "ALREADY_CLOSED"
    | "EMPTY_TEXT"
    | "TEXT_TOO_LONG"
    | "REPLY_LIMIT_REACHED"
    | "FORBIDDEN";
  ticket?: Ticket;
}

/**
 * افزودن پاسخ به گفتگوی تیکت باز.
 * نقش و مجوز نویسنده در این تابع اعمال می‌شود (سمت سرور، نه callback):
 *  • from === "user"    → actorId باید صاحب تیکت باشد
 *  • from === "support" → actorId باید ادمین باشد
 */
export async function addTicketReply(
  kv: KVLike,
  ticketId: number,
  actorId: number,
  from: "user" | "support",
  text: string,
  adminUserId: number,
  now = () => new Date(),
): Promise<ReplyResult> {
  const open = await readOpenTickets(kv);
  const ticket = open.find((t) => t.id === ticketId);
  if (!ticket) return { ok: false, reason: "NOT_FOUND" };

  if (from === "user" && ticket.userId !== actorId)
    return { ok: false, reason: "FORBIDDEN", ticket };
  if (from === "support" && actorId !== adminUserId)
    return { ok: false, reason: "FORBIDDEN", ticket };

  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "EMPTY_TEXT", ticket };
  if (trimmed.length > MAX_TICKET_TEXT_LENGTH)
    return { ok: false, reason: "TEXT_TOO_LONG", ticket };
  if (ticket.replies.length >= MAX_TICKET_REPLIES)
    return { ok: false, reason: "REPLY_LIMIT_REACHED", ticket };

  const updated: Ticket = {
    ...ticket,
    replies: [
      ...ticket.replies,
      { from, text: trimmed, at: now().toISOString() },
    ],
  };
  await writeOpenTickets(
    kv,
    open.map((t) => (t.id === ticketId ? updated : t)),
  );
  return { ok: true, ticket: updated };
}

export interface CloseResult {
  ok: boolean;
  reason?: "NOT_FOUND" | "ALREADY_CLOSED";
  ticket?: Ticket;
}

/** بستن تیکت — اعمال مجوز در لایه فرمان (صاحب تیکت یا ادمین) */
export async function closeTicket(
  kv: KVLike,
  ticketId: number,
  now = () => new Date(),
): Promise<CloseResult> {
  const open = await readOpenTickets(kv);
  const ticket = open.find((t) => t.id === ticketId);
  if (!ticket) return { ok: false, reason: "NOT_FOUND" };

  await writeOpenTickets(
    kv,
    open.filter((t) => t.id !== ticketId),
  );

  // تاریخچه per-user — کاربر فقط تیکتهای خودش را می‌بیند
  const historyKey = `${TICKETS_CLOSED_PREFIX}${ticket.userId}`;
  const history = sanitizeTickets(
    await readJson<unknown>(kv, historyKey),
  ).map((t) => ({ ...t, closedAt: "" }));
  const closed: ClosedTicket = {
    ...ticket,
    closedAt: now().toISOString(),
  };
  // جدیدترین اول؛ سقف تاریخچه ۲۰
  const nextHistory = [closed, ...history].slice(
    0,
    MAX_CLOSED_HISTORY_PER_USER,
  );
  await writeJson(kv, historyKey, nextHistory);
  return { ok: true, ticket };
}

/** تیکتهای یک کاربر — فیلتر سمت سرور بر اساس from.id (هرگز ورودی کاربر) */
export async function listUserTickets(
  kv: KVLike,
  userId: number,
): Promise<{ open: Ticket[]; closedCount: number }> {
  const open = (await readOpenTickets(kv)).filter((t) => t.userId === userId);
  const history = sanitizeTickets(
    await readJson<unknown>(kv, `${TICKETS_CLOSED_PREFIX}${userId}`),
  );
  if (open.length + history.length > 100) {
    logWarn("tickets.history-anomaly", { userId });
  }
  return { open, closedCount: history.length };
}
