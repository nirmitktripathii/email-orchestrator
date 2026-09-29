"""Wiring: build every engine from an AppConfig. Shared by the server and the CLIs."""

from __future__ import annotations

from .ai.action_recommender import ActionRecommender
from .ai.categorizer import EmailCategorizer
from .ai.enrichment import EmailEnrichmentService
from .ai.llm_client import LLMClient
from .ai.summarizer import EmailSummarizer
from .core.types import AppConfig
from .providers.manager import ProviderManager
from .tools import ToolContext


def build_context(config: AppConfig) -> tuple[ToolContext, LLMClient]:
    llm = LLMClient(config.llm)
    summarizer = EmailSummarizer(llm)
    categorizer = EmailCategorizer(llm)
    recommender = ActionRecommender(llm)
    enrichment = EmailEnrichmentService(
        summarizer,
        categorizer,
        recommender,
        cache_ttl_seconds=config.cache.ttl_seconds,
        max_cache_entries=config.cache.max_entries,
    )
    providers = ProviderManager.from_config(config)
    return ToolContext(config, providers, enrichment, summarizer, categorizer, recommender), llm
