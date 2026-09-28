"""Shared fixtures: synthetic product images, config, and a local HTTP storage stub."""

from __future__ import annotations

import threading
from collections.abc import Iterator
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.config import ServiceConfig

from .helpers import SECRET


# --------------------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------------------
@pytest.fixture
def cfg(tmp_path: Path) -> ServiceConfig:
    return ServiceConfig(
        model_backend="classic",
        gpu_service_secret=SECRET,
        allow_http_urls=True,
        east_model_path=tmp_path / "missing_east.pb",  # force the MSER fallback
        http_retries=2,
    )


@pytest.fixture(autouse=True)
def _no_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NO_PROXY", "127.0.0.1,localhost")
    monkeypatch.setenv("no_proxy", "127.0.0.1,localhost")


# --------------------------------------------------------------------------------------
# Local storage stub (GET serves registered objects, PUT records uploads)
# --------------------------------------------------------------------------------------
@dataclass
class StubStorage:
    base_url: str
    objects: dict[str, tuple[int, bytes]] = field(default_factory=dict)
    put_status: dict[str, list[int]] = field(default_factory=dict)  # path → statuses to return in order
    uploads: dict[str, tuple[dict[str, str], bytes]] = field(default_factory=dict)
    put_attempts: dict[str, int] = field(default_factory=dict)

    def url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    def serve(self, path: str, body: bytes, status: int = 200) -> str:
        self.objects[path] = (status, body)
        return self.url(path)

    def upload_targets(self, prefix: str = "/out") -> dict[str, dict[str, object]]:
        return {
            "output": {
                "url": self.url(f"{prefix}/output?X-Amz-Signature=abc"),
                "headers": {"Content-Type": "image/jpeg"},
            },
            "preview": {"url": self.url(f"{prefix}/preview"), "headers": {"Content-Type": "image/jpeg"}},
            "before": {"url": self.url(f"{prefix}/before"), "headers": {"Content-Type": "image/jpeg"}},
            "mask": {
                "url": self.url(f"{prefix}/mask"),
                "headers": {"Content-Type": "image/png", "x-amz-meta-kind": "mask"},
            },
        }


@pytest.fixture
def storage() -> Iterator[StubStorage]:
    stub: StubStorage

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:  # silence
            pass

        def do_GET(self) -> None:  # noqa: N802
            status, body = stub.objects.get(self.path.split("?")[0], (404, b"not found"))
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_PUT(self) -> None:  # noqa: N802
            path = self.path.split("?")[0]
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            stub.put_attempts[path] = stub.put_attempts.get(path, 0) + 1
            statuses = stub.put_status.get(path)
            status = statuses.pop(0) if statuses else 200
            if status < 300:
                stub.uploads[path] = ({k.lower(): v for k, v in self.headers.items()}, body)
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    stub = StubStorage(base_url=f"http://127.0.0.1:{server.server_address[1]}")
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield stub
    finally:
        server.shutdown()
        server.server_close()
