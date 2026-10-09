import { describe, expect, it } from "vitest";
import {
  allowUser,
  checkChannelMembership,
  isUserAllowed,
  listAllowedUsers,
  mapMemberStatus,
  revokeUser,
} from "../src/auth/access";
import { ALLOW_LIST_KEY } from "../src/state";
import { makeEnv, MockKV, telegramRecorder } from "./helpers";

const ADMIN_ID = 100200300;
const USER_ID = 999111222;

describe("mapMemberStatus — نگاشت سه‌حالته", () => {
  it("وضعیت‌های عضو → member", () => {
    expect(mapMemberStatus("creator")).toBe("member");
    expect(mapMemberStatus("administrator")).toBe("member");
    expect(mapMemberStatus("member")).toBe("member");
    expect(mapMemberStatus("restricted")).toBe("member");
  });

  it("left/kicked → not-member", () => {
    expect(mapMemberStatus("left")).toBe("not-member");
    expect(mapMemberStatus("kicked")).toBe("not-member");
  });

  it("ناشناس/غایب → unknown (fail-closed)", () => {
    expect(mapMemberStatus(undefined)).toBe("unknown");
    expect(mapMemberStatus("")).toBe("unknown");
    expect(mapMemberStatus("future-status")).toBe("unknown");
  });
});

describe("checkChannelMembership — سمت سرور با Bot API", () => {
  it("عضو / غیرعضو از وضعیت واقعی API", async () => {
    const env = makeEnv();
    const member = await checkChannelMembership(USER_ID, env, {
      fetchFn: telegramRecorder({ memberStatus: "member" }).fetchFn,
    });
    expect(member).toBe("member");

    const notMember = await checkChannelMembership(USER_ID, env, {
      fetchFn: telegramRecorder({ memberStatus: "kicked" }).fetchFn,
    });
    expect(notMember).toBe("not-member");
  });

  it("خطای API هرگز عدم عضویت تفسیر نمیشود → unknown", async () => {
    const env = makeEnv();
    const { fetchFn } = telegramRecorder({
      memberError: "Bad Request: chat not found",
    });
    expect(await checkChannelMembership(USER_ID, env, { fetchFn })).toBe(
      "unknown",
    );
  });

  it("پاسخ ok بدون وضعیت معتبر → unknown", async () => {
    const env = makeEnv();
    const { fetchFn } = telegramRecorder({ memberStatus: "" });
    expect(await checkChannelMembership(USER_ID, env, { fetchFn })).toBe(
      "unknown",
    );
  });
});

describe("allowlist — مجوز جدا از عضویت", () => {
  it("افزودن/بررسی/حذف کاربر", async () => {
    const kv = new MockKV();
    expect(await isUserAllowed(kv, USER_ID)).toBe(false);
    expect((await allowUser(kv, USER_ID, ADMIN_ID)).ok).toBe(true);
    expect(await isUserAllowed(kv, USER_ID)).toBe(true);
    expect((await revokeUser(kv, USER_ID, ADMIN_ID)).ok).toBe(true);
    expect(await isUserAllowed(kv, USER_ID)).toBe(false);
  });

  it("دوباره افزودن → ALREADY_ALLOWED؛ حذف ناموجود → NOT_ALLOWED", async () => {
    const kv = new MockKV();
    await allowUser(kv, USER_ID, ADMIN_ID);
    expect((await allowUser(kv, USER_ID, ADMIN_ID)).reason).toBe(
      "ALREADY_ALLOWED",
    );
    const kv2 = new MockKV();
    expect((await revokeUser(kv2, USER_ID, ADMIN_ID)).reason).toBe(
      "NOT_ALLOWED",
    );
  });

  it("ادمین قابل افزودن/حذف نیست", async () => {
    const kv = new MockKV();
    expect((await allowUser(kv, ADMIN_ID, ADMIN_ID)).reason).toBe(
      "IS_ADMIN_ALREADY",
    );
    await allowUser(kv, USER_ID, ADMIN_ID);
    expect((await revokeUser(kv, ADMIN_ID, ADMIN_ID)).reason).toBe("IS_ADMIN");
  });

  it("شناسه نامعتبر رد میشود", async () => {
    const kv = new MockKV();
    expect((await allowUser(kv, 0, ADMIN_ID)).reason).toBe("INVALID_USER_ID");
    expect((await allowUser(kv, -5, ADMIN_ID)).reason).toBe("INVALID_USER_ID");
    expect((await allowUser(kv, 1.5, ADMIN_ID)).reason).toBe("INVALID_USER_ID");
  });

  it("داده خراب KV → فهرست خالی (fail-closed)", async () => {
    const kv = new MockKV();
    await kv.put(ALLOW_LIST_KEY, "not-json-at-all");
    expect(await listAllowedUsers(kv)).toEqual([]);
    expect(await isUserAllowed(kv, USER_ID)).toBe(false);
  });
});
