"""AI engines: categorizer, summarizer, enrichment (port of tests/ai/*.test.ts)."""

import re

from email_orchestrator.ai.action_recommender import ActionRecommender
from email_orchestrator.ai.categorizer import EmailCategorizer
from email_orchestrator.ai.enrichment import EmailEnrichmentService
from email_orchestrator.ai.summarizer import EmailSummarizer

from helpers import FakeLLM, default_ai_handler, make_email, raising


# ---------------------------------------------------------------- categorizer

async def test_categorizes_using_the_llm_response():
    result = await EmailCategorizer(FakeLLM(default_ai_handler)).categorize_email(make_email(subject="Deadline today"))
    assert result["category"] == "urgent"
    assert result["urgencyScore"] == 9
    assert result["priority"] == "critical"
    assert result["requiresResponse"] is True


async def test_clamps_urgency_score_into_0_10():
    llm = FakeLLM(lambda _: {"category": "informational", "urgencyScore": 42, "priority": "low", "requiresResponse": False})
    assert (await EmailCategorizer(llm).categorize_email(make_email()))["urgencyScore"] == 10


async def test_falls_back_to_keywords_when_llm_throws():
    cat = EmailCategorizer(FakeLLM(raising("llm down")))
    promo = await cat.categorize_email(make_email(subject="Huge SALE - unsubscribe anytime", body="discount offer"))
    assert promo["category"] == "promotional"
    invoice = await cat.categorize_email(make_email(subject="Invoice #123", body="payment due amount due"))
    assert invoice["category"] == "financial"


async def test_coerces_invalid_category_to_uncategorized():
    llm = FakeLLM(lambda _: {"category": "not-a-category", "urgencyScore": 3, "priority": "low", "requiresResponse": False})
    assert (await EmailCategorizer(llm).categorize_email(make_email()))["category"] == "uncategorized"


async def test_batch_categorizes_many_emails():
    emails = [make_email(), make_email(), make_email()]
    results = await EmailCategorizer(FakeLLM(default_ai_handler)).categorize_emails(emails, 2)
    assert len(results) == 3
    assert all(e["globalId"] in results for e in emails)


# ---------------------------------------------------------------- summarizer

async def test_summarizes_a_single_email():
    result = await EmailSummarizer(FakeLLM(default_ai_handler)).summarize_email(make_email())
    assert "first point" in result["summary"]
    assert "project" in result["keyTopics"]
    assert result["sentiment"] == "neutral"


async def test_empty_inbox_digest_is_friendly():
    digest = await EmailSummarizer(FakeLLM(default_ai_handler)).generate_digest([])
    assert re.search(r"no emails", digest["digest"], re.I)


async def test_generates_a_digest_for_multiple_emails():
    digest = await EmailSummarizer(FakeLLM(default_ai_handler)).generate_digest([make_email(), make_email()])
    assert digest["digest"]
    assert isinstance(digest["topPriorities"], list)


async def test_digest_falls_back_when_llm_fails():
    digest = await EmailSummarizer(FakeLLM(raising("down"))).generate_digest(
        [make_email(isRead=False), make_email(isRead=True)]
    )
    assert re.search(r"inbox overview", digest["digest"], re.I)


# ---------------------------------------------------------------- enrichment

def build_service(llm=None, **kw):
    llm = llm or FakeLLM(default_ai_handler)
    return EmailEnrichmentService(EmailSummarizer(llm), EmailCategorizer(llm), ActionRecommender(llm), **kw)


async def test_enriches_at_category_level():
    enr = await build_service(cache_ttl_seconds=60, max_cache_entries=100).enrich(make_email(), "category")
    assert enr["category"] == "urgent"
    assert enr["summary"] == ""
    assert enr["suggestedActions"] == []


async def test_enriches_at_full_level():
    enr = await build_service().enrich(make_email(), "full")
    assert "first point" in enr["summary"]
    assert enr["suggestedActions"]
    assert enr["extractedTasks"]


async def test_caches_enrichment():
    fake = FakeLLM(default_ai_handler)
    svc = build_service(fake)
    email = make_email()
    await svc.enrich(email, "category")
    after_first = fake.calls
    await svc.enrich(email, "category")
    assert fake.calls == after_first  # served from cache


async def test_enrich_many_attaches_and_remembers():
    svc = build_service()
    emails = [make_email(), make_email()]
    enriched = await svc.enrich_many(emails, "category", 2)
    assert len(enriched) == 2
    assert enriched[0]["aiEnrichment"]["category"] == "urgent"
    assert svc.get_cached_email(emails[0]["globalId"]) is not None
