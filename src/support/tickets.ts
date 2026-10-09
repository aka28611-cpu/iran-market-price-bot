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
 *  • سقفها: ۳ تیکت باز per user، ۱۰۰ تیکت باز کل، تاریخچه ۲۰ تیکت بسته per user
 *  • id تیکت شمارنده KV است — نه شناسه کاربر و نه داده قابل جعل
 */

export interface Ticket {
  /** شماره تیکت (شمارنده KV) */
  id: number;
  /** شناسه فرستنده — فقط سمت سرور از from.id */
  userId: number;
  /** متن تیکت (≤۵۱۲ کاراکتر) */
  text: string;
  /** ISO زمان ایجاد */
  createdAt: string;
}

export interface ClosedTicket extends Ticket {
  closedAt: string;
}

const MAX_OPEN_TICKETS_PER_USER = 3;
const MAX_OPEN_TICKETS_TOTAL = 100;
const MAX_CLOSED_HISTORY_PER_USER = 20;
const MAX_TICKET_TEXT_LENGTH = 512;

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
    out.push({
      id: record.id,
      userId: record.userId,
      text: record.text,
      createdAt: record.createdAt,
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
    | "EMPTY_TEXT"
    | "TEXT_TOO_LONG"
    | "USER_LIMIT_REACHED"
    | "TOTAL_LIMIT_REACHED";
  ticket?: Ticket;
}

/** ثبت تیکت جدید — کاربر هر شبکه‌ای میتواند (مسیر فرار پشتیبانی) */
export async function createTicket(
  kv: KVLike,
  userId: number,
  text: string,
  now = () => new Date(),
): Promise<TicketResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: "EMPTY_TEXT" };
  if (trimmed.length > MAX_TICKET_TEXT_LENGTH)
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
    text: trimmed,
    createdAt: now().toISOString(),
  };
  await writeOpenTickets(kv, [...open, ticket]);
  return { ok: true, ticket };
}

/** فهرست تیکتهای باز — فقط برای ادمین */
export async function listOpenTickets(kv: KVLike): Promise<Ticket[]> {
  return readOpenTickets(kv);
}

export interface CloseResult {
  ok: boolean;
  reason?: "NOT_FOUND" | "ALREADY_CLOSED";
  ticket?: Ticket;
}

/** بستن تیکت — فقط ادمین؛ تیکت به تاریخچه کاربر منتقل می‌شود */
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
