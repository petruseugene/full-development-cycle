#!/usr/bin/env python3
# SessionStart hook body: injects the compact dev-cycle routing primer
# (skills/using-dev-cycle/primer.md) with {{ROOT}} resolved to the plugin root,
# plus a resume hint on compact/resume. Called from session-start.sh.
import json, os, re, subprocess, sys

if not os.environ.get("CLAUDE_PLUGIN_ROOT"):
    sys.exit(0)
root = os.path.realpath(os.environ["CLAUDE_PLUGIN_ROOT"])
primer = os.path.join(root, "skills", "using-dev-cycle", "primer.md")
if not os.path.isfile(primer):
    sys.exit(0)
text = open(primer, encoding="utf-8").read().replace("{{ROOT}}", root)
banner = "dev-cycle plugin active - route requests per the primer below.\n\n"
ctx = banner + text


NAME_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}h-[0-9]{2}m-[A-Za-z0-9._-]+\Z")
PHASE_RE = re.compile(r"^[a-z0-9._=-]+\Z")
PATH_RE = re.compile(r"^[A-Za-z0-9._/@+~-]+\Z")


def git(cwd, *args):
    r = subprocess.run(["git", "-C", cwd] + list(args), capture_output=True,
                       text=True, timeout=2, shell=False)
    if r.returncode != 0:
        raise RuntimeError("git")
    return r.stdout.strip()


def hint():
    if sys.stdin is None or sys.stdin.isatty():
        return None
    data = json.loads(sys.stdin.read(65536) or "null")
    if not isinstance(data, dict) or data.get("source") not in ("compact", "resume"):
        return None
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not os.path.isdir(cwd):
        return None
    top = git(cwd, "rev-parse", "--show-toplevel")
    branch = git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    if not os.path.isdir(os.path.join(top, "docs", "features")):
        common = git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")
        top = os.path.dirname(common.rstrip("/"))
    feats = os.path.join(top, "docs", "features")
    if not os.path.isdir(feats):
        return None
    base = os.path.realpath(feats)
    best = None
    for name in sorted(os.listdir(feats), reverse=True):
        if not NAME_RE.match(name):
            continue
        d = os.path.join(feats, name)
        real = os.path.realpath(d)
        if os.path.commonpath([base, real]) != base or not os.path.isdir(real):
            continue
        fj = os.path.join(real, "feature.json")
        try:
            if os.path.getsize(fj) > 1048576:
                continue
            with open(fj, encoding="utf-8") as f:
                j = json.load(f)
            ph = j.get("current_phase")
            if j.get("branch") == branch and ph != "done":
                if not (isinstance(ph, str) and PHASE_RE.match(ph)):
                    continue
                best = (name, j.get("current_phase"), real)
                break
        except Exception:
            continue
    if not best:
        return None
    name, phase, real = best
    if not (PATH_RE.match(root) and PATH_RE.match(real)):
        return None
    return ("dev-cycle: active feature %s (phase %s). Orchestrator: run node \"%s/scripts/dev-cycle.mjs\" "
            "feature resume --feature \"%s\" and continue from its next: lines." % (name, phase, root, real))


try:
    h = hint()
except Exception:
    h = None
if h:
    ctx = ctx.rstrip("\n") + "\n" + h
print(json.dumps({"hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": ctx,
}}))
