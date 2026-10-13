import { test, expect, afterEach } from "bun:test";
import net from "node:net";
import { describeNetworkError, tuneConnectionRacing } from "../src/util/net.ts";

const ORIGINAL = process.env.AUTOROUTER_CONNECT_ATTEMPT_TIMEOUT_MS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AUTOROUTER_CONNECT_ATTEMPT_TIMEOUT_MS;
  else process.env.AUTOROUTER_CONNECT_ATTEMPT_TIMEOUT_MS = ORIGINAL;
});

/** The Happy Eyeballs shape Node produces: "fetch failed" over an AggregateError. */
function fetchFailed(attempts: Array<{ code: string; address: string }>): Error {
  const inner: any = new AggregateError(
    attempts.map((a) => Object.assign(new Error(a.code), a)),
    "",
  );
  const outer: any = new TypeError("fetch failed");
  outer.cause = inner;
  return outer;
}

test("raises Node's 250ms per-address connect timeout", () => {
  const set = net.setDefaultAutoSelectFamilyAttemptTimeout;
  if (typeof set !== "function") return; // Bun: knob does not exist.
  set(250);
  tuneConnectionRacing();
  expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBeGreaterThan(250);
});

test("an explicit override wins over the default", () => {
  const set = net.setDefaultAutoSelectFamilyAttemptTimeout;
  if (typeof set !== "function") return;
  process.env.AUTOROUTER_CONNECT_ATTEMPT_TIMEOUT_MS = "1234";
  tuneConnectionRacing();
  expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(1234);
});

test("a timeout race names the addresses and the knob that widens it", () => {
  const described = describeNetworkError(
    fetchFailed([
      { code: "ETIMEDOUT", address: "3.233.158.110" },
      { code: "EHOSTUNREACH", address: "2600:1f18:24e6:b900::1" },
    ]),
  );
  expect(described).toContain("3.233.158.110");
  expect(described).toContain("AUTOROUTER_CONNECT_ATTEMPT_TIMEOUT_MS");
  expect(described).not.toBe("fetch failed");
});

test("distinguishes the failures that all surface as 'fetch failed'", () => {
  expect(describeNetworkError(fetchFailed([{ code: "ENOTFOUND", address: "nope.example" }])))
    .toContain("does not resolve");
  expect(describeNetworkError(fetchFailed([{ code: "ECONNREFUSED", address: "127.0.0.1" }])))
    .toContain("refused");
  expect(describeNetworkError(fetchFailed([{ code: "EHOSTUNREACH", address: "2600::1" }])))
    .toContain("no route to host");
});

test("leaves a protocol error alone", () => {
  expect(describeNetworkError(new Error("HTTP 403 insufficient_scope"))).toBeNull();
  expect(describeNetworkError(new Error("tool not found"))).toBeNull();
});

/** "fetch failed" with nothing under it is not improvable; don't pretend otherwise. */
test("returns null when no errno survived", () => {
  expect(describeNetworkError(new TypeError("fetch failed"))).toBeNull();
});
