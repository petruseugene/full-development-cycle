#!/usr/bin/env bash
# Validates every SKILL.md has: YAML frontmatter with `name` and `description`,
# plus the four required sections. Skills listed in STRICT_CAP_SKILLS are also
# capped at 60 lines (frontmatter included). Exits non-zero on first failure.

set -euo pipefail
ROOT="${1:-skills}"
EXTRA_DIRS=(commands hooks .claude-plugin)
fail=0

# Skills introduced in skill-pack-v2 onward — must stay ≤ 60 lines.
STRICT_CAP_SKILLS=(cli-fallback security-reviewer)
STRICT_CAP_LINES=60

is_strict_cap() {
  local name="$1"
  for s in "${STRICT_CAP_SKILLS[@]}"; do
    [[ "$s" == "$name" ]] && return 0
  done
  return 1
}

for f in "$ROOT"/*/SKILL.md; do
  name=$(awk '/^name:/{print $2; exit}' "$f")
  desc=$(awk '/^description:/{sub(/^description: */,""); print; exit}' "$f")
  [[ -z "$name" ]] && { echo "FAIL $f: missing 'name' in frontmatter"; fail=1; }
  [[ -z "$desc" ]] && { echo "FAIL $f: missing 'description' in frontmatter"; fail=1; }
  if [[ "$name" == "playbook" ]]; then
    continue_sections=1
  else
    continue_sections=0
  fi
  if [[ "$continue_sections" -eq 0 ]]; then
    for section in "## When to use" "## Required reading" "## The job" "## Output contract"; do
      grep -qE "^${section}\$" "$f" || { echo "FAIL $f: missing section '$section'"; fail=1; }
    done
  fi
  if is_strict_cap "$name"; then
    lines=$(wc -l < "$f" | tr -d ' ')
    if [[ "$lines" -gt "$STRICT_CAP_LINES" ]]; then
      echo "FAIL $f: $lines lines (cap ${STRICT_CAP_LINES} for strict-cap skill '$name')"
      fail=1
    fi
  fi
done

# playbook/SKILL.md must exist and be non-empty
[[ -s "$ROOT/playbook/SKILL.md" ]] || { echo "FAIL $ROOT/playbook/SKILL.md: missing or empty"; fail=1; }

