#!/bin/sh
# Launcher tests: run bin/quota-herdr against stub quota-axi / herdr-app
# binaries on PATH and assert the commands it issues. POSIX sh, no bun.
#   sh tests/launcher.test.sh
#
# Env for each case is set through TERM_ID / PLACE / WINDOW variables that
# run() maps explicitly onto the child: prefixing a function call with
# FOO=x leaks into later cases under POSIX sh, which cost us an afternoon
# once already.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# Real jq (the launcher needs it); everything else is a stub.
ln -s "$(command -v jq)" "$work/bin/jq"

cat > "$work/bin/quota-axi" <<'EOF'
#!/bin/sh
echo "quota-axi args: $*" >> "$QUOTA_TEST_LOG"
echo "quota table"
EOF
cat > "$work/bin/herdr-app" <<'EOF'
#!/bin/sh
echo "herdr-app $*" >> "$QUOTA_TEST_LOG"
case "$1 $2" in
  "status "*) [ "${QUOTA_TEST_WINDOW:-yes}" = yes ] && exit 0 || exit 1 ;;
  "ls "*) cat "$QUOTA_TEST_LS" ;;
  "do "*) exit 0 ;;
esac
exit 0
EOF
chmod +x "$work/bin/quota-axi" "$work/bin/herdr-app"

cat > "$work/ls.json" <<'EOF'
{ "spaces": [ { "id": "s1", "machine": null, "tabs": [ { "terminals": [
  { "terminal": "t9", "pane": "pAgent" },
  { "terminal": "t4", "pane": "pOther" }
] } ] }, { "id": "s2", "machine": "vps", "tabs": [] } ] }
EOF

# Per-case knobs run() maps onto the child environment.
TERM_ID=""
PLACE=""
WINDOW=yes

run() {
  QUOTA_TEST_LOG="$work/log" QUOTA_TEST_LS="$work/ls.json" \
  HC_TERMINAL_ID="$TERM_ID" QUOTA_HERDR_PLACE="$PLACE" QUOTA_TEST_WINDOW="$WINDOW" \
  PATH="$work/bin:$PATH" sh "$here/bin/quota-herdr" ${1+"$@"}
}

fails=0
check() { # check <name> <expected substring in log>
  if grep -qF "$2" "$work/log"; then
    echo "(pass) $1"
  else
    echo "(fail) $1: log does not contain: $2" && cat "$work/log" && fails=$((fails + 1))
  fi
}
absent() {
  if grep -qF "$2" "$work/log"; then
    echo "(fail) $1: log unexpectedly contains: $2" && cat "$work/log" && fails=$((fails + 1))
  else
    echo "(pass) $1"
  fi
}

# 1. Any argument passes straight through to quota-axi; herdr untouched.
: > "$work/log"; run --json >/dev/null 2>&1
check "args pass through to quota-axi" "quota-axi args: --json"
absent "passthrough never calls herdr-app" "herdr-app"

# 2. No herdr window: print the table instead.
: > "$work/log"; TERM_ID=""; WINDOW=no; run >/dev/null 2>&1
check "no window falls back to table" "quota-axi args: "
absent "no window issues no pane commands" "herdr-app do"
WINDOW=yes

# 3. Window + agent terminal: split beside it.
: > "$work/log"; TERM_ID=t9; PLACE=""; run >/dev/null 2>&1
check "split right of the agent pane" "herdr-app do pane.split --direction right --pane pAgent --mod quota"

# 4. Same, placed down.
: > "$work/log"; PLACE=down; run >/dev/null 2>&1
check "split down of the agent pane" "herdr-app do pane.split --direction down --pane pAgent --mod quota"

# 5. Tab placement ignores the terminal.
: > "$work/log"; PLACE=tab; run >/dev/null 2>&1
check "tab placement opens a named tab" "herdr-app do tab.new --name Quota --mod quota"
absent "tab placement does not split" "pane.split"

# 6. No terminal id: a tab, not a split.
: > "$work/log"; TERM_ID=""; PLACE=""; run >/dev/null 2>&1
check "no terminal id opens a tab" "herdr-app do tab.new --name Quota --mod quota"

# 7. Terminal on another machine's space: no local pane, so a tab.
: > "$work/log"; TERM_ID=t404; run >/dev/null 2>&1
check "unknown terminal id opens a tab" "herdr-app do tab.new --name Quota --mod quota"
TERM_ID=""

# 8. quota-axi missing entirely: fail loudly rather than pretend. The PATH
# holds only the stubs and system binaries, so a real quota-axi on the
# developer's PATH cannot satisfy the check.
: > "$work/log"; rm "$work/bin/quota-axi"
if QUOTA_TEST_LOG="$work/log" PATH="$work/bin:/usr/bin:/bin" sh "$here/bin/quota-herdr" >/dev/null 2>&1; then
  echo "(fail) missing quota-axi exits 0" && fails=$((fails + 1))
else
  echo "(pass) missing quota-axi exits nonzero"
fi

if [ "$fails" -gt 0 ]; then
  echo "$fails launcher test(s) failed"
  exit 1
fi
echo "all launcher tests passed"
