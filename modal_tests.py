"""Run a review's targeted tests on Modal CPU and write .review/checks/tests.json.

The extension runs this in a VS Code terminal:
    REVIEW_ROOT=/abs/repo REVIEW_TESTS='{"targets": [...], "install": "..."}' modal run modal_tests.py

REVIEW_TESTS comes from review.json "tests": targets (pytest node ids or files),
install (shell, run in the repo inside the image), python, ignore, cpu, memory.
Only the listed targets run. There is no full-suite fallback.
"""

import json
import os
import pathlib
import time
import xml.etree.ElementTree as ET

import modal

ROOT = os.environ.get("REVIEW_ROOT", "/repo")
CFG = json.loads(os.environ.get("REVIEW_TESTS") or "{}")
IGNORE = CFG.get("ignore") or [".git", ".review", ".venv", "venv", "node_modules", "**/__pycache__", "**/*.egg-info"]

app = modal.App("review-handoff-tests")
image = (
    modal.Image.debian_slim(python_version=str(CFG.get("python", "3.11")))
    .pip_install("pytest")
    .add_local_dir(ROOT, "/repo", ignore=IGNORE, copy=True)
    .run_commands(f"cd /repo && {CFG.get('install') or 'pip install -e .'}")
)


@app.function(image=image, cpu=float(CFG.get("cpu", 2)), memory=int(CFG.get("memory", 4096)), timeout=1800)
def run(targets: list[str]) -> dict:
    import subprocess

    p = subprocess.run(
        ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "--junitxml=/tmp/j.xml", *targets],
        cwd="/repo", capture_output=True, text=True,
    )
    xml = pathlib.Path("/tmp/j.xml").read_text() if pathlib.Path("/tmp/j.xml").exists() else ""
    out = (p.stdout + p.stderr).splitlines()
    return {"rc": p.returncode, "xml": xml, "tail": "\n".join(out[-40:])}


def summarize(res: dict, targets: list[str]) -> dict:
    s = {"ranAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "where": "Modal CPU", "targets": targets,
         "rc": res["rc"], "passed": 0, "failed": 0, "errors": 0, "skipped": 0, "failures": [], "tail": res["tail"]}
    if res["xml"]:
        for case in ET.fromstring(res["xml"]).iter("testcase"):
            bad = case.find("failure") if case.find("failure") is not None else case.find("error")
            if bad is not None:
                s["failed" if bad.tag == "failure" else "errors"] += 1
                msg = (bad.get("message") or bad.text or "").strip().splitlines()
                s["failures"].append({"test": f"{case.get('classname')}::{case.get('name')}", "message": "\n".join(msg[:6])})
            elif case.find("skipped") is not None:
                s["skipped"] += 1
            else:
                s["passed"] += 1
    return s


@app.local_entrypoint()
def main():
    targets = CFG.get("targets") or []
    if not targets:
        raise SystemExit("review.json has no tests.targets; nothing to run.")
    out = pathlib.Path(ROOT, ".review", "checks", "tests.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"running": True, "ranAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "targets": targets}))
    s = summarize(run.remote(targets), targets)
    out.write_text(json.dumps(s, indent=2) + "\n")
    print(f"\n{s['passed']} passed, {s['failed']} failed, {s['errors']} errors, {s['skipped']} skipped -> {out}")
