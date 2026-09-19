"""The agent contract in stdlib Python. Run: python3 python/echo_server.py

POST /agent/messages {sessionId, text} -> {parts}, POST /agent/reset -> {ok},
GET / serves the chat page. Replace `respond` with your harness (docs/harness.md).
"""
import json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CHAT_DIR = Path(__file__).resolve().parent.parent / "chat"
SESSIONS: dict[str, list] = {}  # sessionId -> turns; in memory on purpose


def respond(session_id: str, text: str) -> list[dict]:
    history = SESSIONS.setdefault(session_id, [])
    history.append(text)
    if len(history) == 1:
        return [{"kind": "text", "text": "Hi, I am the PLEC Concierge. What city is your event in, what date, and how many guests?"}]
    return [{"kind": "text", "text": f'You said: "{text}". I am only an echo so far.'}]


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, data: dict) -> None:
        self._send(status, json.dumps(data).encode())

    def do_OPTIONS(self) -> None:
        self._send(204, b"")

    def do_GET(self) -> None:
        name = "index.html" if self.path in ("/", "/index.html") else self.path.lstrip("/").split("?")[0]
        file = (CHAT_DIR / name).resolve()
        if file.is_file() and CHAT_DIR in file.parents:  # never serve outside chat/
            ctype = "image/svg+xml" if file.suffix == ".svg" else "text/html; charset=utf-8"
            return self._send(200, file.read_bytes(), ctype)
        self._json(404, {"error": "not_found", "message": f"No route GET {self.path}"})

    def do_POST(self) -> None:
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": "bad_json", "message": "Send a JSON body"})
        session_id = str(body.get("sessionId", "")).strip()
        if not session_id:
            return self._json(400, {"error": "session_required", "message": "sessionId is required"})
        if self.path == "/agent/reset":
            SESSIONS.pop(session_id, None)
            return self._json(200, {"ok": True})
        if self.path == "/agent/messages":
            text = str(body.get("text", "")).strip()
            if not text:
                return self._json(400, {"error": "text_required", "message": "text is required"})
            return self._json(200, {"parts": respond(session_id, text)})
        self._json(404, {"error": "not_found", "message": f"No route POST {self.path}"})


if __name__ == "__main__":
    port = int(os.environ.get("AGENT_PORT", "8787"))
    print(f"PLEC agent (python) listening on http://localhost:{port}")
    ThreadingHTTPServer(("", port), Handler).serve_forever()
