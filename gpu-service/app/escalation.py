"""When a paid (escalation) model call is allowed.

Paid calls are skipped for ``cooldown_s`` after the provider failed (out of credit, outage,
timeout), so a dead provider doesn't add its timeout to every image, and after the optional
daily cap. Skipping never fails an image: it keeps its local result and quality flags.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime


class EscalationGate:
    def __init__(
        self,
        *,
        cooldown_s: float,
        daily_max_calls: int = 0,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.cooldown_s = cooldown_s
        self.daily_max_calls = daily_max_calls
        self._clock = clock
        self._lock = threading.Lock()
        self._blocked_until = 0.0
        self._day = ""
        self._calls_today = 0

    def _roll_day(self) -> None:
        day = datetime.fromtimestamp(self._clock(), UTC).strftime("%Y-%m-%d")
        if day != self._day:
            self._day, self._calls_today = day, 0

    def blocked(self) -> str | None:
        """None when a paid call may be made now, else why not."""
        with self._lock:
            if self._clock() < self._blocked_until:
                return "escalation_cooldown"
            self._roll_day()
            if self.daily_max_calls and self._calls_today >= self.daily_max_calls:
                return "escalation_daily_cap"
            return None

    def spent(self, calls: int = 1) -> None:
        with self._lock:
            self._roll_day()
            self._calls_today += calls

    def failed(self) -> None:
        with self._lock:
            self._blocked_until = self._clock() + self.cooldown_s
