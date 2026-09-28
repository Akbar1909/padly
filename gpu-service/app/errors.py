"""Service error type mapped to the contract's error shape ``{"error": {"code", "message"}}``."""

from __future__ import annotations


class ServiceError(Exception):
    """An error with a stable machine-readable ``code`` and an HTTP status.

    4xx means the input is bad (the worker must not retry); 5xx means transient.
    """

    def __init__(self, code: str, message: str, status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status

    def to_body(self) -> dict[str, dict[str, str]]:
        return {"error": {"code": self.code, "message": self.message}}


def unsupported_image(message: str) -> ServiceError:
    return ServiceError("unsupported_image", message, 415)


def image_too_large(message: str) -> ServiceError:
    return ServiceError("image_too_large", message, 413)


def invalid_settings(message: str) -> ServiceError:
    return ServiceError("invalid_settings", message, 400)


def unauthorized(message: str) -> ServiceError:
    return ServiceError("unauthorized", message, 401)


def download_failed(message: str, *, storage_status: int | None) -> ServiceError:
    """4xx from storage → 400 (don't retry); 5xx / network errors → 502 (retry)."""
    permanent = storage_status is not None and 400 <= storage_status < 500 and storage_status != 429
    return ServiceError("source_download_failed", message, 400 if permanent else 502)


def upload_failed(message: str) -> ServiceError:
    return ServiceError("upload_failed", message, 502)


def backend_failed(message: str) -> ServiceError:
    return ServiceError("model_backend_failed", message, 502)
