/**
 * @module ai/prompts
 * @description All LLM prompt templates for the Email AI Agent.
 * Centralized prompt management for consistency and easy tuning.
 */

/**
 * System prompt for the email AI agent.
 */
export const SYSTEM_PROMPT = `You are an intelligent Email Management AI Agent. You analyze emails with precision and provide structured, actionable insights.

Your core capabilities:
1. **Summarize** emails into concise 3-5 bullet points
2. **Categorize** emails accurately into predefined categories
3. **Detect urgency** and deadlines with precision
4. **Recommend actions** based on email content and context
5. **Extract tasks** and actionable items from emails

You must ALWAYS respond in the exact JSON format requested. Do not include markdown formatting, code blocks, or any text outside the JSON object.`;

/**
 * Prompt template for per-email summarization.
 */
export function buildSummarizePrompt(email: {
  subject: string;
  from: string;
  to: string;
  date: string;
  body: string;
}): string {
  return `Summarize the following email into 3-5 concise bullet points. Each bullet should capture a key piece of information or action item.

Email Details:
- Subject: ${email.subject}
- From: ${email.from}
- To: ${email.to}
- Date: ${email.date}

Email Body:
${email.body.slice(0, 3000)}

Respond with a JSON object in this exact format:
{
  "summary": "• Bullet point 1\n• Bullet point 2\n• Bullet point 3",
  "keyTopics": ["topic1", "topic2"],
  "sentiment": "positive" | "neutral" | "negative" | "mixed"
}`;
}

/**
 * Prompt template for email categorization.
 */
export function buildCategorizePrompt(email: {
  subject: string;
  from: string;
  body: string;
  snippet: string;
}): string {
  return `Categorize the following email into exactly ONE of these categories:

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
- Subject: ${email.subject}
- From: ${email.from}
- Preview: ${email.snippet.slice(0, 500)}
- Body (first 2000 chars): ${email.body.slice(0, 2000)}

Respond with a JSON object in this exact format:
{
  "category": "<category>",
  "urgencyScore": <0-10>,
  "priority": "critical" | "high" | "medium" | "low" | "none",
  "requiresResponse": true | false,
  "deadlineDetected": "<ISO date string or null>",
  "reasoning": "<brief explanation of categorization>"
}`;
}

/**
 * Prompt template for suggesting actions on an email.
 */
export function buildSuggestActionsPrompt(email: {
  subject: string;
  from: string;
  to: string;
  body: string;
  category: string;
  urgencyScore: number;
}): string {
  return `Based on the following email, suggest 1-3 appropriate actions the recipient should take.

Email:
- Subject: ${email.subject}
- From: ${email.from}
- To: ${email.to}
- Category: ${email.category}
- Urgency Score: ${email.urgencyScore}/10
- Body: ${email.body.slice(0, 2000)}

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
{
  "suggestedActions": [
    {
      "type": "<action type>",
      "description": "<what to do and why>",
      "priority": "critical" | "high" | "medium" | "low" | "none",
      "reasoning": "<why this action is recommended>",
      "draftContent": "<pre-drafted reply text if action is reply/reply-all, otherwise omit>"
    }
  ]
}`;
}

/**
 * Prompt template for extracting tasks from an email.
 */
export function buildExtractTasksPrompt(email: {
  subject: string;
  from: string;
  body: string;
}): string {
  return `Extract all actionable tasks, to-do items, and deliverables from the following email.

Email:
- Subject: ${email.subject}
- From: ${email.from}
- Body: ${email.body.slice(0, 3000)}

Respond with a JSON object:
{
  "tasks": [
    {
      "description": "<clear, actionable task description>",
      "deadline": "<ISO date string if mentioned, or null>",
      "assignee": "<person responsible if mentioned, or null>",
      "priority": "critical" | "high" | "medium" | "low" | "none",
      "source": "<relevant quote or context from email>"
    }
  ]
}

If no tasks are found, return {"tasks": []}.`;
}

/**
 * Prompt template for generating a smart reply.
 */
export function buildSmartReplyPrompt(email: {
  subject: string;
  from: string;
  body: string;
  recipientName: string;
  tone?: 'professional' | 'friendly' | 'formal' | 'casual';
  intent?: string;
}): string {
  const tone = email.tone ?? 'professional';
  return `Draft a ${tone} reply to the following email.
${email.intent ? `User's intent: ${email.intent}` : ''}

Original Email:
- Subject: ${email.subject}
- From: ${email.from}
- Body: ${email.body.slice(0, 2000)}

Reply should be from: ${email.recipientName}

Respond with a JSON object:
{
  "subject": "<reply subject (Re: original subject)>",
  "body": "<the draft reply text>",
  "tone": "${tone}",
  "notes": "<any notes about assumptions made in the draft>"
}`;
}

/**
 * Prompt template for inbox-level summary/digest.
 */
export function buildInboxSummaryPrompt(emails: readonly {
  subject: string;
  from: string;
  category: string;
  urgencyScore: number;
  snippet: string;
  date: string;
  accountEmail: string;
}[]): string {
  const emailList = emails.map((e, i) =>
    `${i + 1}. [${e.category.toUpperCase()}] (Urgency: ${e.urgencyScore}/10) From: ${e.from} | Subject: ${e.subject} | Account: ${e.accountEmail} | Date: ${e.date} | Preview: ${e.snippet.slice(0, 100)}`
  ).join('\n');

  return `Generate a comprehensive inbox summary digest for the following ${emails.length} emails across multiple email accounts.

Emails:
${emailList}

Provide a natural-language narrative summary that:
1. Highlights the most urgent items first
2. Groups related emails by category
3. Calls out any deadlines or time-sensitive items
4. Notes which accounts had the most activity
5. Suggests a prioritized action plan for the day

Respond with a JSON object:
{
  "digest": "<narrative summary text with emoji indicators>",
  "topPriorities": ["<priority 1>", "<priority 2>", "<priority 3>"],
  "actionPlan": "<suggested sequence of actions for the day>"
}`;
}

/**
 * Prompt template for explaining an email in detail.
 */
export function buildExplainEmailPrompt(email: {
  subject: string;
  from: string;
  to: string;
  body: string;
}): string {
  return `Provide a detailed explanation of the following email. Explain:
1. What the email is about
2. Who sent it and why
3. What are the key implications
4. What actions are expected from the recipient
5. Any important details, dates, or numbers mentioned

Email:
- Subject: ${email.subject}
- From: ${email.from}
- To: ${email.to}
- Body: ${email.body.slice(0, 4000)}

Respond with a JSON object:
{
  "explanation": "<detailed explanation>",
  "keyFacts": ["<fact 1>", "<fact 2>"],
  "implications": ["<implication 1>", "<implication 2>"],
  "expectedActions": ["<action 1>", "<action 2>"]
}`;
}
