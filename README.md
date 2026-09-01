# llm-eval-harness

A worked example of the part most LLM demos skip: **how you know it works.**

The feature here is small on purpose — pull action items out of an informal
note and return them as typed fields. The feature is not the point. The point
is everything around it: twenty fixed cases, a scorer that distinguishes
between the ways it can be wrong, a failure taxonomy that says which way it was
wrong this time, and a CI gate that turns a prompt edit into a measured change
rather than a hope.

```
"Call Ayşe tomorrow at 3pm about the budget."

→ { title: "Call Ayşe about the budget",
    assignee: "Ayşe",
    due: "2026-09-02",
    time: "15:00",
    priority: null }
```

---

## Why this repository exists

Most AI work is now evaluated on a demo. A demo shows that a thing can work
once. It says nothing about how often, on what inputs, or in which direction it
fails — and those are the questions that decide whether a feature can ship.

A model that extracts a due date correctly nine times out of ten is not "90%
good". It depends entirely on the tenth. If it returns null when the date is
ambiguous, that is a usable system with a gap. If it invents a plausible date,
that is a system that quietly puts wrong data in front of a user, and nobody
finds out until someone misses a deadline.

Both look identical on a pass rate. This harness separates them.

## The distinction it is built around

The scorer has eight failure classes, and the two that matter most are the two
a naive accuracy score merges:

| Class | What happened | What fixes it |
|---|---|---|
| `hallucinated_field` | Filled a field the input never stated | Tighten the null rule; make null a documented answer |
| `missed_field` | Left null a field the input did state | Loosen it; add examples of the pattern being missed |

These are **opposite** defects, fixed by **opposite** changes. A single
accuracy number tells you to do something; it does not tell you which. Every
prompt iteration that treats them as one number risks fixing one by causing the
other.

The remaining six: `wrong_value`, `phantom_task`, `missed_task`, `over_split`,
`under_split`, `malformed`.

## The twenty cases

Not twenty random notes. Twenty notes chosen so each one can only be passed for
the right reason.

| Class | n | What it catches |
|---|---|---|
| `straightforward` | 3 | The baseline. If these fail, something is badly wrong. |
| `no_task` | 3 | A note with nothing to do. Tests whether `[]` is available as an answer. |
| `must_be_null` | 4 | A real task with no date, no owner, no priority. **The core case.** |
| `multiple` | 2 | Several actions in one note. |
| `over_splitting` | 1 | One action with several details — must stay one task. |
| `relative_date` | 3 | "next Monday", "end of this week", "in two weeks". |
| `distractor` | 3 | Something that reads like a task and isn't: already done, conditional, negated. |
| `messy_input` | 1 | Abbreviations, typos, no punctuation. |

The distractors are where the interesting failures live. *"Don't send the
newsletter today, it's going out Thursday instead"* contains one task, dated
Thursday — a model that pattern-matches on "send" and "today" gets both halves
wrong.

*"Yesterday I finally sent the contract to Ali"* contains none. A model
rewarded for being helpful will produce one anyway.

## Design decisions worth arguing with

**The scorer is deterministic, not LLM-as-judge.** Judging is the right tool
when the output is prose and correctness is a matter of degree. Here the output
is five typed fields and correctness is a matter of fact — `===` answers it
without adding cost, latency, and a second source of error. The one place
judgement is genuinely needed is the title, where *"Call Ayşe about the
budget"* and *"Call Ayşe re: budget"* are the same answer; that is handled by
content-word normalisation, because a rule you can read beats a rule you have
to trust.

**The reference date is fixed in the case file.** Relative dates resolve
against `2026-09-01`, not the wall clock. Without that, "next Monday" produces
a different answer every week and the regression suite is worthless.

**Every field except `title` is nullable, and the prompt says so.** A model
asked for a due date will invent one rather than return nothing — it has been
trained to be helpful, and an empty field reads as an unhelpful answer. Making
null explicit is what makes "I don't know" available at all. The
`must_be_null` cases exist to check that it stayed available.

**The CI threshold is 75%, not 100%.** A gate set at perfection gets disabled
the first time a model update moves one case, and a disabled gate protects
nothing. Hallucinations have their own separate, much tighter limit — because
that is the failure this repository exists to catch.

**The unit tests never call the API.** They test the code around the model:
what happens when it returns prose, valid JSON in the wrong shape, an invented
enum value, a date like `"tomorrow"`, or a 529. That is a different question
from whether the model is right, needs no network, and has to stay fast enough
that nobody skips it.

## Running it

```bash
npm install
cp .env.example .env      # add your ANTHROPIC_API_KEY

npm test                  # unit tests — no API calls, no key needed
npm run eval              # the 20 cases against the live model
npm run eval:ci           # same, exits non-zero if thresholds are missed
```

Output:

```
PASS  plain-01      100%
FAIL  null-02        80%
      hallucinated_field.due: expected null, got "2026-09-01"
...
────────────────────────────────────────────────────
Passed          17/20  (85%)
Field accuracy  94.0%

Failures by class
  hallucinated_field   2
  wrong_value          1

Pass rate by case class
  must_be_null         3/4
  distractor           2/3
```

That last block is the reason to build this. A pass rate says something broke.
The taxonomy says what kind of thing broke, and therefore what to change.

## Layout

```
src/schema.ts          The shape, and why every field is nullable
src/extract.ts         The model call, and the three ways it can fail
eval/cases.json        Twenty cases, eight classes, one fixed reference date
eval/score.ts          The scorer and its taxonomy
eval/run.ts            Runner, reporting, CI thresholds
tests/extract.spec.ts  What happens when the model misbehaves
.github/workflows/     Unit tests on every push; eval on every push to main
```

## What this is not

Not a library. Not a framework. Not a benchmark to compare models on — twenty
cases is enough to catch a regression in one feature, and nowhere near enough
to rank anything.

It is one honest example of what it takes to say "this works" and be able to
show the evidence.

---

Built by [Mizen Digital](https://mizendigital.com). MIT.
