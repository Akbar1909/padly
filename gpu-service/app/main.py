"""FastAPI app: ``POST /v1/process`` and ``GET /healthz`` (see docs/gpu-service-contract.md)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from .backends import Backend, build_backend
from .config import ServiceConfig, get_config
from .errors import ServiceError, invalid_settings
from .escalation import EscalationGate
from .fallback import FallbackPipeline
from .log import configure_logging, request_id_var
from .pipeline import PIPELINE_VERSION, Pipeline
from .schemas import HealthResponse, ProcessRequest, ProcessResponse, Timings
from .security import SIGNATURE_HEADER, validate_url, verify_signature
from .storage import Storage
from .text_detect import TextDetector, load_text_detector

log = logging.getLogger("app")

BackendFactory = Callable[[ServiceConfig], Backend]


@dataclass
class ServiceState:
    cfg: ServiceConfig
    backend: Backend
    text_detector: TextDetector
    storage: Storage
    pipeline: Pipeline | FallbackPipeline
    semaphore: asyncio.Semaphore


def _error(exc: ServiceError) -> JSONResponse:
    return JSONResponse(exc.to_body(), status_code=exc.status)


def _describe_validation(exc: ValidationError | RequestValidationError) -> str:
    parts = []
    for err in exc.errors()[:5]:
        loc = ".".join(str(p) for p in err.get("loc", ()) if p != "body")
        parts.append(f"{loc or 'body'}: {err.get('msg')}")
    return "; ".join(parts) or "invalid request"


def _is_oom(exc: BaseException) -> bool:
    return isinstance(exc, MemoryError) or type(exc).__name__ == "OutOfMemoryError"


async def _client_disconnected(request: Request) -> bool:
    """Resolves to True once the caller hangs up (call after the body has been read)."""
    try:
        while (await request.receive())["type"] != "http.disconnect":
            pass
    except Exception:  # a broken receive channel only means "unknown"
        return False
    return True


def create_app(cfg: ServiceConfig | None = None, *, backend_factory: BackendFactory | None = None) -> FastAPI:
    """Build the app. Models load once in the lifespan; tests inject ``cfg`` / ``backend_factory``."""
    config = cfg or get_config()
    configure_logging(config.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        factory = backend_factory or build_backend
        backend = await run_in_threadpool(factory, config)
        detector = load_text_detector(config.east_path, min_confidence=config.text_min_confidence)
        # The paid backend (Replicate) holds no models here, only an HTTP client.
        escalation = None
        if config.escalation_backend != "none":
            escalation_cfg = config.model_copy(update={"model_backend": config.escalation_backend})
            escalation = await run_in_threadpool(factory, escalation_cfg)
        gate = EscalationGate(cooldown_s=config.fallback_cooldown_s, daily_max_calls=config.escalation_daily_max_calls)
        pipeline: Pipeline | FallbackPipeline = Pipeline(config, backend, detector, escalation=escalation, gate=gate)
        if config.fallback_backend != "none":
            fallback_cfg = config.model_copy(update={"model_backend": config.fallback_backend})
            pipeline = FallbackPipeline(
                pipeline,
                lambda: Pipeline(config, factory(fallback_cfg), detector),
                cooldown_s=config.fallback_cooldown_s,
            )
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(config.http_timeout_s, connect=10.0),
            follow_redirects=False,
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=16),
        )
        app.state.svc = ServiceState(
            cfg=config,
            backend=backend,
            text_detector=detector,
            storage=Storage(client, retries=config.http_retries),
            pipeline=pipeline,
            semaphore=asyncio.Semaphore(config.max_concurrency),
        )
        log.info(
            "service_ready",
            extra={
                "backend": backend.kind,
                "fallback_backend": config.fallback_backend,
                "escalation_backend": config.escalation_backend,
                "device": backend.device,
                "text_detector": detector.name,
            },
        )
        try:
            yield
        finally:
            await client.aclose()
            backend.close()
            if escalation is not None:
                escalation.close()
            if isinstance(pipeline, FallbackPipeline):
                pipeline.close()

    app = FastAPI(title="Padly GPU service", version="1.0.0", lifespan=lifespan)

    # ---- error mapping to {"error": {"code", "message"}} ---------------------------------
    @app.exception_handler(ServiceError)
    async def _service_error(_: Request, exc: ServiceError) -> JSONResponse:
        level = logging.WARNING if exc.status < 500 else logging.ERROR
        log.log(level, "request_failed", extra={"code": exc.code, "status": exc.status, "error": exc.message})
        return _error(exc)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return _error(invalid_settings(_describe_validation(exc)))

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return _error(ServiceError(code, str(exc.detail), exc.status_code))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled_exception")
        return _error(ServiceError("internal", "Internal error", 500))

    @app.middleware("http")
    async def _access_log(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        start = time.perf_counter()
        response = await call_next(request)
        if request.url.path != "/healthz":
            # The endpoint runs in a child context; bring its request_id back for this line.
            token = request_id_var.set(getattr(request.state, "request_id", None))
            try:
                log.info(
                    "http_request",
                    extra={
                        "method": request.method,
                        "path": request.url.path,
                        "status": response.status_code,
                        "duration_ms": round((time.perf_counter() - start) * 1000),
                    },
                )
            finally:
                request_id_var.reset(token)
        return response

    # ---- routes ----------------------------------------------------------------------------
    @app.get("/healthz", response_model=HealthResponse)
    async def healthz(request: Request) -> HealthResponse:
        svc: ServiceState = request.app.state.svc
        return HealthResponse(
            ok=True,
            backend=svc.backend.kind,
            device=svc.backend.device,
            models_loaded=[*svc.backend.models_loaded, "text_detector"],
            text_detector=svc.text_detector.name,
            fallback_backend=None if svc.cfg.fallback_backend == "none" else svc.cfg.fallback_backend,
            escalation_backend=None if svc.cfg.escalation_backend == "none" else svc.cfg.escalation_backend,
            pipeline_version=f"{PIPELINE_VERSION}+{svc.cfg.output_fingerprint()}",
        )

    @app.post("/v1/process", response_model=ProcessResponse)
    async def process(request: Request) -> JSONResponse:
        svc: ServiceState = request.app.state.svc
        cfg_ = svc.cfg
        started = time.perf_counter()

        body = await request.body()
        header = request.headers.get(SIGNATURE_HEADER)
        if cfg_.gpu_service_secret and not (cfg_.allow_unsigned and header is None):
            verify_signature(header, body, cfg_.gpu_service_secret, tolerance_s=cfg_.signature_tolerance_s)

        try:
            req = ProcessRequest.model_validate_json(body)
        except ValidationError as exc:
            raise invalid_settings(_describe_validation(exc)) from exc
        request_id_var.set(req.request_id)
        request.state.request_id = req.request_id

        urls = [("source_url", req.source_url)] + [
            (f"uploads.{name}.url", getattr(req.uploads, name).url) for name in ("output", "preview", "before", "mask")
        ]
        for field_name, url in urls:
            validate_url(url, field=field_name, allow_http=cfg_.allow_http_urls, host_suffixes=cfg_.url_host_suffixes)

        log.info("process_start", extra={"settings": req.settings.model_dump()})
        t = time.perf_counter()
        data = await svc.storage.download(req.source_url, max_bytes=cfg_.max_source_bytes)
        download_ms = (time.perf_counter() - t) * 1000.0

        # A started run can't be cancelled, but a caller that gave up while this request queued
        # for the semaphore (the worker's GPU_TIMEOUT_MS, try-it's shorter wait) is skipped, so
        # its retry and the requests behind it don't wait for a result nobody reads.
        gone = asyncio.create_task(_client_disconnected(request))
        try:
            async with svc.semaphore:
                if gone.done() and gone.result():
                    waited_ms = round((time.perf_counter() - started) * 1000)
                    log.warning("client_gone", extra={"waited_ms": waited_ms})
                    return _error(ServiceError("client_gone", "The caller disconnected before processing started", 499))
                result = await run_in_threadpool(svc.pipeline.run, data, req.settings)
        except ServiceError as exc:
            log.warning("PROCESSING_FAILURE", extra={"code": exc.code, "status": exc.status, "error": exc.message})
            raise
        except Exception as exc:
            log.error("PROCESSING_FAILURE", extra={"code": "internal", "error": type(exc).__name__})
            if _is_oom(exc):
                log.error("out_of_memory", extra={"error": str(exc)})
                raise ServiceError("out_of_memory", "Ran out of memory processing the image", 503) from exc
            log.exception("pipeline_failed")
            raise ServiceError("internal", f"Processing failed: {type(exc).__name__}", 500) from exc
        finally:
            gone.cancel()
            del data

        t = time.perf_counter()
        targets = {name: getattr(req.uploads, name) for name in result.artifacts}
        await svc.storage.upload_all(targets, result.artifacts)
        upload_ms = (time.perf_counter() - t) * 1000.0

        phases = result.timings_ms
        response = ProcessResponse(
            request_id=req.request_id,
            output=result.output,
            source=result.source,
            upscale=result.upscale,
            flags=result.flags,
            metrics=result.metrics,
            fidelity=result.metrics.fidelity_ssim,
            models=result.models,
            processing=result.processing,
            timings_ms=Timings(
                download=round(download_ms + phases.get("decode", 0.0)),
                upscale=round(phases.get("upscale", 0.0)),
                segment=round(phases.get("segment", 0.0)),
                compose=round(phases.get("compose", 0.0)),
                upload=round(upload_ms),
                total=round((time.perf_counter() - started) * 1000.0),
            ),
        )
        log.info(
            "process_done",
            extra={
                "output": response.output.model_dump(),
                "upscale_method": response.upscale.method,
                "flags": [f.code for f in response.flags],
                "timings_ms": response.timings_ms.model_dump(),
            },
        )
        if result.processing is not None:
            info = result.processing
            log.info(
                "PROCESSING_SUCCESS",
                extra={
                    "operations": info.operations,
                    "method": info.method,
                    "replicate_used": info.replicate_used,
                    "replicate_calls": info.replicate_calls,
                    "replicate_models": info.replicate_models,
                    "estimated_usd": info.estimated_cost_usd,
                    "fallback_reason": info.fallback_reason,
                    "quality_score": info.quality_score,
                    "route": info.route,
                    "local_attempted": info.local_attempted,
                    "local_accepted": info.local_accepted,
                    "gate": info.gate,
                    "ai_gate": info.ai_gate,
                    "replicate_attempts": info.replicate_attempts,
                    "reason_codes": info.reason_codes,
                    "final_status": info.final_status,
                    "flags": [f.code for f in response.flags],
                    "duration_ms": response.timings_ms.total,
                },
            )
        return JSONResponse(response.model_dump())

    return app


def __getattr__(name: str) -> FastAPI:
    """``uvicorn app.main:app``: the app is built on first access, configured from the
    environment (so importing this module never requires env vars)."""
    if name == "app":
        application = create_app()
        globals()["app"] = application
        return application
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
