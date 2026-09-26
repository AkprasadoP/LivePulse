#!/usr/bin/env python3
"""Phase 8.1 smoke: launch server via shell, run 5s load test, capture nonzero result.

Handles the known macOS shell-launch drop by polling the socket and restarting
the server if it vanishes before or during the load run.
"""
from __future__ import annotations

import glob
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

SERVER_LOG = "/tmp/server.log"
SERVER_PID_FILE = "/tmp/server.pid"
LOAD_OUT = "/tmp/load-out.txt"
PROJECT_ROOT = Path(__file__).resolve().parents[1]
RESULTS_DIR = PROJECT_ROOT / "load-tests" / "results"
SMOKE_RESULTS_DIR = PROJECT_ROOT / "load-tests" / "smoke-results"
NODE = "/opt/homebrew/Cellar/node/26.3.0/bin/node"
PORT = 3000
HOST = "127.0.0.1"


def log(msg: str) -> None:
    print(f"[smoke] {msg}", flush=True)


def kill_existing() -> None:
    for p in ("/tmp/server.pid", "/tmp/load-out.txt"):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
    # kill any node dist/server.js or run.js leftovers
    try:
        out = subprocess.run(
            ["pgrep", "-f", "dist/server.js"],
            capture_output=True,
            text=True,
        )
        for line in out.stdout.splitlines():
            pid = line.strip()
            if pid.isdigit():
                try:
                    os.kill(int(pid), signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass
    except FileNotFoundError:
        pass
    time.sleep(0.5)


def clear_logs() -> None:
    for p in (SERVER_LOG, LOAD_OUT):
        try:
            with open(p, "w") as f:
                f.write("")
        except OSError as e:
            log(f"could not clear {p}: {e}")


def launch_server_via_shell() -> int:
    """Launch `node dist/server.js` via bash nohup and write the real PID to a file.

    We use `bash -c 'node ... > log 2>&1 & echo $! > pidfile'` so that $! is
    evaluated by bash itself, not by the outer shell that runs this python.
    """
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".sh", delete=False
    ) as tmp:
        script = tmp.name
        tmp.write(
            f"#!/bin/bash\n"
            f"cd {PROJECT_ROOT}\n"
            f"nohup {NODE} dist/server.js > {SERVER_LOG} 2>&1 & echo $! > {SERVER_PID_FILE}\n"
        )
    os.chmod(script, 0o755)
    try:
        subprocess.run(["bash", script], check=True)
    finally:
        try:
            os.unlink(script)
        except FileNotFoundError:
            pass

    # read the pid file (written by bash)
    for _ in range(20):
        try:
            txt = Path(SERVER_PID_FILE).read_text().strip()
            if txt.isdigit():
                return int(txt)
        except FileNotFoundError:
            pass
        time.sleep(0.1)
    raise RuntimeError("server pid file never populated")


