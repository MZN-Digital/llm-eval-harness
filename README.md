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

Output — the current run on `main`, unedited:

```
PASS  plain-01     100%
FAIL  plain-02      80%
      wrong_value.due: expected "2026-09-04", got "2026-09-05"
PASS  plain-03     100%
...
PASS  trap-03      100%
FAIL  noise-01      90%
      wrong_value.due: expected "2026-09-02", got "2026-09-03"

────────────────────────────────────────────────────
Passed          17/20  (85%)
Field accuracy  97.5%

Failures by class
  wrong_value          3

Pass rate by case class
  straightforward      2/3
  no_task              3/3
  must_be_null         4/4
  multiple             2/2
  distractor           3/3
  relative_date        2/3
```

That last block is the reason to build this. A pass rate says something broke.
The taxonomy says what kind of thing broke, and therefore what to change.

## What the first run actually found

Kept here rather than tidied away, because the point of the harness is what it
catches — and the first run caught three things, only one of which was the
model.

```
Passed          12/20  (60%)
Field accuracy  83.0%

Failures by class
  wrong_value          5
  missed_field         4
  malformed            2
  hallucinated_field   0
```

**Zero hallucinations, and every distractor passed (3/3).** The model did not
invent a date, an owner, or a priority anywhere in twenty cases, and it was not
fooled by "yesterday I finally sent the contract", by a conditional that had
not happened, or by a negation. That is the failure this repository was built
to detect, and it did not occur.

What did occur:

**1. Two `malformed` results that reported nothing useful.** The line read
`expected undefined, got undefined` — true, and useless. A malformed response
has no fields to compare, so the generic failure printer had nothing to say.
The cause turned out to be `max_tokens: 1024` truncating a three-task response
mid-JSON, which surfaced as a parse error and looked like a model defect. Two
fixes: the runner now prints the failure reason and the raw text, and the limit
was raised. **This was a harness bug, not a model one** — and the harness only
found it because a case existed that was long enough to hit it.

**2. Four `missed_field` on names that were plainly in the text.** "Send the
deck to Priya" came back with `assignee: null`. The cause was the prompt's own
rule 1 — *do not infer, do not guess* — working too well: the model treated
reading a name as inference. Fixed by naming the case explicitly rather than by
loosening the rule, since loosening it is how you trade a missed field for a
hallucinated one.

**3. One eval case that was wrong.** `"maybe wed??"` expected a firm date. A
model returning null for a hedged date is arguably more correct than one that
commits, so the case was testing the harness author's preference rather than
the model's behaviour. Rewritten.

The distinction between (1), (2) and (3) is the whole argument for building
this: a single accuracy number would have shown 60% and pointed at the model,
when a third of the gap was in the harness and a third was a fixable prompt
rule.

### After those fixes

```
Passed          17/20  (85%)
Field accuracy  97.5%

Failures by class
  wrong_value          3
  hallucinated_field   0
  missed_field         0
  malformed            0
```

The three remaining failures are one defect, found three times:

```
"by Friday"           expected 2026-09-04, got 2026-09-05
"end of this week"    expected 2026-09-04, got 2026-09-05
"wed morning"         expected 2026-09-02, got 2026-09-03
```

The reference date is Tuesday 1 September 2026. Friday is the 4th and Wednesday
is the 2nd. The model is one day late, consistently, on every weekday name.

That consistency is what makes it worth reporting. A scattered set of date
errors would suggest the model is weak at arithmetic; three errors all off by
exactly one day in the same direction is a systematic off-by-one in how the
model counts forward from a reference date — reproducible, and therefore
fixable, most likely by giving it the weekday of the reference date rather than
only the date.

It is left unfixed here on purpose. The gate is green at 85% with zero
hallucinations, and this is what a real backlog item looks like: a defect that
is named, bounded, reproducible on demand, and waiting rather than hidden.

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
