const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const scope = vm.createContext({ btoa, atob, Uint8Array });
const source = readFileSync(`${__dirname}/../experiment-apis/calendar-attachments/api.js`, "utf8");
vm.runInContext(source.slice(source.indexOf("var CalendarAttachmentData"), source.indexOf("var calendarAttachments")), scope);
const data = scope.CalendarAttachmentData;
scope.ExtensionAPI = class {};
vm.runInContext(source.slice(source.indexOf("var calendarAttachments")), scope);
const ui = new scope.calendarAttachments();
ui.data = data;
function attachment(rawData, parameters = {}) {
  return {
    rawData,
    encoding: parameters.ENCODING || "BASE64",
    getParameter: key => ({ VALUE: "BINARY", ...parameters })[key],
  };
}

function webAttachment(uri, parameters = {}) {
  return {
    uri: { spec: uri, scheme: uri.split(":", 1)[0] },
    getParameter: key => parameters[key],
  };
}

test("recognizes Drive sharing links alongside inline attachments", () => {
  const inline = attachment("AA==");
  const drive = webAttachment("https://drive.example.com/sharing/report", {
    "X-FILENAME": "report.pdf", FMTTYPE: "application/pdf",
  });
  assert.equal(data.isBinary(inline), true);
  assert.equal(data.isWebLink(inline), false);
  assert.equal(data.isBinary(drive), false);
  assert.equal(data.isWebLink(drive), true);
  assert.equal(data.displayName(drive), "report.pdf");
  assert.equal(data.isWebLink(webAttachment("http://localhost/agenda.txt")), true);
  assert.equal(data.isWebLink(webAttachment("HTTPS://drive.example.com/file")), true);
});

test("uses URI filename metadata with a URL fallback without changing attachment data", () => {
  const drive = webAttachment("https://drive.example.com/sharing/report?token=demo", {
    "X-FILENAME": " report.pdf ", FILENAME: "other.pdf",
  });
  const before = JSON.stringify(drive);
  assert.equal(data.displayName(drive), "report.pdf");
  assert.equal(JSON.stringify(drive), before);
  assert.equal(data.displayName(webAttachment("https://example.com/file", {
    "X-FILENAME": "  ", FILENAME: "fallback.txt",
  })), "fallback.txt");
  assert.equal(data.displayName(webAttachment("https://example.com/file")), "https://example.com/file");
  assert.equal(data.displayName(attachment("AA==", { FILENAME: "local.bin" })), "local.bin");
});

test("does not treat unsupported schemes or binary content as web links", () => {
  for (const uri of ["javascript:alert(1)", "data:text/plain,hello", "file:///tmp/a.txt", "cid:file", "about:blank", "ftp://example.com/file"]) {
    assert.equal(data.isWebLink(webAttachment(uri)), false, uri);
  }
  const binaryWithUri = { ...attachment("AA=="), uri: { scheme: "https", spec: "https://example.com" } };
  assert.equal(data.isWebLink(binaryWithUri), false);
  assert.equal(data.isWebLink({ getParameter: () => null }), false);
});

test("keeps a Drive sharing query and fragment intact when presenting its filename", () => {
  const uri = "https://drive.example.com/public?sharecode=DEMO#/";
  const drive = webAttachment(uri, {
    "X-FILENAME": "Twake-Sync-Setup-Guide-EN.docx",
    FMTTYPE: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  assert.equal(data.isWebLink(drive), true);
  assert.equal(data.displayName(drive), "Twake-Sync-Setup-Guide-EN.docx");
  assert.equal(drive.uri.spec, uri);
  assert.equal(drive.getParameter("FMTTYPE"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("hides only managed editor attachments and restores native visibility", () => {
  const managed = { attachment: { hashId: "web" }, hidden: false };
  const unsupported = { attachment: { hashId: "file" }, hidden: false };
  const list = { children: [managed, unsupported], hidden: false };
  const state = { editor: true, doc: { getElementById: () => list }, hiddenNative: new Map() };
  ui.syncNative(state, [{ hashId: "web" }]);
  assert.equal(managed.hidden, true);
  assert.equal(unsupported.hidden, false);
  assert.equal(list.hidden, false);
  ui.restoreNative(state);
  assert.equal(managed.hidden, false);
  list.children = [managed];
  ui.syncNative(state, [{ hashId: "web" }]);
  assert.equal(list.hidden, true);
  ui.syncNative(state, []);
  assert.equal(managed.hidden, false);
  assert.equal(list.hidden, false);
});

test("restores summary URI rows without revealing its hidden template", () => {
  const uri = "https://drive.example.com/public?sharecode=DEMO#/";
  const item = { hidden: false, querySelector: () => ({ getAttribute: () => uri }) };
  const template = { hidden: true };
  const row = { hidden: false };
  const summary = { querySelectorAll: () => [template, item], querySelector: () => row };
  const state = { editor: false, doc: { getElementById: () => summary }, hiddenNative: new Map() };
  ui.syncNative(state, [webAttachment(uri)]);
  assert.equal(item.hidden, true);
  assert.equal(row.hidden, true);
  ui.restoreNative(state);
  assert.equal(item.hidden, false);
  assert.equal(row.hidden, false);
  assert.equal(template.hidden, true);
});

test("round-trips all byte values including NUL and non-text bytes", () => {
  const bytes = Uint8Array.from({ length: 1024 }, (_, i) => i % 256);
  assert.deepEqual(data.decode(attachment(data.encode(bytes))), bytes);
});

test("decodes folded iCalendar BASE64 without modifying the attachment", () => {
  const original = attachment("AAEC\r\n /v8=", { FILENAME: "picture.png" });
  const before = JSON.stringify(original);
  assert.deepEqual(Array.from(data.decode(original)), [0, 1, 2, 254, 255]);
  assert.equal(JSON.stringify(original), before);
});

test("validates BASE64 rather than silently truncating malformed data", () => {
  for (const input of ["ab", "abc", "A===", "AA==junk", "AA$=", "===="]) {
    assert.throws(() => data.decode(attachment(input)), /invalid BASE64/);
  }
  assert.throws(() => data.decode(attachment("AA==", { ENCODING: "QUOTED-PRINTABLE" })), /does not use BASE64/);
});

test("uses a safe filename for untrusted event attachment parameters", () => {
  assert.equal(data.fileName(attachment("AA==", { FILENAME: "../../secret\u0000.txt" })), "_.._secret_.txt");
  assert.equal(data.fileName(attachment("AA==", { "X-FILENAME": "agenda.pdf" })), "agenda.pdf");
  assert.equal(data.safeName("..."), "attachment.bin");
});

test("enforces the file size boundary for both adding and downloading", () => {
  const bytes = new Uint8Array(data.MAX_FILE_BYTES);
  for (let offset = 0; offset < bytes.length; offset += 65536) {
    webcrypto.getRandomValues(bytes.subarray(offset, offset + 65536));
  }
  assert.deepEqual(data.decode(attachment(data.encode(bytes))), bytes);
  assert.throws(() => data.encode(new Uint8Array(data.MAX_FILE_BYTES + 1)), /no larger than/);
  assert.throws(() => data.decode(attachment("A".repeat(Math.ceil((data.MAX_FILE_BYTES + 3) / 3) * 4))), /too large/);
  assert.throws(() => data.encode(new Uint8Array()), /non-empty/);
});
