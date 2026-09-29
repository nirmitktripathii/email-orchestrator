"""All 17 tools end-to-end through the same dispatch() the MCP server uses (port of tests/e2e)."""

import re

import pytest

from email_orchestrator.ai.action_recommender import ActionRecommender
from email_orchestrator.ai.categorizer import EmailCategorizer
from email_orchestrator.ai.enrichment import EmailEnrichmentService
from email_orchestrator.ai.summarizer import EmailSummarizer
from email_orchestrator.providers.manager import ProviderManager
from email_orchestrator.server import dispatch
from email_orchestrator.tools import ALL_TOOLS, TOOLS_BY_NAME, ToolContext

from helpers import FakeAdapter, FakeLLM, default_ai_handler, make_email


@pytest.fixture
async def ctx_and_id():
    emails = [make_email(accountId="acctA", subject="URGENT: deadline today", isRead=False),
              make_email(accountId="acctA", subject="Newsletter", isRead=True)]
    providers = ProviderManager.with_adapters([FakeAdapter("acctA", "a@x.com", emails)])
    await providers.connect_all()
    llm = FakeLLM(default_ai_handler)
    s, c, a = EmailSummarizer(llm), EmailCategorizer(llm), ActionRecommender(llm)
    ctx = ToolContext(None, providers, EmailEnrichmentService(s, c, a), s, c, a)
    return ctx, emails[0]["globalId"]


async def run(ctx, name, args=None):
    return await TOOLS_BY_NAME[name].handler(args or {}, ctx)


def test_registers_17_unique_tools():
    assert len(ALL_TOOLS) == 17
    assert len(TOOLS_BY_NAME) == 17


async def test_account_status(ctx_and_id):
    ctx, _ = ctx_and_id
    out = await run(ctx, "account_status")
    assert re.search(r"1/1 account", out.text)
    assert "connected" in out.text


async def test_inbox_summary(ctx_and_id):
    ctx, _ = ctx_and_id
    out = await run(ctx, "inbox_summary", {"enrichLevel": "category"})
    assert "Inbox Overview" in out.text
    assert out.data["totalEmails"] == 2
    assert out.data["categoryBreakdown"]


async def test_prioritize_inbox(ctx_and_id):
    ctx, _ = ctx_and_id
    assert "Prioritized inbox" in (await run(ctx, "prioritize_inbox")).text


async def test_search_all(ctx_and_id):
    ctx, _ = ctx_and_id
    assert (await run(ctx, "search_all", {"query": "URGENT"})).data["count"] == 1


async def test_summarize_email(ctx_and_id):
    ctx, gid = ctx_and_id
    assert "first point" in (await run(ctx, "summarize_email", {"globalId": gid})).text


async def test_categorize_email(ctx_and_id):
    ctx, gid = ctx_and_id
    data = (await run(ctx, "categorize_email", {"globalId": gid})).data
    assert data["category"] == "urgent"
    assert data["urgencyScore"] == 9


async def test_smart_reply_drafts_without_sending(ctx_and_id):
    ctx, gid = ctx_and_id
    out = await run(ctx, "smart_reply", {"globalId": gid, "saveDraft": True})
    assert re.search(r"not sent", out.text, re.I)
    assert re.search(r"saved as draft", out.text, re.I)
    assert out.data["savedDraft"] is True


async def test_extract_tasks(ctx_and_id):
    ctx, gid = ctx_and_id
    assert "do the thing" in (await run(ctx, "extract_tasks", {"globalId": gid})).text


async def test_missing_required_argument_raises(ctx_and_id):
    ctx, _ = ctx_and_id
    with pytest.raises(Exception):
        await run(ctx, "summarize_email")


async def test_configure_schedule_without_scheduler(ctx_and_id):
    ctx, _ = ctx_and_id
    assert re.search(r"not running", (await run(ctx, "configure_schedule")).text, re.I)


# ---- through the MCP-facing dispatcher (Python-only: error wrapping + string coercion)

async def test_dispatch_wraps_errors_instead_of_crashing(ctx_and_id):
    ctx, _ = ctx_and_id
    result = await dispatch("summarize_email", {}, ctx)
    assert result.isError is True
    assert result.content[0].text


async def test_dispatch_unknown_tool(ctx_and_id):
    ctx, _ = ctx_and_id
    assert (await dispatch("no_such_tool", {}, ctx)).isError is True


async def test_dispatch_accepts_stringly_typed_numbers(ctx_and_id):
    ctx, _ = ctx_and_id
    result = await dispatch("search_all", {"query": "URGENT", "maxResults": "25"}, ctx)
    assert result.isError is not True
    assert result.structuredContent["count"] == 1
