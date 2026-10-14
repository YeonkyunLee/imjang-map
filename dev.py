"""로컬 개발 서버.

앱 파일을 그대로 서빙하고, /local/ 아래에 임장 노트 폴더를 노출한다.
앱은 localhost에서 열리면 GitHub API 대신 이 경로로 노트를 읽는다.

    python dev.py                       # http://localhost:8000
    python dev.py --notes D:/임장 --port 8080
"""
import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

APP = Path(__file__).resolve().parent
DEFAULT_NOTES = Path.home() / "Documents" / "Ian_obsidian" / "임장"


def make_handler(notes: Path):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(APP), **kwargs)

        def do_GET(self):
            path = unquote(urlsplit(self.path).path)
            if path == "/local/index.json":
                items = [
                    {"path": p.relative_to(notes).as_posix(), "sha": f"{p.stat().st_mtime_ns}-{p.stat().st_size}"}
                    for p in sorted(notes.rglob("*.md"))
                    if ".git" not in p.parts
                ]
                return self._send(json.dumps(items, ensure_ascii=False).encode(), "application/json; charset=utf-8")
            if path.startswith("/local/"):
                f = (notes / path[len("/local/"):]).resolve()
                if notes in f.parents and f.suffix == ".md" and f.is_file():
                    return self._send(f.read_bytes(), "text/markdown; charset=utf-8")
                return self.send_error(404)
            return super().do_GET()

        def _send(self, body: bytes, ctype: str):
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--notes", type=Path, default=DEFAULT_NOTES, help="임장 노트 폴더")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1", help="같은 와이파이의 폰에서 보려면 0.0.0.0")
    args = ap.parse_args()
    notes = args.notes.resolve()
    if not notes.is_dir():
        raise SystemExit(f"노트 폴더가 없습니다: {notes}")
    print(f"notes: {notes}\nhttp://localhost:{args.port}")
    ThreadingHTTPServer((args.host, args.port), make_handler(notes)).serve_forever()


if __name__ == "__main__":
    main()