def socket_up(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def curl_root(timeout: float = 3.0) -> int:
    try:
        r = subprocess.run(
            ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", f"http://{HOST}:{PORT}/"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return int(r.stdout.strip()) if r.returncode == 0 else -1
    except (subprocess.TimeoutExpired, ValueError):
        return -1


def kill_server(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    for _ in range(10):
        try:
            os.kill(pid, 0)
            time.sleep(0.2)
        except ProcessLookupError:
            return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run_load_test(vus: int = 2, duration: str = "5s", scenario: str = "http-sessions") -> bool:
    cmd = [
        NODE,
        str(PROJECT_ROOT / "load-tests" / "run.js"),
        "--vus", str(vus),
        "--duration", duration,
        "--scenario", scenario,
    ]
    log(f"run load: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(PROJECT_ROOT),
        stdout=open(LOAD_OUT, "w"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    # Wait for runner to exit OR server to vanish, whichever first.
    deadline = time.time() + 30
    runner_done = False
    while time.time() < deadline:
        if proc.poll() is not None:
            runner_done = True
            break
        if not socket_up(HOST, PORT):
            log("server vanished during load run; will restart")
            break
        time.sleep(0.5)
    if not runner_done:
        try:
            proc.terminate()
        except OSError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                pass
            proc.wait(timeout=3)
    return runner_done


def latest_result() -> dict | None:
    files = list(RESULTS_DIR.glob("http-sessions-*.json"))
    if not files:
        return None
    # Pick the file the runner most recently wrote (by mtime), not the
    # alphabetically last name. When the smoke retries, a later-timestamp
    # filename can be an older/empty artifact; mtime is more reliable here.
    try:
        files.sort(key=lambda p: p.stat().st_mtime_ns, reverse=True)
    except OSError:
        files.sort(key=lambda p: p.name, reverse=True)
    path = files[0]
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        log(f"could not parse {path}: {e}")
        return None


def main() -> int:
    log("starting Phase 8.1 smoke")
    kill_existing()
    clear_logs()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    SMOKE_RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    # Remove any result files from prior attempts so latest_result() cannot
    # return a stale all-zero snapshot from a previous (failed) run.
    for f in RESULTS_DIR.glob("http-sessions-*.json"):
        try:
            f.unlink()
        except OSError as e:
            log(f"could not remove prior result {f}: {e}")

    # Launch server via shell (the unreliable-but-requested path)
    pid = launch_server_via_shell()
    log(f"launched server pid={pid}")

    # Wait for socket + curl 200
    for _ in range(40):
        if socket_up(HOST, PORT) and curl_root() == 200:
            log("server UP and curl 200")
            break
        time.sleep(0.25)
    else:
        log("server never became reachable via shell launch")
        kill_server(pid)
        return 2

    # If server vanishes before load, restart once and re-probe
    if not socket_up(HOST, PORT):
        log("server vanished before load; restarting once")
        kill_server(pid)
        pid = launch_server_via_shell()
        for _ in range(40):
            if socket_up(HOST, PORT) and curl_root() == 200:
                log("re-launched server UP")
                break
            time.sleep(0.25)
        else:
            log("re-launch also failed")
            kill_server(pid)
            return 3

    # Run the load test
    runner_ok = run_load_test(vus=2, duration="5s", scenario="http-sessions")

    # If the runner exited but server vanished during it, restart once and retry
    if not runner_ok or not socket_up(HOST, PORT):
        log("runner did not complete cleanly or server vanished; restart and retry once")
        kill_server(pid)
        pid = launch_server_via_shell()
        for _ in range(40):
            if socket_up(HOST, PORT) and curl_root() == 200:
                break
            time.sleep(0.25)
        else:
            log("retry launch failed")
            kill_server(pid)
            return 4
        runner_ok = run_load_test(vus=2, duration="5s", scenario="http-sessions")

    kill_server(pid)
    log("server stopped")

    # Keep a per-smoke copy in smoke-results/ so the canonical artifact history
    # is easy to inspect without polluting the main results/ dir.
    try:
        for src in RESULTS_DIR.glob("http-sessions-*.json"):
            dst = SMOKE_RESULTS_DIR / src.name
            dst.write_text(src.read_text())
    except OSError as e:
        log(f"could not copy to smoke-results/: {e}")

    res = latest_result()
    if res is None:
        log("no result file produced")
        return 5

    http = res.get("http") or {}
    req = http.get("requests", 0)
    fail = http.get("failures", 0)
    status = http.get("statusCounts") or {}
    summary = res.get("summary") or {}
    rps = summary.get("requestsPerSec", 0)

    log("=== result ===")
    winner = max(RESULTS_DIR.glob("http-sessions-*.json"), key=lambda p: p.stat().st_mtime_ns, default=None)
    log(f"file: {winner.name if winner else '?'}")
    log(f"http_requests: {req}")
    log(f"http_failures: {fail}")
    log(f"statusCounts: {json.dumps(status)}")
    log(f"requestsPerSec: {rps}")

    if req > 0 and fail == 0:
        log("SMOKE OK: nonzero requests, zero failures")
        return 0
    if req > 0:
        log("SMOKE PARTIAL: requests captured but failures present")
        return 7
    log("SMOKE FAIL: no requests captured")
    return 6


if __name__ == "__main__":
    sys.exit(main())
