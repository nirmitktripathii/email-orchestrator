"""Per-email AI tools: summarize, categorize, suggest_actions, smart_reply, explain, extract_tasks, detect_urgency.

Every tool identifies an email by its global id (``accountId:messageId``).
None of them send mail — smart_reply can at most save a DRAFT.
"""

from __future__ import annotations

from typing import Any

from ..utils.errors import get_error_message
from .context import ToolContext, ToolDefinition, ToolOutput, optional_bool, optional_string, require_string
from .summary_builder import CATEGORY_EMOJI

GLOBAL_ID_SCHEMA = {
    "type": "string",
    "description": 'The email\'s global id in "accountId:messageId" form, as returned by inbox_summary/search_all.',
}
_ID_ONLY = {"type": "object", "properties": {"globalId": GLOBAL_ID_SCHEMA}, "required": ["globalId"]}


def _join(parts: list[str]) -> str:
    return "\n".join(p for p in parts if p)


def _bullets(title: str, items: list[Any]) -> str:
    return f"\n{title}:\n- " + "\n- ".join(str(i) for i in items) if items else ""


async def _resolve(args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    return await ctx.enrichment.resolve_email(require_string(args, "globalId"), ctx.providers)


async def _summarize_email(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    email = await _resolve(args, ctx)
    r = await ctx.summarizer.summarize_email(email)
    text = _join(
        [
            f"📩 {email['subject']}",
            f"From: {email['from']['name'] or email['from']['email']} · {email['accountEmail']}",
            "",
            r["summary"],
            f"\nTopics: {', '.join(r['keyTopics'])}" if r["keyTopics"] else "",
            f"Sentiment: {r['sentiment']}",
        ]
    )
    return ToolOutput(text, {"globalId": email["globalId"], **r})


async def _categorize_email(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    email = await _resolve(args, ctx)
    c = await ctx.categorizer.categorize_email(email)
    text = _join(
        [
            f"{CATEGORY_EMOJI[c['category']]} Category: {c['category']}",
            f"Urgency: {c['urgencyScore']}/10 · Priority: {c['priority']}",
            f"Requires response: {'yes' if c['requiresResponse'] else 'no'}",
            f"Deadline: {c['deadlineDetected']}" if c.get("deadlineDetected") else "",
            f"\n{c['reasoning']}" if c.get("reasoning") else "",
        ]
    )
    return ToolOutput(text, {"globalId": email["globalId"], **c})


async def _suggest_actions(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    email = await _resolve(args, ctx)
    enriched = email if email.get("aiEnrichment") else {**email, "aiEnrichment": await ctx.enrichment.enrich(email, "category")}
    actions = await ctx.action_recommender.suggest_actions(enriched)
    if actions:
        text = "\n".join(
            f"{i + 1}. {a.get('type')} ({a.get('priority')}) — {a.get('description')}\n   {a.get('reasoning', '')}"
            + (f"\n   Draft: {a['draftContent']}" if a.get("draftContent") else "")
            for i, a in enumerate(actions)
        )
    else:
        text = "No specific actions recommended."
    return ToolOutput(text, {"globalId": email["globalId"], "actions": actions})


async def _smart_reply(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    email = await _resolve(args, ctx)
    tone = optional_string(args, "tone")
    intent = optional_string(args, "intent")
    sender_name = optional_string(args, "senderName") or email["accountEmail"]
    save_draft = optional_bool(args, "saveDraft", False)

    reply = await ctx.action_recommender.generate_smart_reply(email, sender_name, tone=tone, intent=intent)

    draft_note = ""
    if save_draft:
        draft: dict[str, Any] = {
            "to": [(email.get("replyTo") or {}).get("email") or email["from"]["email"]],
            "subject": reply["subject"],
            "body": reply["body"],
        }
        if email.get("id"):
            draft["inReplyTo"] = email["id"]
        if email.get("threadId"):
            draft["threadId"] = email["threadId"]
        try:
            res = await ctx.providers.create_draft(email["accountId"], draft)
            draft_note = (
                f"\n\n💾 Saved as draft (id: {res['draftId']}) in {email['accountEmail']}. Review and send it yourself."
            )
        except Exception as e:
            draft_note = f"\n\n⚠️ Could not save draft: {get_error_message(e)}"

    notes = f"\n\nNotes: {reply['notes']}" if reply["notes"] else ""
    text = f"✍️ Draft reply ({reply['tone']}) — not sent:\n\nSubject: {reply['subject']}\n\n{reply['body']}{notes}{draft_note}"
    return ToolOutput(text, {"globalId": email["globalId"], "reply": reply, "savedDraft": save_draft})


async def _explain_email(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    email = await _resolve(args, ctx)
    r = await ctx.action_recommender.explain_email(email)
    text = _join(
        [
            r["explanation"],
            _bullets("Key facts", r["keyFacts"]),
            _bullets("Implications", r["implications"]),
            _bullets("Expected of you", r["expectedActions"]),
        ]
    )
    return ToolOutput(text, {"globalId": email["globalId"], **r})


async def _extract_tasks(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    email = await _resolve(args, ctx)
    tasks = await ctx.action_recommender.extract_tasks(email)
    if tasks:
        text = "\n".join(
            f"{i + 1}. {t.get('description')}"
            + (f" (due {t['deadline']})" if t.get("deadline") else "")
            + (f" — {t['assignee']}" if t.get("assignee") else "")
            + f" [{t.get('priority')}]"
            for i, t in enumerate(tasks)
        )
    else:
        text = "No actionable tasks found in this email."
    return ToolOutput(text, {"globalId": email["globalId"], "tasks": tasks})


async def _detect_urgency(args: dict[str, Any], ctx: ToolContext) -> ToolOutput:
    email = await _resolve(args, ctx)
    c = await ctx.categorizer.categorize_email(email)
    deadline = f" · deadline {c['deadlineDetected']}" if c.get("deadlineDetected") else ""
    text = f"Urgency: {c['urgencyScore']}/10 (priority: {c['priority']}){deadline}\n{c['reasoning']}"
    return ToolOutput(
        text,
        {
            "globalId": email["globalId"],
            "urgencyScore": c["urgencyScore"],
            "priority": c["priority"],
            "deadlineDetected": c.get("deadlineDetected"),
            "reasoning": c["reasoning"],
        },
    )


EMAIL_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        "summarize_email",
        "Generate a concise 3-5 bullet-point AI summary of a specific email (like Gmail's Gemini AI Overview), "
        "plus key topics and sentiment.",
        _ID_ONLY,
        _summarize_email,
    ),
    ToolDefinition(
        "categorize_email",
        "Classify a specific email into one of 8 categories (urgent, follow-up, promotional, hr-employee, financial, "
        "informational, personal, spam) with an urgency score (0-10) and reasoning.",
        _ID_ONLY,
        _categorize_email,
    ),
    ToolDefinition(
        "suggest_actions",
        "Recommend 1-3 next actions for a specific email (reply, forward, archive, schedule-meeting, set-reminder, "
        "delegate, etc.) with reasoning and, where relevant, a draft reply.",
        _ID_ONLY,
        _suggest_actions,
    ),
    ToolDefinition(
        "smart_reply",
        "Draft a context-aware reply to a specific email. Returns the draft text; it does NOT send. "
        "Set saveDraft=true to also save it as a draft in the account (still never sends).",
        {
            "type": "object",
            "properties": {
                "globalId": GLOBAL_ID_SCHEMA,
                "tone": {
                    "type": "string",
                    "enum": ["professional", "friendly", "formal", "casual"],
                    "description": "Desired tone (default professional).",
                },
                "intent": {
                    "type": "string",
                    "description": 'What you want the reply to accomplish (e.g. "accept the meeting", "ask for an extension").',
                },
                "senderName": {"type": "string", "description": "Your display name to sign the reply as (defaults to the account)."},
                "saveDraft": {
                    "type": "boolean",
                    "description": "Also save the reply as a draft in the account (default false). Never sends.",
                },
            },
            "required": ["globalId"],
        },
        _smart_reply,
    ),
    ToolDefinition(
        "explain_email",
        "Deep-dive explanation of a specific email: what it is about, why it was sent, key facts, implications, "
        "and what is expected of you.",
        _ID_ONLY,
        _explain_email,
    ),
    ToolDefinition(
        "extract_tasks",
        "Extract actionable tasks / to-dos / deliverables from a specific email, with deadlines and assignees where mentioned.",
        _ID_ONLY,
        _extract_tasks,
    ),
    ToolDefinition(
        "detect_urgency",
        "Analyze the urgency of a specific email on a 0-10 scale with a priority level and reasoning "
        "(also detects any deadline).",
        _ID_ONLY,
        _detect_urgency,
    ),
]
