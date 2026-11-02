import { describe, test, expect } from "bun:test";
import {
  classifyProvider, scopeLabel, pickTightest, formatReset, formatAge,
  remainingTone, paceText, paceTone, barMode, summarize,
} from "../mods/quota/model.js";
import fixture from "./fixtures/quota-fixture.json" with { type: "json" };
import demoFixture from "./fixtures/quota-demo.json" with { type: "json" };

// 2026-11-02T15:00:00Z — three hours after the fixture's generatedAt.
const NOW = Date.parse("2026-11-02T15:00:00.000Z");

describe("classifyProvider", () => {
  test("fresh is live, stale is stale, the rest unavailable", () => {
    expect(classifyProvider({ state: { status: "fresh" } })).toBe("live");
    expect(classifyProvider({ state: { status: "stale" } })).toBe("stale");
    expect(classifyProvider({ state: { status: "auth_required" } })).toBe("unavailable");
    expect(classifyProvider({ state: { status: "unavailable" } })).toBe("unavailable");
    expect(classifyProvider({ state: { status: "something_new" } })).toBe("unavailable");
    expect(classifyProvider(null)).toBe("unavailable");
  });
});

describe("scopeLabel", () => {
  test("known scopes become people words", () => {
    expect(scopeLabel("all_models")).toBe("all models");
    expect(scopeLabel("model:general")).toBe("general");
    expect(scopeLabel("credits")).toBe("credits");
    expect(scopeLabel("tools")).toBe("tools");
    expect(scopeLabel("")).toBe("");
  });
});

describe("pickTightest", () => {
  test("picks the lowest known availability and resolves its limiting windows", () => {
    const zai = fixture.providers.find((p) => p.provider === "zai");
    const tight = pickTightest(zai);
    expect(tight.percent).toBe(32);
    expect(tight.scope).toBe("all_models");
    expect(tight.label).toBe("all models");
    expect(tight.limiting.map((w) => w.id)).toEqual(["weekly"]);
    expect(tight.pace.status).toBe("behind");
    expect(tight.spendPriority).toBe(5.8239);
  });

  test("prefers all_models on a tie", () => {
    const tie = pickTightest({
      windows: [{ id: "w", label: "w" }],
      quotaSemantics: { effectiveAvailability: [
        { scope: "tools", effectivePercentRemaining: 50, limitingWindowIds: ["w"] },
        { scope: "all_models", effectivePercentRemaining: 50, limitingWindowIds: ["w"] },
      ] },
    });
    expect(tie.scope).toBe("all_models");
  });

  test("null when nothing numeric is known", () => {
    expect(pickTightest(fixture.providers.find((p) => p.provider === "deepseek"))).toBeNull();
    expect(pickTightest(fixture.providers.find((p) => p.provider === "mimo"))).toBeNull();
    expect(pickTightest({ quotaSemantics: { effectiveAvailability: [] } })).toBeNull();
    expect(pickTightest({})).toBeNull();
  });

  test("keeps an unresolved limiting window id instead of dropping it", () => {
    const tight = pickTightest({
      windows: [],
      quotaSemantics: { effectiveAvailability: [
        { scope: "all_models", effectivePercentRemaining: 10, limitingWindowIds: ["gone"] },
      ] },
    });
    expect(tight.limiting.length).toBe(1);
    expect(tight.limiting[0].id).toBe("gone");
    expect(tight.limiting[0].label).toBe("gone");
    expect(tight.limiting[0].resetIn).toBe("");
  });
});

describe("formatReset", () => {
  test("buckets into minutes, hours and days", () => {
    expect(formatReset("2026-11-02T15:40:00.000Z", NOW)).toBe("40m");
    expect(formatReset("2026-11-02T18:12:00.000Z", NOW)).toBe("3h 12m");
    expect(formatReset("2026-11-02T20:00:00.000Z", NOW)).toBe("5h");
    expect(formatReset("2026-11-04T23:00:00.000Z", NOW)).toBe("2d 8h");
    expect(formatReset("2026-11-10T00:00:00.000Z", NOW)).toBe("7d 9h");
  });
  test("past and invalid dates never break the view", () => {
    expect(formatReset("2026-11-02T14:00:00.000Z", NOW)).toBe("resets soon");
    expect(formatReset("not-a-date", NOW)).toBe("");
    expect(formatReset("", NOW)).toBe("");
    expect(formatReset(undefined, NOW)).toBe("");
  });
});

