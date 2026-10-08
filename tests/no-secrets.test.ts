import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * اسکن بهداشتی مخزن — مطابق قوانین امنیتی پروژه:
 *  • هیچ الگوی credential در فایلهای پروژه نباید باشد
 *  • .gitignore باید env/secretها را پوشش دهد
 *  • .env.example فقط نام متغیرها را داشته باشد (بدون مقدار Secret)
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "coverage",
  "dist",
]);

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["github fine-grained PAT", /github_pat_[A-Za-z0-9_]{16,}/],
  ["github classic PAT", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/],
  ["aws access key", /AKIA[0-9A-Z]{16}/],
  ["openai-style key", /sk-[A-Za-z0-9]{20,}/],
  ["gitlab token", /glpat-[A-Za-z0-9_-]{15,}/],
  ["slack token", /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

const SECRET_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "ADMIN_USER_ID",
  "CHANNEL_ID",
  "PRICE_API_KEY",
];

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const ROOT_FILES = [
  ".gitignore",
  ".env.example",
  ".dev.vars.example",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "wrangler.toml",
  "vitest.config.ts",
  "README.md",
]
  .map((name) => join(ROOT, name))
  .filter((path) => existsSync(path));

describe("بهداشت امنیتی مخزن", () => {
  it("هیچ الگوی credential در فایلهای پروژه وجود ندارد", () => {
    const files = [
      ...collectTsFiles(join(ROOT, "src")),
      ...collectTsFiles(join(ROOT, "tests")),
      ...ROOT_FILES,
    ];
    expect(files.length).toBeGreaterThan(30);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const [label, pattern] of SECRET_PATTERNS) {
        expect(pattern.test(content), `${label} در ${file} پیدا شد`).toBe(false);
      }
    }
  });

  it(".gitignore فایلهای env و secret را پوشش می‌دهد", () => {
    const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    expect(gitignore).toMatch(/^\.dev\.vars$/m);
    expect(gitignore).toMatch(/^\.env$/m);
    expect(gitignore).toMatch(/^node_modules\/$/m);
    expect(gitignore).toMatch(/^\.wrangler\/$/m);
  });

  it(".env.example برای متغیرهای حساس هیچ مقداری ندارد", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const line of example.split("\n")) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (match && match[1] && SECRET_VARS.includes(match[1])) {
        expect(match[2], `${match[1]} باید در .env.example خالی باشد`).toBe("");
      }
    }
    expect(example).toContain("TELEGRAM_BOT_TOKEN=");
  });
});
