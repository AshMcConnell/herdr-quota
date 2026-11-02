import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, run, home, readTextFile, props } from "herdr";
import {
  summarize, barMode, remainingTone, paceText, formatReset, formatAge,
} from "./model.js";

// Reads quota-axi only. --no-credential-refresh keeps every read from
// delegating a credential renewal to the vendor CLI; --max-age lets the
// background poll reuse quota-axi's last reading instead of re-asking
// every vendor each time.
const FETCH_MS = 5 * 60_000;
const TICK_MS = 60_000;
const MAX_AGE = "4m";
const BAR_CHIPS = 6;

// The app's own PATH often lacks version managers (mise, Homebrew-only
// login shells), so plain exec("quota-axi") fails on machines where the
// CLI plainly works in a terminal. Try PATH first, then the usual
// install prefixes.
const QUOTA_AXI_CANDIDATES = () => [
  "quota-axi",
  `${home()}/.local/share/mise/shims/quota-axi`,
  `${home()}/.local/bin/quota-axi`,
  "/opt/homebrew/bin/quota-axi",
  "/usr/local/bin/quota-axi",
];

function stderrTail(stderr) {
  const lines = String(stderr ?? "").trim().split("\n");
  return lines[lines.length - 1] ?? "";
}

export default class Quota extends View {
  init(_props, cx) {
    this.size = null;
    this.now = Date.now();
    this.raw = null;
    this.view = null;
    this.state = { name: "loading" };
    this.fetching = false;
    this.expanded = false;
    // Demo mode (`tab.new --mod quota --props '{"demo": "<path>"}'`):
    // read one static quota-axi JSON file instead of polling the real
    // CLI. Used for the repo's preview and manual inspection — never
    // touches credentials or quota-axi itself.
    this.demoFile = typeof props()?.demo === "string" && props().demo ? props().demo : null;
    this.fetch(cx);
    cx.timer.every(FETCH_MS, (cx) => this.fetch(cx));
    cx.timer.every(TICK_MS, (cx) => {
      this.now = Date.now();
      if (this.raw) this.view = summarize(this.raw, this.now);
      cx.notify();
    });
  }

  fetch(cx, { force = false } = {}) {
    if (this.fetching) return;
    this.fetching = true;
    if (this.demoFile) {
      cx.spawn(async (cx) => {
        this.now = Date.now();
        try {
          const text = await readTextFile(this.demoFile);
          if (text === null) throw new Error("demo file not found");
          this.raw = JSON.parse(text);
          this.view = summarize(this.raw, this.now);
          this.state = { name: "ready" };
        } catch (e) {
          this.state = { name: "error", message: `demo file could not be read: ${e?.message ?? e}` };
        }
        this.fetching = false;
        cx.notify();
      });
      return;
    }
    const args = ["--json", "--no-credential-refresh"];
    if (!force) args.push("--max-age", MAX_AGE);
    cx.spawn(async (cx) => {
      // Try each candidate until one starts; a started quota-axi that
      // exits nonzero is a real error, not a reason to try the next path.
      let r = null;
      let lastError = null;
      for (const bin of QUOTA_AXI_CANDIDATES()) {
        try {
          r = await exec(bin, args);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
        }
      }
      this.now = Date.now();
      try {
        if (r && r.code === 0) {
          this.raw = JSON.parse(r.stdout);
          this.view = summarize(this.raw, this.now);
          this.state = { name: "ready" };
        } else {
          const message = r
            ? stderrTail(r.stderr) || `quota-axi exited ${r.code}`
            : String(lastError?.message ?? lastError);
          this.state = {
            name: "error",
            message: /could not be started|not found|no such|cannot start|permission denied/i.test(message)
              ? "quota-axi is not installed (or not on PATH). Install quota-axi, then reopen this pane."
              : message,
          };
        }
      } catch (e) {
        this.state = { name: "error", message: `quota-axi output was not JSON: ${e?.message ?? e}` };
      }
      this.fetching = false;
      cx.notify();
    });
  }

