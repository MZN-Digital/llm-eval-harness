import { describe, it, expect } from "vitest";
import { extract } from "../src/extract.js";
import { scoreCase } from "../eval/score.js";

/**
 * These tests never call the API.
 *
 * The eval suite measures whether the model is right. This measures whether
 * the code around it behaves when the model is wrong — which is a different
 * question, needs no network, and must stay fast enough that nobody is tempted
 * to skip it.
 *
 * A stub client stands in for the SDK. It returns exactly what a real one
 * would on the failure paths that actually occur in production: prose instead
 * of JSON, valid JSON in the wrong shape, and a thrown error.
 */
function stubClient(reply: string | Error) {
  return {
    messages: {
      create: async () => {
        if (reply instanceof Error) throw reply;
        return { content: [{ type: "text", text: reply }] };
      },
    },
  } as never;
}

const opts = (client: never) => ({ referenceDate: "2026-09-01", client });

describe("extract — the model behaves", () => {
  it("parses a well-formed response", async () => {
    const r = await extract("Call Ayşe tomorrow", opts(stubClient(
      '{"tasks":[{"title":"Call Ayşe","assignee":"Ayşe","due":"2026-09-02","time":null,"priority":null}]}',
    )));

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.tasks).toHaveLength(1);
      expect(r.data.tasks[0]!.assignee).toBe("Ayşe");
    }
  });

  it("accepts an empty task list as a valid answer", async () => {
    const r = await extract("Thanks!", opts(stubClient('{"tasks":[]}')));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.tasks).toEqual([]);
  });

  it("strips code fences the model adds unbidden", async () => {
    const r = await extract("x", opts(stubClient(
      '```json\n{"tasks":[{"title":"Do it","assignee":null,"due":null,"time":null,"priority":null}]}\n```',
    )));
    expect(r.ok).toBe(true);
  });
});

describe("extract — the model misbehaves", () => {
  it("reports prose as not_json rather than throwing", async () => {
    const r = await extract("x", opts(stubClient("Sure! Here are the tasks I found:")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_json");
  });

  it("rejects valid JSON in the wrong shape", async () => {
    const r = await extract("x", opts(stubClient('{"tasks":[{"title":"Do it"}]}')));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_mismatch");
  });

  it("rejects an invented enum value", async () => {
    const r = await extract("x", opts(stubClient(
      '{"tasks":[{"title":"Do it","assignee":null,"due":null,"time":null,"priority":"urgent"}]}',
    )));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_mismatch");
  });

  it("rejects a malformed date rather than passing it downstream", async () => {
    const r = await extract("x", opts(stubClient(
      '{"tasks":[{"title":"Do it","assignee":null,"due":"tomorrow","time":null,"priority":null}]}',
    )));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("schema_mismatch");
  });

  it("surfaces an API error without crashing the caller", async () => {
    const r = await extract("x", opts(stubClient(new Error("529 overloaded"))));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("api_error");
      expect(r.error).toContain("529");
    }
  });

  it("keeps the raw response on failure, so a defect can be reproduced", async () => {
    const r = await extract("x", opts(stubClient("not json at all")));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raw).toBe("not json at all");
  });
});

describe("scorer — the distinction the harness exists for", () => {
  const base = { title: "Call the bank", assignee: null, due: null, time: null, priority: null };

  it("calls an invented value a hallucination, not a wrong value", () => {
    const s = scoreCase("t", "must_be_null", [base], [{ ...base, due: "2026-09-02" }]);
    expect(s.passed).toBe(false);
    expect(s.failures[0]!.class).toBe("hallucinated_field");
  });

  it("calls a dropped value a miss, not a hallucination", () => {
    const s = scoreCase("t", "straightforward", [{ ...base, due: "2026-09-02" }], [base]);
    expect(s.failures[0]!.class).toBe("missed_field");
  });

  it("separates a phantom task from a field error", () => {
    const s = scoreCase("t", "no_task", [], [base]);
    expect(s.failures[0]!.class).toBe("phantom_task");
  });

  it("treats an equivalent title as correct", () => {
    const s = scoreCase("t", "straightforward", [base], [{ ...base, title: "Call bank" }]);
    expect(s.passed).toBe(true);
  });

  it("scores a malformed response as a total loss, not a partial one", () => {
    const s = scoreCase("t", "straightforward", [base], null);
    expect(s.fieldAccuracy).toBe(0);
    expect(s.failures[0]!.class).toBe("malformed");
  });
});
