import { expect, test } from "bun:test";
import { parseState } from "../src/gcs.ts";
import { decodeState } from "../src/firestore.ts";
import { readExecutionState } from "../src/launch-state.ts";

const launch = { id: "00000000-0000-4000-8000-000000000001", createdAt: 1_700_000_000_000 };

test("old state remains readable without inventing launch reservations", () => {
  expect(parseState("{}", "pool").executions).toBeUndefined();
  expect(decodeState({}).executions).toBeUndefined();
});

test("corrupt capacity state is never silently treated as empty", () => {
  for (const executions of [null, [], {}, { launches: [], failures: -1, retryAfter: 0 },
    { launches: [{ ...launch, execution: "https://untrusted.example/secret" }], failures: 0, retryAfter: 0 },
    { launches: [launch, launch], failures: 0, retryAfter: 0 },
    { launches: [{ ...launch, runnerId: "sensitive" }], failures: 0, retryAfter: 0 }]) {
    expect(() => readExecutionState(executions)).toThrow("invalid execution launch state");
    expect(() => parseState(JSON.stringify({ executions }), "pool")).toThrow();
    expect(() => decodeState({ executions: { stringValue: JSON.stringify(executions) } })).toThrow();
  }
});
