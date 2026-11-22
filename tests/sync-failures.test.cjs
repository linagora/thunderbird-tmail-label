const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const load = file => readFileSync(`${__dirname}/../src/${file}`, "utf8");

// Loads the sync services against a fake browser: alice can be read, bob cannot.
function services() {
  const deletedTags = [];
  const deletedIdentities = [];
  const synced = [];
  const browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    imapMetadata: {
      getImapAccounts: async () => [
        { id: "account1", name: "alice@example.com" },
        { id: "account2", name: "bob@example.com" },
        { id: "account3", name: "carol@gmail.example" },
      ],
      getLabels: async id => {
        synced.push(id);
        return id === "account2" ? { success: false, error: "connection refused" }
          : id === "account3" ? { success: false, unsupported: true, error: "no METADATA" } : { success: true, labels: [] };
      },
      getIdentities: async id =>
        id === "account2" ? { success: false, error: "connection refused" }
          : id === "account3" ? { success: false, unsupported: true, error: "no METADATA" } : { success: true, identities: [] },
    },
    messages: { tags: { list: async () => [], delete: async key => deletedTags.push(key) } },
    identities: { list: async () => [], delete: async id => deletedIdentities.push(id) },
  };
  const scope = vm.createContext({ browser, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(`${load("core/constants.js")}
${load("core/label-sync.js")}
${load("core/identity-sync.js")}
this.LabelSyncService = LabelSyncService;
this.IdentitySyncService = IdentitySyncService;
this.TWAKE_MAIL = TWAKE_MAIL;`, scope);
  const labels = scope.LabelSyncService;
  labels._labelMap.set("account2", new Map([["label1", { tbTagKey: "kw1", tmailLabel: {} }]]));
  const identities = scope.IdentitySyncService;
  identities._identityMap.set("account2", new Map([["id1", { tbIdentityId: "id42", serverIdentity: {} }]]));
  return { labels, identities, scope, deletedTags, deletedIdentities, synced };
}

test("a failed label read keeps the account's tags and reports the failure", async () => {
  const { labels, scope, deletedTags, synced } = services();
  await assert.rejects(labels.syncAll(), /bob@example\.com: connection refused/);
  assert.deepEqual(deletedTags, []);
  assert.deepEqual(synced, ["account1", "account2", "account3"]);
  assert.equal(labels.getStatus().status, scope.TWAKE_MAIL.SYNC_STATUS.ERROR);
  assert.equal(labels.getStatus().lastSyncTime, null);
});

test("a failed identity read keeps the account's identities and reports the failure", async () => {
  const { identities, deletedIdentities } = services();
  await assert.rejects(identities.syncAll(), /bob@example\.com: connection refused/);
  assert.deepEqual(deletedIdentities, []);
  assert.equal(identities._identityMap.get("account2").size, 1);
});

test("accounts that cannot hold Twake Mail metadata are skipped, not failed", async () => {
  const { labels, identities, deletedTags } = services();
  labels._labelMap.set("account3", new Map([["label9", { tbTagKey: "kw9", tmailLabel: {} }]]));
  await labels.syncAccount("account3");
  await identities.syncAccount("account3");
  assert.deepEqual(deletedTags, []);
  await assert.rejects(labels.syncAll(), error => !error.message.includes("carol"));
});
