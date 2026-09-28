"""HMAC signature verification and outbound URL policy."""

from __future__ import annotations

import time

import pytest

from app.errors import ServiceError
from app.security import SignatureError, compute_signature, sign, validate_url, verify_signature

from .helpers import SECRET

BODY = b'{"request_id":"abc"}'


def test_valid_signature() -> None:
    verify_signature(sign(SECRET, BODY), BODY, SECRET)


def test_signature_matches_contract_formula() -> None:
    import hashlib
    import hmac

    ts = 1_700_000_000
    expected = hmac.new(SECRET.encode(), f"{ts}.".encode() + BODY, hashlib.sha256).hexdigest()
    assert compute_signature(SECRET, ts, BODY) == expected
    assert sign(SECRET, BODY, ts) == f"t={ts},v1={expected}"


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        "garbage",
        "t=abc,v1=" + "0" * 64,
        "t=123",
        "v1=" + "0" * 64,
        "t=123,v1=nothex",
    ],
)
def test_missing_or_malformed_header(header: str | None) -> None:
    with pytest.raises(SignatureError) as err:
        verify_signature(header, BODY, SECRET)
    assert err.value.status == 401


def test_bad_signature() -> None:
    header = sign("wrong-secret", BODY)
    with pytest.raises(SignatureError, match="does not match"):
        verify_signature(header, BODY, SECRET)


def test_tampered_body() -> None:
    header = sign(SECRET, BODY)
    with pytest.raises(SignatureError):
        verify_signature(header, BODY + b" ", SECRET)


def test_stale_timestamp() -> None:
    old = int(time.time()) - 301
    with pytest.raises(SignatureError, match="window"):
        verify_signature(sign(SECRET, BODY, old), BODY, SECRET)


def test_future_timestamp_outside_window() -> None:
    future = int(time.time()) + 400
    with pytest.raises(SignatureError):
        verify_signature(sign(SECRET, BODY, future), BODY, SECRET)


def test_timestamp_inside_window() -> None:
    verify_signature(sign(SECRET, BODY, int(time.time()) - 250), BODY, SECRET)


def test_multiple_v1_values_accepted() -> None:
    ts = int(time.time())
    header = f"t={ts},v1={'a' * 64},v1={compute_signature(SECRET, ts, BODY)}"
    verify_signature(header, BODY, SECRET)


def test_url_policy() -> None:
    validate_url("https://bucket.s3.amazonaws.com/x?sig=1", field="f", allow_http=False, host_suffixes=[])
    with pytest.raises(ServiceError) as err:
        validate_url("http://minio:9000/x", field="source_url", allow_http=False, host_suffixes=[])
    assert err.value.code == "invalid_settings" and err.value.status == 400
    validate_url("http://minio:9000/x", field="f", allow_http=True, host_suffixes=[])
    with pytest.raises(ServiceError):
        validate_url("file:///etc/passwd", field="f", allow_http=True, host_suffixes=[])
    with pytest.raises(ServiceError):
        validate_url("https://user:pw@example.com/x", field="f", allow_http=False, host_suffixes=[])


def test_host_allowlist() -> None:
    suffixes = ["r2.cloudflarestorage.com", "amazonaws.com"]
    validate_url("https://acct.r2.cloudflarestorage.com/o", field="f", allow_http=False, host_suffixes=suffixes)
    validate_url("https://amazonaws.com/o", field="f", allow_http=False, host_suffixes=suffixes)
    for bad in ("https://evil.com/o", "https://notamazonaws.com/o", "https://amazonaws.com.evil.com/o"):
        with pytest.raises(ServiceError):
            validate_url(bad, field="f", allow_http=False, host_suffixes=suffixes)
