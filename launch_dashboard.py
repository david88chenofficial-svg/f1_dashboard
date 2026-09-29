from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

from server import HOST, PORT, PORT_ATTEMPTS, Handler


APP_DIR = Path(__file__).resolve().parent


def browser_candidates() -> list[str]:
    names = [
        "chrome",
        "chrome.exe",
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "msedge",
        "msedge.exe",
    ]
    paths = [shutil.which(name) for name in names]

    if sys.platform.startswith("win"):
        local_app_data = os.environ.get("LOCALAPPDATA")
        program_files = os.environ.get("PROGRAMFILES")
        program_files_x86 = os.environ.get("PROGRAMFILES(X86)")
        roots = [local_app_data, program_files, program_files_x86]
        paths.extend(
            str(Path(root) / "Google" / "Chrome" / "Application" / "chrome.exe")
            for root in roots
            if root
        )
        paths.extend(
            str(Path(root) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
            for root in (program_files, program_files_x86)
            if root
        )
    elif sys.platform == "darwin":
        paths.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

    return [path for path in paths if path and Path(path).exists()]


def open_in_app_browser(url: str, profile_dir: str) -> subprocess.Popen:
    for browser_path in browser_candidates():
        try:
            args = [
                browser_path,
                f"--user-data-dir={profile_dir}",
                "--app=" + url,
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-mode",
                "--disable-default-apps",
            ]
            kwargs = {
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            }
            if sys.platform.startswith("win"):
                kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                kwargs["start_new_session"] = True

            return subprocess.Popen(args, **kwargs)
        except OSError:
            continue

    raise SystemExit("Google Chrome or Microsoft Edge was not found.")


def stop_browser(browser: subprocess.Popen | None) -> None:
    if browser is None or browser.poll() is not None:
        return

    if sys.platform.startswith("win"):
        try:
            subprocess.run(
                ["taskkill", "/PID", str(browser.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
                check=False,
            )
            browser.wait(timeout=5)
            return
        except (OSError, subprocess.TimeoutExpired):
            pass

    browser.terminate()
    try:
        browser.wait(timeout=5)
    except subprocess.TimeoutExpired:
        browser.kill()
        browser.wait(timeout=5)


def browser_has_visible_window(process_id: int) -> bool:
    if not sys.platform.startswith("win"):
        return True

    import ctypes
    from ctypes import wintypes

    visible_window_found = False
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def inspect_window(window_handle, _extra):
        nonlocal visible_window_found
        window_process_id = wintypes.DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(
            window_handle,
            ctypes.byref(window_process_id),
        )
        if window_process_id.value == process_id and ctypes.windll.user32.IsWindowVisible(window_handle):
            visible_window_found = True
            return False
        return True

    ctypes.windll.user32.EnumWindows(callback_type(inspect_window), 0)
    return visible_window_found


def wait_for_browser_close(browser: subprocess.Popen) -> None:
    window_seen = False
    window_deadline = time.monotonic() + 20
    while True:
        if browser.poll() is not None:
            return
        if sys.platform.startswith("win"):
            if browser_has_visible_window(browser.pid):
                window_seen = True
            elif window_seen:
                return
            elif time.monotonic() >= window_deadline:
                raise RuntimeError("The browser started, but its dashboard window did not appear.")
        time.sleep(0.25)


def serve_until_browser_closes(httpd: ThreadingHTTPServer, url: str) -> None:
    browser = None
    server_thread = threading.Thread(
        target=httpd.serve_forever,
        name="dashboard-server",
        daemon=True,
    )
    server_thread.start()

    try:
        with tempfile.TemporaryDirectory(prefix="f1_dashboard_chrome_") as profile_dir:
            try:
                print(f"Opening {url}")
                browser = open_in_app_browser(url, profile_dir)
                print("Dashboard is running. Close the dashboard window to stop the server.")
                wait_for_browser_close(browser)
                print("Dashboard window closed. Server stopped.")
            finally:
                # End every process belonging to the dedicated app-browser instance
                # before its temporary profile is removed.
                stop_browser(browser)
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        httpd.shutdown()
        httpd.server_close()
        server_thread.join(timeout=5)


def make_server() -> ThreadingHTTPServer:
    for port in range(PORT, PORT + PORT_ATTEMPTS):
        try:
            return ThreadingHTTPServer((HOST, port), Handler)
        except OSError:
            continue

    raise SystemExit(f"No free port found from {PORT} to {PORT + PORT_ATTEMPTS - 1}.")


def main() -> None:
    os.chdir(APP_DIR)
    httpd = make_server()
    url = f"http://{HOST}:{httpd.server_port}/"

    serve_until_browser_closes(httpd, url)


if __name__ == "__main__":
    main()