  toneColor(t, tone) {
    return { ok: t.done, warn: t.ansi3, low: t.blocked }[tone] ?? t.muted;
  }

  percentColor(t, percent) {
    return this.toneColor(t, remainingTone(percent));
  }

  button(t, id, label, onClick, { busy = false } = {}) {
    return div().id(id).h(26).px(10).flex().items_center().rounded(6).text_size(12)
      .border_1().border_color(t.border).bg(t.surface).text_color(t.foreground)
      .when(busy, (el) => el.opacity(0.5))
      .when(!busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)))
      .child(busy ? "Reading…" : label);
  }

  /** The one-line text under a provider's name, or null when the
   *  provider has nothing quantified to say. */
  providerLine(p) {
    const tight = p.tightest;
    if (tight) {
      const parts = [tight.label || "quota"];
      const labels = tight.limiting.map((w) => w.label ?? w.id);
      parts.push(labels.length > 2 ? `${labels.length} windows` : labels.join(" + "));
      const firstReset = tight.limiting.map((w) => w.resetsAt).filter(Boolean).sort()[0];
      const resetIn = firstReset ? formatReset(firstReset, this.now) : "";
      if (resetIn) parts.push(`resets in ${resetIn}`);
      const pace = paceText(tight.pace?.status);
      if (pace) parts.push(pace);
      if (typeof tight.spendPriority === "number") parts.push(`priority ${tight.spendPriority.toFixed(1)}`);
      return parts.join(" · ");
    }
    if (p.credits && typeof p.credits.remaining === "number") {
      return `${p.credits.unit ?? "credits"} · ${p.credits.remaining} remaining${p.credits.unlimited ? " (unlimited)" : ""}`;
    }
    if (p.windows.length) {
      return p.windows
        .map((w) => (w.percentRemaining != null ? `${w.label} · ${w.percentRemaining}% left` : `${w.label} · ${w.percentUsed}% used`))
        .join(" · ");
    }
    return "no quota windows reported";
  }

  bar(track, pct, color) {
    return track.h(4).rounded(2).overflow_hidden()
      .child(div().h(4).rounded(2).bg(color).w(`${Math.max(0, Math.min(100, pct))}%`));
  }

  detail(id, text, color) {
    return div().id(id).min_w(0).truncate().text_size(11.5).text_color(color).child(text);
  }

  providerRow(t, p) {
    const pct = p.tightest?.percent ?? null;
    const color = pct != null ? this.percentColor(t, pct) : null;
    return v_flex().id(`p-${p.name}`).flex_none().px(12).py(8).gap(4)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child(p.name))
        .when(!!p.plan, (el) => el.child(div().text_size(11).text_color(t.dim).child(p.plan)))
        .when(p.status === "stale", (el) => el
          .child(div().px(6).py(1).rounded(8).bg(t.surface).border_1().border_color(t.border)
            .text_size(10.5).text_color(t.ansi3).child("stale")))
        .child(div().flex_1())
        .when(pct != null, (el) => el
          .child(div().text_size(14).font_semibold().text_color(color).child(`${pct}%`))))
      .child(this.detail(`line-${p.name}`, this.providerLine(p), t.muted))
      .when(pct != null, (el) => el.child(this.bar(h_flex(), pct, color)))
      .when(p.status === "stale", (el) => el
        .child(this.detail(`stale-${p.name}`,
          `stale: ${p.error ?? "reading is old"}${p.remedy ? ` · run ${p.remedy} to refresh` : ""}`, t.ansi3)));
  }

  unavailableSection(t) {
    const list = this.view?.unavailable ?? [];
    if (!list.length) return null;
    if (!this.expanded) {
      const names = list.map((u) => u.name).join(" · ");
      return h_flex().id("off").flex_none().px(12).py(6).gap(6).items_center()
        .child(this.detail("off-names", `${list.length} not set up: ${names}`, t.dim))
        .child(div().id("off-more").flex_none().text_size(11.5).text_color(t.muted).cursor_pointer()
          .rounded(4).px(4).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.expanded = true; cx.notify(); })
          .child("show"));
    }
    return v_flex().id("off").flex_none().px(12).py(6).gap(3)
      .child(h_flex().gap(6).items_center()
        .child(div().text_size(11.5).text_color(t.dim).child(`${list.length} not set up`))
        .child(div().id("off-less").text_size(11.5).text_color(t.muted).cursor_pointer()
          .rounded(4).px(4).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.expanded = false; cx.notify(); })
          .child("hide")))
      .children(list.map((u) => this.detail(`off-${u.name}`, `${u.name} — ${u.reason}`, t.dim)));
  }

  centered(t, text, color) {
    return v_flex().flex_1().items_center().justify_center().p(24)
      .child(div().text_size(13).text_color(color ?? t.muted).child(text));
  }

  body(t) {
    switch (this.state.name) {
      case "loading":
        return this.centered(t, "Reading quota-axi…");
      case "error":
        return this.centered(t, this.state.message, t.blocked);
      default: {
        const active = this.view?.active ?? [];
        const off = this.unavailableSection(t);
        if (!active.length && !off) return this.centered(t, "No providers reported.");
        return v_flex().flex_1().min_h(0).overflow_y_scrollbar()
          .children(active.map((p) => this.providerRow(t, p)))
          .when(!!off, (el) => el.child(off));
      }
    }
  }

  /** Docked short: one row of the tightest providers. Clicking opens the
   *  full pane in a tab. */
  barRow(t) {
    if (this.state.name === "error") {
      return h_flex().size_full().px(10).items_center().text_size(11.5).text_color(t.blocked)
        .child(div().min_w(0).truncate().child(`quota: ${this.state.message}`));
    }
    const active = (this.view?.active ?? []).filter((p) => p.tightest?.percent != null);
    const shown = active.slice(0, BAR_CHIPS);
    const more = active.length - shown.length;
    const off = this.view?.unavailable?.length ?? 0;
    return h_flex().id("quota-bar").size_full().px(10).gap(10).items_center()
      .text_size(11.5).cursor_pointer()
      .on_click(() => run("tab.new", { name: "Quota", mod: "quota" }))
      .tooltip("Open the quota pane")
      .children(shown.map((p) =>
        h_flex().id(`chip-${p.name}`).flex_none().gap(4).items_center()
          .child(div().text_color(t.muted).child(p.name))
          .child(div().text_color(this.percentColor(t, p.tightest.percent)).child(`${p.tightest.percent}%`))))
      .when(more > 0, (el) => el.child(div().flex_none().text_color(t.dim).child(`+${more}`)))
      .when(off > 0, (el) => el.child(div().flex_none().text_color(t.dim).child(`· ${off} off`)))
      .child(div().flex_1())
      .when(this.view?.generatedAt != null, (el) =>
        el.child(div().flex_none().text_color(t.dim).child(formatAge(this.view.generatedAt, this.now))));
  }

  render(_cx) {
    const t = theme();
    const root = v_flex().id("quota-root").size_full().bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); });
    if (barMode(this.size?.height)) return root.child(this.barRow(t));
    return root
      .child(h_flex().flex_none().h(40).px(12).gap(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Quota"))
        .child(this.detail("age",
          this.state.name === "ready" && this.view?.generatedAt != null
            ? `quota-axi · ${formatAge(this.view.generatedAt, this.now)}`
            : "quota-axi", t.muted))
        .child(div().flex_1())
        .child(this.button(t, "refresh", "Refresh", (cx) => this.fetch(cx, { force: true }), { busy: this.fetching })))
      .child(this.body(t));
  }
}
