"""Digest scheduler timing (Python-only: the TS version used node-cron and had no unit test)."""

from datetime import datetime
from zoneinfo import ZoneInfo

from email_orchestrator.core.types import ScheduleConfig
from email_orchestrator.notifications.scheduler import DigestScheduler, normalize_time

TZ = ZoneInfo("Asia/Kolkata")


class NullNotifier:
    async def notify_digest(self, title, message):
        pass


async def _no_digest():
    raise AssertionError("not called in these tests")


def make(times, enabled=True):
    return DigestScheduler(ScheduleConfig(enabled=enabled, times=times, timezone="Asia/Kolkata"), NullNotifier(), _no_digest)


def test_normalize_time():
    assert normalize_time("9:00") == "09:00"
    assert normalize_time("18:30") == "18:30"
    assert normalize_time("25:00") is None
    assert normalize_time("nonsense") is None


def test_fires_once_per_matching_minute():
    s = make(["09:00", "18:00"])
    at_nine = datetime(2026, 9, 29, 9, 0, 5, tzinfo=TZ)
    assert s.due_times(at_nine) == ["09:00"]
    assert s.due_times(at_nine.replace(second=40)) == []  # same minute: deduped
    assert s.due_times(datetime(2026, 9, 29, 9, 1, tzinfo=TZ)) == []


def test_fires_again_the_next_day():
    s = make(["09:00"])
    assert s.due_times(datetime(2026, 9, 29, 9, 0, tzinfo=TZ)) == ["09:00"]
    assert s.due_times(datetime(2026, 9, 30, 9, 0, tzinfo=TZ)) == ["09:00"]


def test_disabled_never_fires():
    assert make(["09:00"], enabled=False).due_times(datetime(2026, 9, 29, 9, 0, tzinfo=TZ)) == []


def test_set_schedule_replaces_times():
    s = make(["09:00"])
    s.set_schedule(["07:15"], True)
    assert s.due_times(datetime(2026, 9, 29, 9, 0, tzinfo=TZ)) == []
    assert s.due_times(datetime(2026, 9, 29, 7, 15, tzinfo=TZ)) == ["07:15"]
