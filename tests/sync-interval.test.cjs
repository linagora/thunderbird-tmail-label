const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const scope = vm.createContext({});
vm.runInContext(`${readFileSync(`${__dirname}/../src/core/constants.js`, "utf8")}
this.TWAKE_MAIL = TWAKE_MAIL;`, scope);
const { normalizeSyncInterval } = scope.TWAKE_MAIL;

test("clamps the sync interval to 0-60 whole minutes", () => {
  assert.equal(normalizeSyncInterval("100"), 60);
  assert.equal(normalizeSyncInterval("-5"), 0);
  assert.equal(normalizeSyncInterval("2.5"), 3);
  assert.equal(normalizeSyncInterval("2.4"), 2);
  assert.equal(normalizeSyncInterval("15"), 15);
  assert.equal(normalizeSyncInterval(30), 30);
});

test("turns periodic sync off for values that are not numbers", () => {
  for (const value of ["", "abc", undefined, null, NaN, Infinity]) {
    assert.equal(normalizeSyncInterval(value), 0, String(value));
  }
});
