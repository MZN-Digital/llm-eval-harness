import Anthropic from "@anthropic-ai/sdk";
import { ExtractionSchema, type Extraction } from "./schema.js";

/**
 * Turn a free-text note into structured tasks.
 *
 * The interesting part of this file is not the model call. It is everything
 * around it: what happens when the model returns prose instead of JSON, when
 * the JSON is valid but the shape is wrong, and how a caller can tell the
 * difference between "no tasks in this text" and "the extraction failed".
 */

const MODEL = "claude-opus-4-5";

/**
 * Kept stable and hoisted out of the function so `cache_control` has something
 * to cache. Anthropic's cache only engages above a minimum token count — below
 * it the marker is silently ignored, with no error and no cache. If you edit
 * this prompt, re-check the length rather than assuming caching still applies.
 */
const SYSTEM_PROMPT = `You extract action items from informal notes.

Return JSON only, matching this shape exactly:

{"tasks": [{"title": string, "assignee": string|null, "due": "YYYY-MM-DD"|null, "time": "HH:MM"|null, "priority": "high"|"normal"|"low"|null}]}

Rules:

1. Use null for anything the text does not state. Do not infer, do not guess,
   do not fill a field to be helpful. A null is a correct answer.
2. Resolve relative dates against the reference date given in the user message.
   If the text gives no date, return null — do not default to today.
3. "priority" is only non-null when the text carries an explicit signal of
   urgency or its absence. Length, tone, or your own sense of importance are
   not signals.
4. A note with no action item returns {"tasks": []}. An empty list is a valid
   and often correct answer.
5. Split into separate tasks only where the text describes separate actions.
   One action with several details is one task.
6. Keep names exactly as written. Do not expand, correct, or normalise them.

7. A person named in the action is the assignee. "Send the deck to Priya"
   has assignee "Priya"; "chase Tom" has assignee "Tom". This is reading
   what the text says, not inferring - rule 1 does not apply.

8. The title is the action, not the whole sentence. Drop qualifying detail
   that describes the action rather than naming it: "Prepare the report,
   including the charts and the summary" has the title "Prepare the report".`;

export type ExtractResult =
  | { ok: true; data: Extraction; raw: string }
  | { ok: false; reason: "not_json" | "schema_mismatch" | "api_error"; raw: string; error: string };

export interface ExtractOptions {
  /** Resolves relative dates. Required — see the note in schema.ts. */
  referenceDate: string;
  client?: Anthropic;
}

export async function extract(text: string, opts: ExtractOptions): Promise<ExtractResult> {
  const client = opts.client ?? new Anthropic();

  let raw: string;
  try {
    const response = await client.messages.create({
      model: MODEL,
      // 1024 truncated a three-task response during the first run, which
      // surfaced as a JSON parse error rather than as a length problem. Raised
      // with room to spare: a truncated response is the most expensive kind of
      // failure to diagnose, because it looks like a model defect.
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Reference date: ${opts.referenceDate}\n\nNote:\n${text}`,
        },
      ],
    });

    const block = response.content[0];
    raw = block && block.type === "text" ? block.text : "";
  } catch (err) {
    return {
      ok: false,
      reason: "api_error",
      raw: "",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Models wrap JSON in prose or fences often enough that stripping is worth
  // doing before declaring failure — but only stripping. Anything beyond that
  // (regex-extracting fields from prose, say) would hide a real regression:
  // the day the model stops returning JSON, we want to see it in the numbers.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    return {
      ok: false,
      reason: "not_json",
      raw,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const result = ExtractionSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: "schema_mismatch", raw, error: result.error.message };
  }

  return { ok: true, data: result.data, raw };
}
