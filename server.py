from __future__ import annotations

import json
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


HOST = "127.0.0.1"
PORT = 8000
PORT_ATTEMPTS = 20
OPENF1_BASE = "https://api.openf1.org/v1"


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        if not self.path.startswith("/api/openf1/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
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


if __name__ == "__main__":
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
