const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync(`${__dirname}/../experiment-apis/imap-metadata/api.js`, "utf8");
const scope = vm.createContext({ console: { log() {}, warn() {}, error() {} } });
scope.ExtensionAPI = class {};
vm.runInContext(source.slice(source.indexOf("var imapMetadata")), scope);
const api = new scope.imapMetadata();

test("reads the host from hostname (Thunderbird 153+) and from hostName (older versions)", () => {
  assert.equal(api.hostOf({ hostname: "imap.example.com" }), "imap.example.com");
  assert.equal(api.hostOf({ hostName: "imap.example.org" }), "imap.example.org");
  assert.equal(api.hostOf({}), undefined);
});

test("refuses to connect when the account has no host name", async () => {
  await assert.rejects(
    api.fetchMetadataViaRawImap({ key: "server1" }, null, "/private/vendor/tmail/labels", () => []),
    /No IMAP host name for account server1/
  );
});

test("finds the password with searchLoginsAsync, or findLogins on older versions", async () => {
  const server = { hostname: "imap.example.com", port: 143, username: "alice" };
  const login = { username: "alice", password: "secret" };
  for (const loginManager of [
    { searchLoginsAsync: async ({ origin, httpRealm }) => origin === "imap://imap.example.com" && httpRealm === origin ? [login] : [] },
    { findLogins: async (origin, action, realm) => origin === "imap://imap.example.com" && realm === origin ? [login] : [] },
  ]) {
    scope.Cc = { "@mozilla.org/login-manager;1": { getService: () => loginManager } };
    scope.Ci = { nsILoginManager: {} };
    assert.equal(await api._getImapPassword(server), "secret");
  }
});
