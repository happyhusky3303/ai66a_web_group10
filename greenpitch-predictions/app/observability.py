"""Structured application logs and request correlation helpers."""

import contextvars
import json
import logging
import os
import re
import sys
from datetime import datetime, timezone


request_id_context: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
            "request_id": request_id_context.get(),
        }
        fields = getattr(record, "event_fields", None)
        if isinstance(fields, dict):
            payload.update(fields)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":"))


def configure_logging() -> None:
    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLogFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
    # Let Uvicorn access/error records use the same structured output.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers.clear()
        logger.propagate = True


def request_id_from(value: str | None) -> str:
    if value and _SAFE_REQUEST_ID.fullmatch(value):
        return value
    from uuid import uuid4

    return uuid4().hex


def log_event(logger: logging.Logger, level: int, event: str, **fields: object) -> None:
    logger.log(level, event, extra={"event_fields": {"event": event, **fields}})