# The frontmatter name must match the directory name
for f in "$ROOT"/*/SKILL.md; do
  dir=$(basename "$(dirname "$f")")
  name=$(awk '/^name:/{print $2; exit}' "$f")
  [[ "$dir" == "$name" ]] || { echo "FAIL $f: frontmatter name '$name' != directory '$dir'"; fail=1; }
done

# No legacy paths and no absolute paths
if grep -rn '\.claude/skills' "$ROOT" "${EXTRA_DIRS[@]}" >/dev/null 2>&1; then
  echo "FAIL: legacy .claude/skills reference found under $ROOT or ${EXTRA_DIRS[*]}"; fail=1
fi
if grep -rn '/Users/' "$ROOT" "${EXTRA_DIRS[@]}" >/dev/null 2>&1; then
  echo "FAIL: absolute /Users/ path found under $ROOT or ${EXTRA_DIRS[*]}"; fail=1
fi

# Skill dispatch references must be namespaced
bare=$(grep -rEo '`(orchestrator|discovery|architector|spec-writer|wireframer|plan-writer|frontend-dev|backend-dev|auto-tester|code-reviewer|visual-tester|security-reviewer|cli-fallback|playbook)`' "$ROOT" "${EXTRA_DIRS[@]}" | wc -l | tr -d ' ' || true)
if [[ "$bare" != "0" ]]; then
  echo "FAIL: $bare un-namespaced skill reference(s) under $ROOT or ${EXTRA_DIRS[*]} — expected \`dev-cycle:<name>\`"
  grep -rEn '`(orchestrator|discovery|architector|spec-writer|wireframer|plan-writer|frontend-dev|backend-dev|auto-tester|code-reviewer|visual-tester|security-reviewer|cli-fallback|playbook)`' "$ROOT" "${EXTRA_DIRS[@]}" | head -10
  fail=1
fi

# --- Flag guards: the 13 flagged skills carry disable-model-invocation, the 2 entry skills do not.
FLAGGED_SKILLS=(playbook using-dev-cycle discovery spec-writer wireframer plan-writer frontend-dev backend-dev auto-tester code-reviewer security-reviewer visual-tester cli-fallback)
UNFLAGGED_SKILLS=(orchestrator architector)

fm_flag_line() { # prints line number of the flag inside frontmatter, or nothing
  awk 'NR==1&&$0!="---"{exit} NR>1&&$0=="---"{exit} /^disable-model-invocation: *true/{print NR; exit}' "$1"
}
for s in "${FLAGGED_SKILLS[@]}"; do
  f="$ROOT/$s/SKILL.md"
  [[ -f "$f" ]] || { echo "FAIL $f:1: flagged skill '$s' missing"; fail=1; continue; }
  [[ -n "$(fm_flag_line "$f")" ]] || { echo "FAIL $f:1: '$s' lacks 'disable-model-invocation: true'"; fail=1; }
done
for s in "${UNFLAGGED_SKILLS[@]}"; do
  f="$ROOT/$s/SKILL.md"
  [[ -f "$f" ]] || continue
  l=$(fm_flag_line "$f")
  [[ -z "$l" ]] || { echo "FAIL $f:$l: '$s' must not carry 'disable-model-invocation'"; fail=1; }
done

# --- No Skill-tool instruction may point at a flagged skill.
flagged_re=$(IFS='|'; echo "${FLAGGED_SKILLS[*]}")
scan=("$ROOT" "$ROOT/../commands" "$ROOT/../hooks" "$ROOT/../scripts/session-start.sh" "$ROOT/../README.md")
existing=()
for p in "${scan[@]}"; do [[ -e "$p" ]] && existing+=("$p"); done
if [[ ${#existing[@]} -gt 0 ]]; then
  hits=$(grep -rnE "Skill\(dev-cycle:(${flagged_re})\)|(Invoke|invoke|Use) (the )?\`dev-cycle:(${flagged_re})\`" "${existing[@]}" 2>/dev/null || true)
  hits2=$(grep -rn 'Skill tool' "${existing[@]}" 2>/dev/null | grep -E "dev-cycle:(${flagged_re})([^a-z-]|\$)" || true)
  if [[ -n "$hits$hits2" ]]; then
    printf '%s\n%s\n' "$hits" "$hits2" | sed '/^$/d' | sort -u | while IFS= read -r l; do
      echo "FAIL ${l%%:*}:$(echo "$l" | cut -d: -f2): Skill-tool instruction targets a flagged skill"
    done
    fail=1
  fi
fi

# --- Playbook split: core <= 4800 bytes, lifecycle present, required sections.
core="$ROOT/playbook/SKILL.md"
life="$ROOT/playbook/references/lifecycle.md"
if [[ -s "$core" ]]; then
  size=$(wc -c < "$core" | tr -d ' ')
  [[ "$size" -le 4800 ]] || { echo "FAIL $core:1: core is $size bytes (cap 4800)"; fail=1; }
  for n in 2 3 6 8; do
    grep -qE "^## ${n}\." "$core" || { echo "FAIL $core:1: core missing '## ${n}.'"; fail=1; }
  done
fi
if [[ ! -s "$life" ]]; then
  echo "FAIL $life:1: lifecycle.md missing or empty"; fail=1
else
  for n in 1 4 5 7 10; do
    grep -qE "^## ${n}\." "$life" || { echo "FAIL $life:1: lifecycle missing '## ${n}.'"; fail=1; }
  done
fi

if [[ $fail -eq 0 ]]; then
  echo "OK: all skills validate"
fi
exit $fail
