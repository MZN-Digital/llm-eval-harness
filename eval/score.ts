import type { Task } from "../src/schema.js";

/**
 * How a run is judged.
 *
 * Deliberately deterministic. An LLM-as-judge is the right tool when the
 * output is prose and correctness is a matter of degree; here the output is
 * five typed fields and correctness is a matter of fact. Using a model to
 * grade this would add cost, latency, and a second source of error to a
 * comparison that `===` already answers.
 *
 * The judge earns its place at the title field, and only there — "Call Ayşe
 * about the budget" and "Call Ayşe re: budget" are the same answer. That case
 * is handled by normalisation below rather than by a second model call,
 * because a rule you can read beats a rule you have to trust.
 */

export type FailureClass =
  /** Filled a field the input never stated. The failure this harness exists for. */
  | "hallucinated_field"
  /** Left a field null that the input did state. */
  | "missed_field"
  /** Field present in both, values disagree. */
  | "wrong_value"
  /** Found tasks in a note that contains none. */
  | "phantom_task"
  /** Found no tasks in a note that contains one. */
  | "missed_task"
  /** One action reported as several. */
  | "over_split"
  /** Several actions reported as one. */
  | "under_split"
  /** Response was not usable JSON, or did not match the schema. */
  | "malformed";

export interface FieldFailure {
  caseId: string;
  class: FailureClass;
  field?: string;
  expected?: unknown;
  got?: unknown;
}

/**
 * Titles are prose, so they are compared on content rather than characters.
 * Filler words carry no information about the action and their presence is not
 * a defect worth failing a case over.
 */
const FILLER = new Set([
  "the", "a", "an", "to", "for", "about", "re", "on", "of", "with", "at",
  "and", "in", "please", "let's", "lets", "we", "i", "you",
]);

function normaliseTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .sort()
    .join(" ");
}

function titlesMatch(a: string, b: string): boolean {
  const na = normaliseTitle(a);
  const nb = normaliseTitle(b);
  if (na === nb) return true;

  // Partial credit for a title that carries the same content words plus or
  // minus one — "Call the bank about the transfer" vs "Call the bank".
  const sa = new Set(na.split(" "));
  const sb = new Set(nb.split(" "));
  const shared = [...sa].filter((w) => sb.has(w)).length;
  const larger = Math.max(sa.size, sb.size);
  return larger > 0 && shared / larger >= 0.6;
}

const FIELDS = ["assignee", "due", "time", "priority"] as const;

export interface CaseScore {
  caseId: string;
  caseClass: string;
  passed: boolean;
  failures: FieldFailure[];
  /** Fields correct out of fields compared. Partial credit, for trend lines. */
  fieldAccuracy: number;
}

export function scoreCase(
  caseId: string,
  caseClass: string,
  expected: Task[],
  got: Task[] | null,
): CaseScore {
  const failures: FieldFailure[] = [];

  if (got === null) {
    return {
      caseId,
      caseClass,
      passed: false,
      failures: [{ caseId, class: "malformed" }],
      fieldAccuracy: 0,
    };
  }

  // Task-count disagreements are their own failure class, because they have
  // their own causes and their own fixes. Counting them as five wrong fields
  // would let one structural error swamp the field-level numbers.
  if (expected.length === 0 && got.length > 0) {
    failures.push({ caseId, class: "phantom_task", expected: 0, got: got.length });
  } else if (expected.length > 0 && got.length === 0) {
    failures.push({ caseId, class: "missed_task", expected: expected.length, got: 0 });
  } else if (got.length > expected.length) {
    failures.push({ caseId, class: "over_split", expected: expected.length, got: got.length });
  } else if (got.length < expected.length) {
    failures.push({ caseId, class: "under_split", expected: expected.length, got: got.length });
  }

  let compared = 0;
  let correct = 0;

  const pairs = Math.min(expected.length, got.length);
  for (let i = 0; i < pairs; i++) {
    const e = expected[i]!;
    const g = got[i]!;

    compared++;
    if (titlesMatch(e.title, g.title)) correct++;
    else failures.push({ caseId, class: "wrong_value", field: "title", expected: e.title, got: g.title });

    for (const field of FIELDS) {
      compared++;
      const ev = e[field];
      const gv = g[field];

      if (ev === gv) {
        correct++;
        continue;
      }

      // The distinction this whole harness is built to measure: inventing a
      // value is a different defect from missing one, and they are fixed by
      // opposite changes to the prompt.
      if (ev === null && gv !== null) {
        failures.push({ caseId, class: "hallucinated_field", field, expected: null, got: gv });
      } else if (ev !== null && gv === null) {
        failures.push({ caseId, class: "missed_field", field, expected: ev, got: null });
      } else {
        failures.push({ caseId, class: "wrong_value", field, expected: ev, got: gv });
      }
    }
  }

  return {
    caseId,
    caseClass,
    passed: failures.length === 0,
    failures,
    fieldAccuracy: compared === 0 ? 1 : correct / compared,
  };
}
