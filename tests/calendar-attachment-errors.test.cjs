const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const source = readFileSync(`${__dirname}/../experiment-apis/calendar-attachments/api.js`, "utf8");

function harness(response) {
  let resolve;
  const scheduled = [];
  const alerts = [];
  const nativeErrors = [];
  class RequestBase {
    commit() {
      return new Promise(done => { resolve = done; });
    }
  }
  class CalDavItemRequest extends RequestBase {}
  class CalDavCalendar {
    reportDavError(...args) { nativeErrors.push(args); }
  }
  const scope = vm.createContext({
    ExtensionAPI: class {},
    ChromeUtils: { importESModule: () => ({ CalDavItemRequest, CalDavCalendar }) },
    Ci: { calIErrors: { DAV_PUT_ERROR: 1 } },
    Services: { wm: { getMostRecentWindow: () => ({
      document: {}, closed: false, setTimeout: callback => scheduled.push(callback),
    }) } },
  });
  vm.runInContext(source.slice(source.indexOf("var calendarAttachments")), scope);
  const extension = new scope.calendarAttachments();
  extension.showError = (doc, error) => alerts.push(error.message);
  extension.watchUploadErrors();
  const request = new CalDavItemRequest();
  request.calendar = new CalDavCalendar();
  return { extension, request, scheduled, alerts, nativeErrors, CalDavItemRequest,
    complete: () => resolve(response) };
}

function response(status, marker) {
  return { status, nsirequest: { getResponseHeader(name) {
    assert.equal(name, "X-Twake-Attachment-Error");
    if (marker === undefined) throw new Error("Header not present");
    return marker;
  } } };
}

for (const offlineSupport of [true, false]) {
  test(`shows one simple upload error with Offline Support ${offlineSupport}`, async () => {
    const original = response(503, "upload-failed");
    const h = harness(original);
    try {
      const saving = h.request.commit();
      h.complete();
      const result = await saving;
      assert.equal(result, original);
      if (!offlineSupport) h.request.calendar.reportDavError(1, result.status, "Server Replied with 503");
      h.scheduled.forEach(callback => callback());
      assert.deepEqual(h.alerts, ["Could not upload the attachment. Please try saving the event again."]);
      assert.deepEqual(h.nativeErrors, []);
      // A subsequent, unrelated calendar error still follows Thunderbird's path.
      h.request.calendar.reportDavError(1, 500, "unrelated failure");
      assert.equal(h.nativeErrors.length, 1);
    } finally {
      h.extension.stopWatchingUploadErrors();
    }
  });
}

for (const original of [response(201, "upload-failed"), response(503), response(503, "unknown"), response(400, "upload-failed")]) {
  test(`leaves normal response ${original.status} and unrecognized failures untouched`, async () => {
    const h = harness(original);
    try {
      const saving = h.request.commit();
      h.complete();
      assert.equal(await saving, original);
      h.request.calendar.reportDavError(1, original.status);
      assert.equal(h.nativeErrors.length, 1);
      assert.equal(h.scheduled.length, 0);
      assert.equal(h.alerts.length, 0);
    } finally {
      h.extension.stopWatchingUploadErrors();
    }
  });
}

test("unloading restores inherited commit and ignores an in-flight failure", async () => {
  const original = response(503, "upload-failed");
  const h = harness(original);
  const saving = h.request.commit();
  h.extension.stopWatchingUploadErrors();
  h.complete();
  assert.equal(await saving, original);
  assert.equal(Object.hasOwn(h.CalDavItemRequest.prototype, "commit"), false);
  assert.equal(h.scheduled.length, 0);
  h.request.calendar.reportDavError(1, 503);
  assert.equal(h.nativeErrors.length, 1);
});

test("unloading prevents a queued alert from appearing", async () => {
  const h = harness(response(503, "upload-failed"));
  const saving = h.request.commit();
  h.complete();
  await saving;
  assert.equal(h.scheduled.length, 1);
  h.extension.stopWatchingUploadErrors();
  h.scheduled.forEach(callback => callback());
  assert.equal(h.alerts.length, 0);
});
