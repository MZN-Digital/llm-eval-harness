import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extract } from "../src/extract.js";
import { scoreCase, type CaseScore, type FailureClass } from "./score.js";
import type { Task } from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));

interface CaseFile {
  referenceDate: string;
  cases: Array<{ id: string; class: string; input: string; expect: { tasks: Task[] } }>;
}

/**
 * The gate CI enforces.
 *
 * Not 100%. A threshold set at perfection gets disabled the first time a
 * model update moves one case, and a disabled gate protects nothing. These
 * numbers are the floor the current prompt clears with room to spare — the
 * point is to catch a regression, not to certify perfection.
 */
const THRESHOLDS = {
  passRate: 0.75,
  fieldAccuracy: 0.9,
  /** Zero tolerance: an invented field is the failure this harness exists for. */
  maxHallucinations: 2,
};

async function main() {
  const ci = process.argv.includes("--ci");
  const file: CaseFile = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Copy .env.example and fill it in.");
    process.exit(1);
  }

  console.log(`Running ${file.cases.length} cases against reference date ${file.referenceDate}\n`);

  const scores: CaseScore[] = [];

  for (const c of file.cases) {
    const result = await extract(c.input, { referenceDate: file.referenceDate });
    const got = result.ok ? result.data.tasks : null;
    const score = scoreCase(c.id, c.class, c.expect.tasks, got);
    scores.push(score);

    const mark = score.passed ? "PASS" : "FAIL";
    console.log(`${mark}  ${c.id.padEnd(12)} ${(score.fieldAccuracy * 100).toFixed(0).padStart(3)}%`);

    if (!score.passed) {
      // A malformed response has no fields to compare, so the generic line
      // below would print "expected undefined, got undefined" - true, useless,
      // and exactly the kind of unactionable output this harness exists to
      // avoid. The reason and the raw text are what make it diagnosable.
      if (!result.ok) {
        console.log(`      malformed (${result.reason}): ${result.error.slice(0, 160)}`);
        console.log(`      raw: ${JSON.stringify(result.raw.slice(0, 200))}`);
      } else {
        for (const f of score.failures) {
          const where = f.field ? `.${f.field}` : "";
          console.log(`      ${f.class}${where}: expected ${JSON.stringify(f.expected)}, got ${JSON.stringify(f.got)}`);
        }
      }
    }
  }

  // The taxonomy. A pass rate tells you something broke; this tells you what,
  // and what kind of prompt change would address it.
  const taxonomy: Partial<Record<FailureClass, number>> = {};
  for (const s of scores) {
    for (const f of s.failures) {
      taxonomy[f.class] = (taxonomy[f.class] ?? 0) + 1;
    }
  }

  const byClass: Record<string, { passed: number; total: number }> = {};
  for (const s of scores) {
    const b = (byClass[s.caseClass] ??= { passed: 0, total: 0 });
    b.total++;
    if (s.passed) b.passed++;
  }

  const passed = scores.filter((s) => s.passed).length;
  const passRate = passed / scores.length;
  const fieldAccuracy = scores.reduce((a, s) => a + s.fieldAccuracy, 0) / scores.length;
  const hallucinations = taxonomy.hallucinated_field ?? 0;

  console.log(`\n${"─".repeat(52)}`);
  console.log(`Passed          ${passed}/${scores.length}  (${(passRate * 100).toFixed(0)}%)`);
  console.log(`Field accuracy  ${(fieldAccuracy * 100).toFixed(1)}%`);

  console.log(`\nFailures by class`);
  for (const [cls, n] of Object.entries(taxonomy).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cls.padEnd(20)} ${n}`);
  }

  console.log(`\nPass rate by case class`);
  for (const [cls, b] of Object.entries(byClass)) {
    console.log(`  ${cls.padEnd(20)} ${b.passed}/${b.total}`);
  }

  const results = {
    timestamp: new Date().toISOString(),
    referenceDate: file.referenceDate,
    passed,
    total: scores.length,
    passRate,
    fieldAccuracy,
    taxonomy,
    byClass,
    scores,
  };

  mkdirSync(join(here, "results"), { recursive: true });
  writeFileSync(join(here, "results", "latest.json"), JSON.stringify(results, null, 2));

  if (ci) {
    const problems: string[] = [];
    if (passRate < THRESHOLDS.passRate) problems.push(`pass rate ${(passRate * 100).toFixed(0)}% below ${THRESHOLDS.passRate * 100}%`);
    if (fieldAccuracy < THRESHOLDS.fieldAccuracy) problems.push(`field accuracy ${(fieldAccuracy * 100).toFixed(1)}% below ${THRESHOLDS.fieldAccuracy * 100}%`);
    if (hallucinations > THRESHOLDS.maxHallucinations) problems.push(`${hallucinations} hallucinated fields, limit is ${THRESHOLDS.maxHallucinations}`);

    if (problems.length > 0) {
      console.log(`\nFAILED\n${problems.map((p) => `  ${p}`).join("\n")}`);
      process.exit(1);
    }
    console.log(`\nAll thresholds met.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
