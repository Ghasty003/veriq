import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonFingerprint, selectJson, validatePointer } from "../src/json-value.ts";

test("JSON fingerprints normalize object order and preserve array order and value types", () => {
  assert.equal(jsonFingerprint({ b: 2, a: [1, "2"] }), jsonFingerprint({ a: [1, "2"], b: 2 }));
  assert.notEqual(jsonFingerprint([1, 2]), jsonFingerprint([2, 1]));
  assert.notEqual(jsonFingerprint(1), jsonFingerprint("1"));
  assert.throws(() => jsonFingerprint(Infinity));
  assert.throws(() => jsonFingerprint(undefined));
  let nested: unknown = null; for (let i = 0; i < 66; i++) nested = [nested];
  assert.throws(() => jsonFingerprint(nested));
});
test("JSON pointers distinguish missing from null, decode escapes and reject inherited properties", () => {
  assert.deepEqual(selectJson({ "a/b": { "~": [null] } }, "/a~1b/~0/0"), { found: true, value: null });
  assert.equal(selectJson({}, "/constructor").found, false);
  assert.equal(selectJson([1], "/length").found, false);
  assert.equal(selectJson([1], "/00").found, false);
  for (const value of [null, "plain", "/~2", "x".repeat(600)]) assert.throws(() => validatePointer(value));
  assert.equal(validatePointer(""), "");
});
