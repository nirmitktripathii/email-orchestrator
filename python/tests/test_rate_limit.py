"""Request spacing (stay under per-minute quotas) and honouring the server's retry delay."""

import asyncio

import pytest

from email_orchestrator.ai.llm_client import RequestSpacer, classify_transient


class FakeClock:
    """Sleeping just advances time, so the tests run instantly."""

    def __init__(self) -> None:
        self.t = 1000.0
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.t

    async def sleep(self, s: float) -> None:
        self.sleeps.append(s)
        self.t += s


async def test_spaces_consecutive_requests():
    c = FakeClock()
    spacer = RequestSpacer(15, c.now, c.sleep)  # 4 s apart
    for _ in range(4):
        await spacer.wait()
    assert c.sleeps == [4.0, 4.0, 4.0]  # first request goes immediately


async def test_concurrent_callers_get_distinct_slots():
    c = FakeClock()
    waits: list[float] = []

    async def record(s: float) -> None:
        waits.append(s)

    spacer = RequestSpacer(15, c.now, record)
    await asyncio.gather(spacer.wait(), spacer.wait(), spacer.wait())
    assert waits == [4.0, 8.0]


async def test_no_wait_when_already_spaced():
    c = FakeClock()
    spacer = RequestSpacer(15, c.now, c.sleep)
    await spacer.wait()
    c.t += 10
    await spacer.wait()
    assert c.sleeps == []


async def test_disabled_is_noop():
    c = FakeClock()
    spacer = RequestSpacer(0, c.now, c.sleep)
    for _ in range(5):
        await spacer.wait()
    assert c.sleeps == []


@pytest.mark.parametrize(
    "msg, ms",
    [
        ("429 RESOURCE_EXHAUSTED {'error': {'details': [{'retryDelay': '46s'}]}}", 46000),
        ('429 {"error":{"details":[{"retryDelay":"12s"}]}}', 12000),
        ("429 Quota exceeded. Please retry in 46.5s.", 46500),
    ],
)
def test_retry_delay_parsed(msg, ms):
    assert classify_transient(Exception(msg)) == (True, ms)


def test_non_transient_not_retried():
    assert classify_transient(Exception("400 invalid argument")) == (False, None)
