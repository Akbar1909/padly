"""Request authentication (HMAC ``X-Signature``) and outbound URL policy."""

from __future__ import annotations

import hashlib
import hmac
import re
import time
from urllib.parse import urlsplit

from .errors import ServiceError, invalid_settings, unauthorized

SIGNATURE_HEADER = "X-Signature"
_HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")


class SignatureError(ServiceError):
    """Raised for any signature problem; always a 401."""

    def __init__(self, message: str) -> None:
        err = unauthorized(message)
        super().__init__(err.code, err.message, err.status)


def compute_signature(secret: str, timestamp: int, body: bytes) -> str:
    """Hex HMAC-SHA256 of ``"<t>.<raw body>"`` keyed with ``secret``."""
    return hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()


def sign(secret: str, body: bytes, timestamp: int | None = None) -> str:
    """Build a full ``X-Signature`` header value (used by tests and local tooling)."""
    ts = int(time.time()) if timestamp is None else timestamp
    return f"t={ts},v1={compute_signature(secret, ts, body)}"


def parse_signature_header(header: str) -> tuple[int, list[str]]:
    """Parse ``t=<unix>,v1=<hex>[,v1=<hex>...]``; raises :class:`SignatureError` if malformed."""
    timestamp: int | None = None
    signatures: list[str] = []
    for part in header.split(","):
        key, sep, value = part.strip().partition("=")
        if not sep:
            raise SignatureError("Malformed X-Signature header")
        key, value = key.strip(), value.strip()
        if key == "t":
            if not value.isdigit() or timestamp is not None:
                raise SignatureError("Malformed X-Signature timestamp")
            timestamp = int(value)
        elif key == "v1":
            if not _HEX64.match(value):
                raise SignatureError("Malformed X-Signature v1 value")
            signatures.append(value.lower())
    if timestamp is None or not signatures:
        raise SignatureError("X-Signature must contain t= and v1=")
    return timestamp, signatures


def verify_signature(
    header: str | None,
    body: bytes,
    secret: str,
    *,
    tolerance_s: int = 300,
    now: float | None = None,
) -> None:
    """Verify the contract's HMAC header against the raw request body bytes.

    Raises :class:`SignatureError` (401) when the header is missing, malformed, stale
    (|now - t| > tolerance) or doesn't match (constant-time comparison).
    """
    if not header:
        raise SignatureError("Missing X-Signature header")
    timestamp, signatures = parse_signature_header(header)
    current = time.time() if now is None else now
    if abs(current - timestamp) > tolerance_s:
        raise SignatureError("X-Signature timestamp outside the allowed window")
    expected = compute_signature(secret, timestamp, body)
    # Evaluate every candidate so timing doesn't reveal which one matched.
    matched = False
    for candidate in signatures:
        matched |= hmac.compare_digest(expected, candidate)
    if not matched:
        raise SignatureError("X-Signature does not match")


def validate_url(url: str, *, field: str, allow_http: bool, host_suffixes: list[str]) -> None:
    """Enforce the outbound URL policy (https only, optional host allowlist).

    Raises ``invalid_settings`` (400): a bad URL is a bad request that must not be retried.
    """
    try:
        parts = urlsplit(url)
    except ValueError as exc:
        raise invalid_settings(f"{field}: not a valid URL") from exc
    allowed_schemes = {"https", "http"} if allow_http else {"https"}
    if parts.scheme.lower() not in allowed_schemes:
        raise invalid_settings(f"{field}: scheme must be {' or '.join(sorted(allowed_schemes))}")
    host = (parts.hostname or "").lower()
    if not host:
        raise invalid_settings(f"{field}: URL has no host")
    if parts.username or parts.password:
        raise invalid_settings(f"{field}: credentials in URL are not allowed")
    if host_suffixes and not any(host == s or host.endswith("." + s) for s in host_suffixes):
        raise invalid_settings(f"{field}: host {host!r} is not in ALLOWED_URL_HOSTS")
