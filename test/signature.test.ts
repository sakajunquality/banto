import { describe, expect, test } from "bun:test";
import { signBody, verifySignature } from "../src/signature.ts";

const SECRET = "s3cret";
const BODY = JSON.stringify({ action: "queued", workflow_job: { id: 1, labels: ["self-hosted"] } });

describe("webhook signature verification", () => {
  test("accepts a signature made with the configured secret", () => {
    expect(verifySignature(SECRET, BODY, signBody(SECRET, BODY))).toBe(true);
  });

  test("accepts a raw byte body", () => {
    const bytes = new TextEncoder().encode(BODY);
    expect(verifySignature(SECRET, bytes, signBody(SECRET, bytes))).toBe(true);
  });

  test("rejects a signature made with a different secret", () => {
    expect(verifySignature(SECRET, BODY, signBody("other-secret", BODY))).toBe(false);
  });

  test("rejects a missing header", () => {
    expect(verifySignature(SECRET, BODY, undefined)).toBe(false);
    expect(verifySignature(SECRET, BODY, null)).toBe(false);
    expect(verifySignature(SECRET, BODY, "")).toBe(false);
  });

  test("rejects a body that was tampered with after signing", () => {
    const signature = signBody(SECRET, BODY);
    const tampered = BODY.replace('"id":1', '"id":2');
    expect(tampered).not.toBe(BODY);
    expect(verifySignature(SECRET, tampered, signature)).toBe(false);
  });

  test("rejects a digest without the sha256= prefix", () => {
    const signature = signBody(SECRET, BODY);
    expect(verifySignature(SECRET, BODY, signature.slice("sha256=".length))).toBe(false);
  });

  test("rejects a truncated signature of the right prefix", () => {
    const signature = signBody(SECRET, BODY);
    expect(verifySignature(SECRET, BODY, signature.slice(0, signature.length - 2))).toBe(false);
  });

  test("rejects a signature differing in one hex character", () => {
    const signature = signBody(SECRET, BODY);
    const last = signature.at(-1);
    const flipped = `${signature.slice(0, -1)}${last === "a" ? "b" : "a"}`;
    expect(verifySignature(SECRET, BODY, flipped)).toBe(false);
  });
});
