"""All LLM prompt templates, in one place so they can be tuned together.

Kept byte-for-byte equivalent to the TypeScript ``ai/prompts.ts``.
"""

from __future__ import annotations

from typing import Any

SYSTEM_PROMPT = """You are an intelligent Email Management AI Agent. You analyze emails with precision and provide structured, actionable insights.

Your core capabilities:
1. **Summarize** emails into concise 3-5 bullet points
2. **Categorize** emails accurately into predefined categories
3. **Detect urgency** and deadlines with precision
4. **Recommend actions** based on email content and context
5. **Extract tasks** and actionable items from emails

You must ALWAYS respond in the exact JSON format requested. Do not include markdown formatting, code blocks, or any text outside the JSON object."""


def build_summarize_prompt(*, subject: str, sender: str, to: str, date: str, body: str) -> str:
    return f"""Summarize the following email into 3-5 concise bullet points. Each bullet should capture a key piece of information or action item.

Email Details:
- Subject: {subject}
- From: {sender}
- To: {to}
- Date: {date}

Email Body:
{body[:3000]}

Respond with a JSON object in this exact format:
{{
  "summary": "• Bullet point 1
• Bullet point 2
• Bullet point 3",
  "keyTopics": ["topic1", "topic2"],
  "sentiment": "positive" | "neutral" | "negative" | "mixed"
}}"""


def build_categorize_prompt(*, subject: str, sender: str, body: str, snippet: str) -> str:
    return f"""Categorize the following email into exactly ONE of these categories:

- "urgent": Has a deadline today or tomorrow, time-sensitive action required
- "follow-up": Requires the recipient's response or action (but not immediately urgent)
- "promotional": Marketing emails, newsletters, special offers, subscriptions
- "hr-employee": HR communications, appraisals, internal policies, team announcements
- "financial": Invoices, payment requests, billing, expense reports, financial statements
- "informational": FYI emails, announcements, updates that don't require action
- "personal": Personal or social correspondence
- "spam": Junk mail, phishing attempts, irrelevant solicitations

Also assess the urgency score (0-10) where:
- 0-2: No urgency, can be addressed anytime
- 3-4: Low urgency, within a week
- 5-6: Medium urgency, within 2-3 days
- 7-8: High urgency, within 24 hours
- 9-10: Critical urgency, immediate action required

Email:
- Subject: {subject}
- From: {sender}
- Preview: {snippet[:500]}
- Body (first 2000 chars): {body[:2000]}

Respond with a JSON object in this exact format:
{{
  "category": "<category>",
  "urgencyScore": <0-10>,
  "priority": "critical" | "high" | "medium" | "low" | "none",
  "requiresResponse": true | false,
  "deadlineDetected": "<ISO date string or null>",
  "reasoning": "<brief explanation of categorization>"
}}"""


def build_suggest_actions_prompt(
    *, subject: str, sender: str, to: str, body: str, category: str, urgency_score: int
) -> str:
    return f"""Based on the following email, suggest 1-3 appropriate actions the recipient should take.

Email:
- Subject: {subject}
- From: {sender}
- To: {to}
- Category: {category}
- Urgency Score: {urgency_score}/10
- Body: {body[:2000]}

Available action types:
- "reply": Send a reply to the sender
- "reply-all": Reply to all recipients
- "forward": Forward to someone else
- "archive": Archive the email (no action needed)
- "delete": Delete the email
- "label": Apply a label/tag for organization
- "schedule-meeting": Set up a meeting based on content
- "set-reminder": Set a reminder to follow up
- "delegate": Forward to a team member to handle
- "follow-up-later": Snooze and revisit later

Respond with a JSON object:
{{
  "suggestedActions": [
    {{
      "type": "<action type>",
      "description": "<what to do and why>",
      "priority": "critical" | "high" | "medium" | "low" | "none",
      "reasoning": "<why this action is recommended>",
      "draftContent": "<pre-drafted reply text if action is reply/reply-all, otherwise omit>"
    }}
  ]
}}"""


def build_extract_tasks_prompt(*, subject: str, sender: str, body: str) -> str:
    return f"""Extract all actionable tasks, to-do items, and deliverables from the following email.

Email:
- Subject: {subject}
- From: {sender}
- Body: {body[:3000]}

Respond with a JSON object:
{{
  "tasks": [
    {{
      "description": "<clear, actionable task description>",
      "deadline": "<ISO date string if mentioned, or null>",
      "assignee": "<person responsible if mentioned, or null>",
      "priority": "critical" | "high" | "medium" | "low" | "none",
      "source": "<relevant quote or context from email>"
    }}
  ]
}}

If no tasks are found, return {{"tasks": []}}."""


def build_smart_reply_prompt(
    *, subject: str, sender: str, body: str, recipient_name: str, tone: str | None = None, intent: str | None = None
) -> str:
    tone = tone or "professional"
    intent_line = f"User's intent: {intent}" if intent else ""
    return f"""Draft a {tone} reply to the following email.
{intent_line}

Original Email:
- Subject: {subject}
- From: {sender}
- Body: {body[:2000]}

Reply should be from: {recipient_name}

Respond with a JSON object:
{{
  "subject": "<reply subject (Re: original subject)>",
  "body": "<the draft reply text>",
  "tone": "{tone}",
  "notes": "<any notes about assumptions made in the draft>"
}}"""


def build_inbox_summary_prompt(emails: list[dict[str, Any]]) -> str:
    """Each item: subject, from, category, urgencyScore, snippet, date, accountEmail."""
    email_list = "\n".join(
        f"{i + 1}. [{e['category'].upper()}] (Urgency: {e['urgencyScore']}/10) From: {e['from']} | "
        f"Subject: {e['subject']} | Account: {e['accountEmail']} | Date: {e['date']} | Preview: {e['snippet'][:100]}"
        for i, e in enumerate(emails)
    )
    return f"""Generate a comprehensive inbox summary digest for the following {len(emails)} emails across multiple email accounts.

Emails:
{email_list}

Provide a natural-language narrative summary that:
1. Highlights the most urgent items first
2. Groups related emails by category
3. Calls out any deadlines or time-sensitive items
4. Notes which accounts had the most activity
5. Suggests a prioritized action plan for the day

Respond with a JSON object:
{{
  "digest": "<narrative summary text with emoji indicators>",
  "topPriorities": ["<priority 1>", "<priority 2>", "<priority 3>"],
  "actionPlan": "<suggested sequence of actions for the day>"
}}"""


def build_explain_email_prompt(*, subject: str, sender: str, to: str, body: str) -> str:
    return f"""Provide a detailed explanation of the following email. Explain:
1. What the email is about
2. Who sent it and why
3. What are the key implications
4. What actions are expected from the recipient
5. Any important details, dates, or numbers mentioned

Email:
- Subject: {subject}
- From: {sender}
- To: {to}
- Body: {body[:4000]}

Respond with a JSON object:
{{
  "explanation": "<detailed explanation>",
  "keyFacts": ["<fact 1>", "<fact 2>"],
  "implications": ["<implication 1>", "<implication 2>"],
  "expectedActions": ["<action 1>", "<action 2>"]
}}"""
