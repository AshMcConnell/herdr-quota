---
name: quota-herdr
description: Show local provider quota windows (Claude, Codex, Z.ai, Cursor, ...) as a Herdr pane — remaining %, tightest window, reset times and pace, refreshed on a timer. Use when the user asks how much quota/runway/limit is left, which provider to spend next, or to show quota "in herdr"; with no Herdr window it prints the quota-axi table instead.
allowed-tools: Bash(quota-herdr:*)
---

# Quota in Herdr

`quota-herdr` with no arguments opens the quota-axi report as a pane
beside your terminal in the Herdr app: each provider's tightest window,
remaining %, reset time and pace, with not-set-up providers folded into
one line. The pane refreshes itself every 5 minutes; it only ever reads
quota-axi and never refreshes credentials.

| The user wants | Run |
| --- | --- |
| Quota status in a herdr pane | `quota-herdr` |
| The table, JSON or one provider in the terminal | `quota-herdr` with any quota-axi arguments, e.g. `quota-herdr --json`, `quota-herdr --provider claude` |

If Herdr is not running, no-arg `quota-herdr` prints the plain quota-axi
table and says so on stderr. Report the pane's numbers as the answer;
for deeper output (pace detail, spend priority, models) fall back to the
matching quota-axi arguments through the same command.
