from __future__ import annotations

import json
import sys
import threading
import time
from collections import OrderedDict
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen


HOST = "127.0.0.1"
PORT = 8000
PORT_ATTEMPTS = 20
OPENF1_BASE = "https://api.openf1.org/v1"
ANALYSIS_CACHE_LIMIT = 6
ANALYSIS_CACHE: OrderedDict[tuple[int, int], dict] = OrderedDict()
ANALYSIS_CACHE_LOCK = threading.Lock()
ANALYSIS_BUILD_LOCK = threading.Lock()
# http://127.0.0.1:8000


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if not self.path.startswith("/api/openf1/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/api/tyre-analysis"):
            self.build_tyre_analysis()
            return
        if self.path.startswith("/api/openf1/"):
            self.proxy_openf1()
            return
        super().do_GET()

    def proxy_openf1(self):
        parsed = urlsplit(self.path)
        endpoint = parsed.path.removeprefix("/api/openf1/").strip("/")
        if not endpoint or "/" in endpoint:
            self.send_json({"error": "Invalid OpenF1 endpoint"}, status=400)
            return

        url = f"{OPENF1_BASE}/{endpoint}"
        if parsed.query:
            url = f"{url}?{parsed.query}"

        try:
            payload = self.fetch(url)
        except HTTPError as exc:
            self.send_json(
                {"error": f"OpenF1 returned HTTP {exc.code}", "url": url},
                status=exc.code,
            )
            return
        except OSError as exc:
            self.send_json({"error": str(exc), "url": url}, status=502)
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=30")
        self.end_headers()
        self.wfile.write(payload)

    def build_tyre_analysis(self):
        query = parse_qs(urlsplit(self.path).query)
        try:
            session_key = int(query.get("session_key", [""])[0])
            driver_number = int(query.get("driver_number", [""])[0])
        except ValueError:
            self.send_json(
                {"error": "session_key and driver_number must be integers"},
                status=400,
            )
            return

        cache_key = (session_key, driver_number)
        with ANALYSIS_CACHE_LOCK:
            cached = ANALYSIS_CACHE.get(cache_key)
            if cached is not None:
                ANALYSIS_CACHE.move_to_end(cache_key)
        if cached is not None:
            self.send_json(cached, status=200)
            return

        try:
            with ANALYSIS_BUILD_LOCK:
                with ANALYSIS_CACHE_LOCK:
                    cached = ANALYSIS_CACHE.get(cache_key)
                if cached is None:
                    from plot_tyre_performance import fetch_analysis

                    cached = fetch_analysis(
                        session_key=session_key,
                        driver_number=driver_number,
                    )
                    with ANALYSIS_CACHE_LOCK:
                        ANALYSIS_CACHE[cache_key] = cached
                        ANALYSIS_CACHE.move_to_end(cache_key)
                        while len(ANALYSIS_CACHE) > ANALYSIS_CACHE_LIMIT:
                            ANALYSIS_CACHE.popitem(last=False)
        except HTTPError as exc:
            self.send_json(
                {"error": f"OpenF1 returned HTTP {exc.code}"}, status=502
            )
            return
        except (OSError, RuntimeError, ValueError) as exc:
            self.send_json({"error": str(exc)}, status=502)
            return

        self.send_json(cached, status=200)

    def fetch(self, url: str) -> bytes:
        request = Request(url, headers={"User-Agent": "f1-dashboard-local/1.0"})
        for attempt in range(5):
            try:
                if attempt:
                    time.sleep(1.25 * attempt)
                with urlopen(request, timeout=30) as response:
                    return response.read()
            except HTTPError as exc:
                if exc.code not in {429, 500, 502, 503, 504} or attempt == 4:
                    raise
        raise OSError(f"Failed to fetch {url}")

    def send_json(self, payload: dict, status: int) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_server_only() -> None:
    server = None
    for port in range(PORT, PORT + PORT_ATTEMPTS):
        try:
            server = ThreadingHTTPServer((HOST, port), Handler)
            break
        except OSError:
            continue

    if server is None:
        raise SystemExit(f"No free port found from {PORT} to {PORT + PORT_ATTEMPTS - 1}.")

    print(f"Serving http://{HOST}:{server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    if "--server-only" in sys.argv:
        run_server_only()
    else:
        # Reuse this running module when launch_dashboard imports ``server``.
        sys.modules.setdefault("server", sys.modules[__name__])
        from launch_dashboard import main as launch_gui

        launch_gui()
