#!/usr/bin/env bash
# Report .desktop entries whose Exec line will not launch.
#
# The launcher runs applications without a shell, so an entry can be valid to
# the eye and still fail: a program that is not on PATH, or a Flatpak app whose
# runtime is missing. This checks every entry the launcher would show and lists
# the ones that cannot start, without launching anything.
#
# Usage: scripts/check-desktop-entries.sh [--verbose]
set -uo pipefail

VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

DIRS=(
  /usr/share/applications
  /usr/local/share/applications
  "$HOME/.local/share/applications"
)

total=0; ok=0; broken=0

# Mirror the Rust parser: strip field codes, honour single and double quotes.
first_arg() {
  python3 - "$1" <<'PY'
import sys, shlex
exec_line = sys.argv[1]
try:
    argv = shlex.split(exec_line)
except ValueError:
    argv = exec_line.split()
FIELD = {"%f","%F","%u","%U","%d","%D","%n","%N","%i","%c","%k","%v","%m"}
argv = [a for a in argv if a not in FIELD]
print(argv[0] if argv else "")
PY
}

echo "Checking .desktop entries the launcher would show..."
echo

for dir in "${DIRS[@]}"; do
  [ -d "$dir" ] || continue
  for file in "$dir"/*.desktop; do
    [ -f "$file" ] || continue

    # Only the [Desktop Entry] group, matching the launcher's own parsing.
    entry=$(awk '/^\[Desktop Entry\]/{f=1;next} /^\[/{f=0} f' "$file")
    type=$(grep -m1 '^Type=' <<<"$entry" | cut -d= -f2-)
    name=$(grep -m1 '^Name=' <<<"$entry" | cut -d= -f2-)
    exec_line=$(grep -m1 '^Exec=' <<<"$entry" | cut -d= -f2-)
    hidden=$(grep -m1 '^Hidden=' <<<"$entry" | cut -d= -f2-)

    [ "$type" = "Application" ] || continue
    [ -n "$exec_line" ] || continue
    [ "$hidden" = "true" ] && continue

    total=$((total + 1))
    program=$(first_arg "$exec_line")
    [ -n "$program" ] || continue

    reason=""
    if [[ "$program" = /* ]]; then
      if [ ! -x "$program" ]; then
        # A path with unquoted spaces splits into several arguments, so the
        # first one names a file that does not exist. The entry is malformed,
        # not the target missing -- say so, because the fix is different.
        if [ -x "$exec_line" ]; then
          reason="path has unquoted spaces: $exec_line"
        else
          reason="not executable: $program"
        fi
      fi
    elif ! command -v "$program" >/dev/null 2>&1; then
      reason="not on PATH: $program"
    fi

    # A Flatpak entry is only launchable if that app id is installed.
    if [ -z "$reason" ] && [ "$(basename "$program")" = "flatpak" ]; then
      app_id=$(python3 - "$exec_line" <<'PY'
import sys, shlex, re
try: argv = shlex.split(sys.argv[1])
except ValueError: argv = sys.argv[1].split()
for a in argv[1:]:
    if not a.startswith("-") and a != "run" and re.match(r'^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){2,}$', a):
        print(a); break
PY
)
      if [ -n "$app_id" ] && command -v flatpak >/dev/null 2>&1; then
        flatpak info "$app_id" >/dev/null 2>&1 || reason="flatpak app not installed: $app_id"
      fi
    fi

    if [ -n "$reason" ]; then
      broken=$((broken + 1))
      printf '  \033[31mBROKEN\033[0m  %-38s %s\n' "${name:0:38}" "$reason"
      [ "$VERBOSE" = 1 ] && printf '          %s\n          Exec=%s\n' "$file" "$exec_line"
    else
      ok=$((ok + 1))
      [ "$VERBOSE" = 1 ] && printf '  ok      %-38s %s\n' "${name:0:38}" "$program"
    fi
  done
done

echo
echo "$total entries checked: $ok launchable, $broken broken"
[ "$broken" -gt 0 ] && echo "(re-run with --verbose to see the files)"
exit 0
