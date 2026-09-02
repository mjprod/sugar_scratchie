from __future__ import annotations

import logging
import time

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("sugar.api")


class RequestTimingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next) -> Response:
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = (time.perf_counter() - start) * 1000
        response.headers["X-Response-Time-Ms"] = f"{duration_ms:.1f}"
        message = "%s %s -> %s (%.1f ms)"
        args = (request.method, request.url.path, response.status_code, duration_ms)
        if duration_ms > 500:
            logger.warning(message, *args)
        else:
            logger.debug(message, *args)
        return response