describe("formatAge", () => {
  test("just now, minutes, hours", () => {
    expect(formatAge(NOW - 20_000, NOW)).toBe("just now");
    expect(formatAge(NOW - 4 * 60_000, NOW)).toBe("4m ago");
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatAge(undefined, NOW)).toBe("");
  });
});

describe("tones", () => {
  test("remaining buckets at 60 and 30", () => {
    expect(remainingTone(100)).toBe("ok");
    expect(remainingTone(60)).toBe("ok");
    expect(remainingTone(59)).toBe("warn");
    expect(remainingTone(30)).toBe("warn");
    expect(remainingTone(29)).toBe("low");
    expect(remainingTone(0)).toBe("low");
    expect(remainingTone(null)).toBe("none");
  });
  test("pace text and tone", () => {
    expect(paceText("on_pace")).toBe("on pace");
    expect(paceText("behind")).toBe("behind");
    expect(paceText(null)).toBeNull();
    expect(paceTone("on_pace")).toBe("ok");
    expect(paceTone("behind")).toBe("warn");
    expect(paceTone("unknown")).toBe("none");
  });
});

describe("barMode", () => {
  test("short panes are bars", () => {
    expect(barMode(34)).toBe(true);
    expect(barMode(56)).toBe(true);
    expect(barMode(57)).toBe(false);
    expect(barMode(null)).toBe(false);
    expect(barMode(undefined)).toBe(false);
  });
});

describe("summarize", () => {
  const view = summarize(fixture, NOW);

  test("active providers sort tightest-first", () => {
    expect(view.active.map((p) => p.name)).toEqual(["zai", "claude", "deepseek", "kimi", "mimo"]);
  });

  test("each active row carries the facts the pane shows", () => {
    const claude = view.active.find((p) => p.name === "claude");
    expect(claude.plan).toBe("max");
    expect(claude.status).toBe("live");
    expect(claude.tightest.percent).toBe(77);
    const week = claude.tightest.limiting[0];
    expect(week.label).toBe("week");
    expect(week.resetIn).toBe("5d 9h");
  });

  test("stale providers keep their windows, error and remedy", () => {
    const kimi = view.active.find((p) => p.name === "kimi");
    expect(kimi.status).toBe("stale");
    expect(kimi.tightest).toBeNull();
    expect(kimi.windows.map((w) => w.label)).toEqual(["month", "code month"]);
    expect(kimi.windows[1].percentUsed).toBe(0);
    expect(kimi.error).toBe("kimi_code_cli_credential_expired");
    expect(kimi.remedy).toBe("kimi");
  });

  test("credits and windowless providers stay live with a line to show", () => {
    const deepseek = view.active.find((p) => p.name === "deepseek");
    expect(deepseek.credits.unit).toBe("usd");
    const mimo = view.active.find((p) => p.name === "mimo");
    expect(mimo.windows).toEqual([]);
    expect(mimo.tightest).toBeNull();
  });

  test("not-set-up providers fold away with their reasons", () => {
    expect(view.unavailable).toEqual([
      { name: "cursor", reason: "Cursor sign-in required" },
      { name: "higgsfield", reason: "not set up" },
    ]);
  });

  test("generatedAt parses and empty reports survive", () => {
    expect(view.generatedAt).toBe(Date.parse("2026-11-02T12:00:00.000Z"));
    const empty = summarize({ providers: [] }, NOW);
    expect(empty.active).toEqual([]);
    expect(empty.unavailable).toEqual([]);
    const broken = summarize(null, NOW);
    expect(broken.active).toEqual([]);
  });
});

describe("demo fixture (the repo preview's data)", () => {
  test("summarizes to live rows and folded not-set-up providers", () => {
    const view = summarize(demoFixture);
    expect(typeof view.generatedAt).toBe("number");
    // Every provider that stays active is fresh — the demo shows a healthy
    // fleet, not credential errors.
    for (const p of view.active) {
      expect(p.status).not.toBe("stale");
      expect(p.error).toBeNull();
    }
    expect(view.unavailable.length).toBeGreaterThan(0);
  });

  test("carries resolved timestamps and no leftover placeholders", () => {
    for (const w of demoFixture.providers.flatMap((p) => p.windows ?? [])) {
      if (w.resetsAt != null) {
        expect(typeof w.resetsAt).toBe("string");
        expect(Number.isNaN(Date.parse(w.resetsAt))).toBe(false);
      }
    }
    expect(JSON.stringify(demoFixture).includes("PLACEHOLDER")).toBe(false);
  });
});
