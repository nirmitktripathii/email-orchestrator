"""Normalizer, tool-result parsing and the provider manager (port of tests/providers/*)."""

import pytest

from email_orchestrator.core.normalizer import normalize_email, normalize_emails
from email_orchestrator.providers.base import coerce_email_array, parse_tool_result
from email_orchestrator.providers.manager import ProviderManager, parse_global_id

from helpers import FakeAdapter, make_email


# ---------------------------------------------------------------- normalizer

def test_normalizes_a_gmail_style_raw_email():
    raw = {"id": "abc123", "subject": "Hello", "from": "Alice <alice@example.com>", "to": "bob@example.com",
           "snippet": "hi there", "labelIds": ["UNREAD", "INBOX"], "threadId": "t1"}
    email = normalize_email(raw, "gmail", "gmail-primary", "bob@example.com")
    assert email["id"] == "abc123"
    assert email["globalId"] == "gmail-primary:abc123"
    assert email["from"] == {"name": "Alice", "email": "alice@example.com"}
    assert email["isRead"] is False  # UNREAD label present
    assert email["threadId"] == "t1"


def test_object_contacts_and_read_without_unread_label():
    raw = {"messageId": "x1", "Subject": "Report", "from": {"name": "Carol", "email": "carol@example.com"},
           "labelIds": ["INBOX"]}
    email = normalize_email(raw, "gmail", "a", "me@example.com")
    assert email["from"]["name"] == "Carol"
    assert email["isRead"] is True
    assert email["subject"] == "Report"


def test_throws_when_id_missing():
    with pytest.raises(Exception):
        normalize_email({"subject": "no id"}, "imap", "a", "me@example.com")


def test_skips_unnormalizable_emails_in_a_batch():
    out = normalize_emails([{"id": "1", "subject": "ok"}, {"subject": "missing id"}, {"uid": "2", "subject": "ok2"}],
                           "imap", "yahoo", "me@yahoo.com")
    assert [e["id"] for e in out] == ["1", "2"]


# ---------------------------------------------------------------- parse_tool_result / coerce_email_array

def test_prefers_structured_content():
    result = {"structuredContent": {"emails": [{"id": "1"}]}, "content": [{"type": "text", "text": "ignored"}]}
    assert parse_tool_result(result) == {"emails": [{"id": "1"}]}


def test_parses_a_json_text_block():
    result = {"content": [{"type": "text", "text": '[{"id":"1"},{"id":"2"}]'}]}
    assert parse_tool_result(result) == [{"id": "1"}, {"id": "2"}]


def test_extracts_embedded_json_from_human_text():
    result = {"content": [{"type": "text", "text": 'Here are your emails: [{"id":"9"}] done.'}]}
    assert parse_tool_result(result) == [{"id": "9"}]


def test_falls_back_to_raw_text():
    assert parse_tool_result({"content": [{"type": "text", "text": "no json here"}]}) == "no json here"


def test_coerce_email_array_shapes():
    assert len(coerce_email_array([{"id": "1"}])) == 1
    assert len(coerce_email_array({"messages": [{"id": "1"}, {"id": "2"}]})) == 2
    assert len(coerce_email_array({"data": [{"id": "3"}]})) == 1
    assert len(coerce_email_array({"id": "1", "subject": "x"})) == 1
    assert coerce_email_array("nonsense") == []
    assert coerce_email_array(None) == []


# ---------------------------------------------------------------- provider manager

def test_parse_global_id():
    assert parse_global_id("gmail-primary:abc:123") == ("gmail-primary", "abc:123")
    assert parse_global_id("nocolon") is None


async def setup_manager(fail_second=False):
    a = FakeAdapter("acctA", "a@x.com",
                    [make_email(accountId="acctA", isRead=False), make_email(accountId="acctA", isRead=True)])
    b = FakeAdapter("acctB", "b@x.com", [make_email(accountId="acctB")], fail_on_list=fail_second)
    mgr = ProviderManager.with_adapters([a, b])
    await mgr.connect_all()
    return mgr, a


async def test_aggregates_across_accounts():
    mgr, _ = await setup_manager()
    assert len(await mgr.list_all_emails()) == 3


async def test_isolates_a_failing_account():
    mgr, _ = await setup_manager(fail_second=True)
    assert len(await mgr.list_all_emails()) == 2  # acctB failed, acctA still returned


async def test_unread_only_across_accounts():
    mgr, _ = await setup_manager()
    assert all(not e["isRead"] for e in await mgr.list_all_emails({"unreadOnly": True}))


async def test_routes_get_email_by_global_id():
    mgr, a = await setup_manager()
    first = (await a.list_emails())[0]
    assert (await mgr.get_email_by_global_id(first["globalId"]))["globalId"] == first["globalId"]


async def test_unknown_account_raises():
    mgr, _ = await setup_manager()
    with pytest.raises(Exception):
        await mgr.get_email_by_global_id("ghost:1")


async def test_reports_statuses():
    mgr, _ = await setup_manager()
    statuses = mgr.get_statuses()
    assert len(statuses) == 2
    assert all(s["isConnected"] for s in statuses)
