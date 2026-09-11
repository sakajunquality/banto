import { describe, expect, test } from "bun:test";
import { selectPool } from "../src/match.ts";
import { pool } from "./helpers.ts";

const DEFAULT = pool({ name: "default", labels: ["self-hosted", "runner-default"] });
const BUILD = pool({ name: "build", labels: ["self-hosted", "runner-build"] });
const ANY = pool({ name: "any", labels: ["self-hosted"] });

describe("label matching", () => {
  test("matches when every selector label is on the job", () => {
    expect(selectPool([DEFAULT, BUILD], ["self-hosted", "runner-default"])?.name).toBe("default");
  });

  test("extra job labels do not prevent a match", () => {
    expect(selectPool([DEFAULT], ["self-hosted", "runner-default", "linux", "x64"])?.name).toBe("default");
  });

  test("a job missing one selector label does not match", () => {
    expect(selectPool([DEFAULT], ["self-hosted"])).toBeNull();
  });

  test("a job matching no pool is ignored", () => {
    expect(selectPool([DEFAULT, BUILD], ["ubuntu-latest"])).toBeNull();
  });

  test("matching is case insensitive, as GitHub's own is", () => {
    expect(selectPool([DEFAULT], ["Self-Hosted", "RUNNER-DEFAULT"])?.name).toBe("default");
  });

  test("when several pools match, the most specific selector wins", () => {
    // `any` matches every self-hosted job; `build` is the deliberate statement.
    expect(selectPool([ANY, BUILD], ["self-hosted", "runner-build"])?.name).toBe("build");
    expect(selectPool([BUILD, ANY], ["self-hosted", "runner-build"])?.name).toBe("build");
  });

  test("the broad pool still wins when the narrow one does not match", () => {
    expect(selectPool([ANY, BUILD], ["self-hosted", "runner-default"])?.name).toBe("any");
  });

  test("equally specific matches are broken by configuration order", () => {
    const a = pool({ name: "a", labels: ["self-hosted", "linux"] });
    const b = pool({ name: "b", labels: ["self-hosted", "x64"] });
    expect(selectPool([a, b], ["self-hosted", "linux", "x64"])?.name).toBe("a");
    expect(selectPool([b, a], ["self-hosted", "linux", "x64"])?.name).toBe("b");
  });

  test("an empty pool list matches nothing", () => {
    expect(selectPool([], ["self-hosted"])).toBeNull();
  });
});
