"""Presigned-URL storage I/O: streaming download with a size cap, PUT uploads with retries."""

from __future__ import annotations

import asyncio
import logging

import httpx

from .errors import ServiceError, download_failed, image_too_large, upload_failed
from .schemas import UploadTarget

log = logging.getLogger(__name__)

RETRY_STATUSES = {429, 500, 502, 503, 504}


def _redact(url: str) -> str:
    """Drop the query string (presigned credentials) before logging a URL."""
    return url.split("?", 1)[0]


class Storage:
    """Thin wrapper over a shared ``httpx.AsyncClient``. Redirects are not followed (SSRF)."""

    def __init__(self, client: httpx.AsyncClient, *, retries: int = 3, backoff_s: float = 0.5) -> None:
        self._client = client
        self.retries = retries
        self.backoff_s = backoff_s

    async def download(self, url: str, *, max_bytes: int) -> bytes:
        """GET ``url`` streaming, aborting with ``image_too_large`` past ``max_bytes``."""
        last_error: ServiceError | None = None
        for attempt in range(self.retries):
            try:
                return await self._download_once(url, max_bytes)
            except ServiceError as exc:
                if exc.status < 500:
                    raise
                last_error = exc
                log.warning("download_retry", extra={"attempt": attempt + 1, "error": exc.message, "url": _redact(url)})
            if attempt + 1 < self.retries:
                await asyncio.sleep(self.backoff_s * (2**attempt))
        assert last_error is not None
        raise last_error

    async def _download_once(self, url: str, max_bytes: int) -> bytes:
        try:
            async with self._client.stream("GET", url) as resp:
                if resp.status_code != 200:
                    raise download_failed(
                        f"Storage returned HTTP {resp.status_code} for the source image",
                        storage_status=resp.status_code,
                    )
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise image_too_large(f"Source is {declared} bytes, limit is {max_bytes}")
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.aiter_bytes():
                    total += len(chunk)
                    if total > max_bytes:
                        raise image_too_large(f"Source exceeds the {max_bytes}-byte limit")
                    chunks.append(chunk)
                if total == 0:
                    raise download_failed("Source image is empty", storage_status=resp.status_code)
                return b"".join(chunks)
        except httpx.HTTPError as exc:
            raise download_failed(f"Network error downloading source: {exc}", storage_status=None) from exc

    async def upload(self, name: str, target: UploadTarget, data: bytes) -> None:
        """PUT ``data`` with exactly the headers the URL was signed with; retry transient errors."""
        for attempt in range(self.retries):
            try:
                resp = await self._client.put(target.url, content=data, headers=target.headers)
            except httpx.HTTPError as exc:
                error = f"network error: {exc}"
            else:
                if resp.status_code < 300:
                    return
                error = f"HTTP {resp.status_code}"
                if resp.status_code not in RETRY_STATUSES:
                    raise upload_failed(f"Upload of {name} failed: {error}")
            log.warning(
                "upload_retry",
                extra={"artifact": name, "attempt": attempt + 1, "error": error, "url": _redact(target.url)},
            )
            if attempt + 1 < self.retries:
                await asyncio.sleep(self.backoff_s * (2**attempt))
        raise upload_failed(f"Upload of {name} failed after {self.retries} attempts: {error}")

    async def upload_all(self, targets: dict[str, UploadTarget], artifacts: dict[str, bytes]) -> None:
        """Upload every artifact concurrently; after all finish, the first failure is raised."""
        results = await asyncio.gather(
            *(self.upload(name, targets[name], artifacts[name]) for name in artifacts),
            return_exceptions=True,
        )
        for result in results:
            if isinstance(result, BaseException):
                raise result
