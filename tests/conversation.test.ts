import { describe, expect, it } from "vitest";
import {
  clearConversation,
  isConversationExpired,
  readConversation,
  writeConversation,
  type ConversationState,
} from "../src/telegram/conversation";
import { MockKV } from "./helpers";
import { CONVERSATION_TTL_SECONDS } from "../src/telegram/conversation";
import { CONVERSATION_PREFIX } from "../src/state";

const USER_ID = 999111222;

/** زمان «تازه» ثابت در سطح ماژول — هم deterministic و هم غیرمنقضی */
const FRESH = new Date().toISOString();

function sampleState(
  overrides: Partial<
    Extract<ConversationState, { flow: "ticket_create" }>
  > = {},
): ConversationState {
  return {
    flow: "ticket_create",
    step: "subject",
    draft: { subject: "", text: "" },
    promptMessageId: 30,
    promptChatId: USER_ID,
    updatedAt: FRESH,
    ...overrides,
  };
}

describe("writeConversation / readConversation", () => {
  it("نوشتن و خواندن دقیق — کلید per-user", async () => {
    const kv = new MockKV();
    await writeConversation(kv, USER_ID, sampleState());
    const state = await readConversation(kv, USER_ID);
    expect(state).toEqual(sampleState());
    expect(kv.store.has(`${CONVERSATION_PREFIX}${USER_ID}`)).toBe(true);
  });

  it("TTL در گزینهٔ put پاس میشود (انقضای KV)", async () => {
    const kv = new MockKV();
    await writeConversation(kv, USER_ID, sampleState());
    const call = kv.putCalls.find(
      (c) => c.key === `${CONVERSATION_PREFIX}${USER_ID}`,
    );
    expect(call).toBeDefined();
    expect((call?.options as { expirationTtl?: number })?.expirationTtl).toBe(
      CONVERSATION_TTL_SECONDS + 1,
    );
  });

  it("داده خراب → null (fail-closed)", async () => {
    const kv = new MockKV();
    await kv.put(`${CONVERSATION_PREFIX}${USER_ID}`, "{{{corrupt");
    expect(await readConversation(kv, USER_ID)).toBeNull();
  });

  it("state بدون flow معتبر → null", async () => {
    const kv = new MockKV();
    await kv.put(`${CONVERSATION_PREFIX}${USER_ID}`, JSON.stringify({ foo: 1 }));
    expect(await readConversation(kv, USER_ID)).toBeNull();
  });
});

describe("انقضای مکالمه (چک زمانی مستقل از KV TTL)", () => {
  it("state تازه → منقضی نیست", () => {
    expect(isConversationExpired(sampleState({ updatedAt: FRESH }))).toBe(
      false,
    );
  });

  it("state قدیمیتر از TTL → منقضی و حذف در خواندن", async () => {
    const stale = sampleState({
      updatedAt: new Date(
        Date.now() - (CONVERSATION_TTL_SECONDS + 5) * 1000,
      ).toISOString(),
    });
    expect(isConversationExpired(stale)).toBe(true);

    const kv = new MockKV();
    await writeConversation(kv, USER_ID, stale);
    expect(await readConversation(kv, USER_ID)).toBeNull();
    expect(kv.store.has(`${CONVERSATION_PREFIX}${USER_ID}`)).toBe(false);
  });

  it("updatedAt خراب → منقضی (fail-closed)", () => {
    expect(
      isConversationExpired(sampleState({ updatedAt: "not-a-date" })),
    ).toBe(true);
  });
});

describe("clearConversation", () => {
  it("کلید حذف میشود؛ پاک کردن نبوده هم بیخطاست", async () => {
    const kv = new MockKV();
    await writeConversation(kv, USER_ID, sampleState());
    await clearConversation(kv, USER_ID);
    expect(kv.store.has(`${CONVERSATION_PREFIX}${USER_ID}`)).toBe(false);
    await clearConversation(kv, USER_ID); // نبود → بدون خطا
  });

  it("مکالمهٔ دو کاربر جدا است (کلید per-user)", async () => {
    const kv = new MockKV();
    await writeConversation(kv, 1, sampleState());
    await writeConversation(
      kv,
      2,
      sampleState({ step: "text", draft: { subject: "s", text: "" } }),
    );
    await clearConversation(kv, 1);
    expect(await readConversation(kv, 1)).toBeNull();
    expect((await readConversation(kv, 2))?.step).toBe("text");
  });
});
