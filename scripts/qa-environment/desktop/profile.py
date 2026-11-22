#!/usr/bin/env python3
"""Writes the Thunderbird profile of the QA environment in /qa (run by start.sh in the desktop image, on the network
of the stack): one mail account per user (IMAP james:143, SMTP james:587; no TLS, a sandbox), the CalDAV calendars
each user has on esn-sabre (found through http://dav), the passwords saved (mozilla.cfg, AutoConfig, at startup),
the extension (/qa/extension.xpi) installed, the first-run screens off.

  profile.py <domain> <password> <uid>...
"""
import base64
import json
import re
import sys
import urllib.request
import uuid
from pathlib import Path
from xml.etree import ElementTree

DAV = "http://dav"
EXTENSION_ID = "thunderbird-labels@yadd.github.io"
QA = Path("/qa")
NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav", "a": "http://apple.com/ns/ical/"}


def propfind(url, body, user, password, depth="0"):
    req = urllib.request.Request(url, data=body.encode(), method="PROPFIND", headers={
        "Depth": depth, "Content-Type": "application/xml",
        "Authorization": "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()})
    with urllib.request.urlopen(req, timeout=20) as r:
        return ElementTree.fromstring(r.read())


def realm():
    try:
        urllib.request.urlopen(urllib.request.Request(DAV + "/", method="PROPFIND"), timeout=20)
    except urllib.error.HTTPError as e:
        m = re.search(r'realm="([^"]*)"', e.headers.get("WWW-Authenticate") or "")
        if m:
            return m.group(1)
    except Exception:  # no CalDAV server: the mail accounts alone
        pass
    return None


def calendars(user, password):
    """[(url, name, color)] of the calendars of the user, through current-user-principal and calendar-home-set."""
    root = propfind(DAV + "/", '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>', user, password)
    principal = root.find(".//d:current-user-principal/d:href", NS).text
    root = propfind(DAV + principal, '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>'
                    '<c:calendar-home-set/></d:prop></d:propfind>', user, password)
    home = root.find(".//c:calendar-home-set/d:href", NS).text
    root = propfind(DAV + home, '<d:propfind xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/"><d:prop><d:resourcetype/>'
                    '<d:displayname/><a:calendar-color/></d:prop></d:propfind>', user, password, depth="1")
    out = []
    for resp in root.findall("d:response", NS):
        if resp.find(".//d:resourcetype/{urn:ietf:params:xml:ns:caldav}calendar", NS) is None:
            continue
        href = resp.find("d:href", NS).text
        name = (resp.findtext(".//d:displayname", "", NS) or "").strip() or "Calendar"
        color = (resp.findtext(".//a:calendar-color", "", NS) or "").strip()[:7] or "#3d8eda"
        out.append((DAV + href, name, color))
    return out


def main():
    domain, password, uids = sys.argv[1], sys.argv[2], sys.argv[3:]
    profile = QA / "profile"
    (profile / "extensions").mkdir(parents=True, exist_ok=True)
    (profile / "extensions" / f"{EXTENSION_ID}.xpi").write_bytes((QA / "extension.xpi").read_bytes())
    prefs = {
        # first run, updates, telemetry, notices: off
        "mail.provider.suppress_dialog_on_startup": True, "mailnews.start_page.enabled": False,
        "mail.shell.checkDefaultClient": False, "app.update.enabled": False, "app.update.auto": False,
        "app.update.disabledForTesting": True, "extensions.update.enabled": False,
        "datareporting.policy.dataSubmissionEnabled": False, "datareporting.healthreport.uploadEnabled": False,
        "toolkit.telemetry.reportingpolicy.firstRun": False, "mail.rights.override": True, "mail.rights.version": 1,
        "mail.inappnotifications.enabled": False, "mail.spam.manualMark": False, "browser.aboutConfig.showWarning": False,
        "mail.biff.show_alert": False, "mail.biff.show_tray_icon": False, "calendar.timezone.local": "Europe/Paris",
        "calendar.timezone.useSystemTimezone": False, "intl.locale.requested": "en-US",
        # the extension: installed from the profile, unsigned, its console on the output (thunderbird_log)
        "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15, "xpinstall.signatures.required": False,
        "devtools.console.stdout.chrome": True, "devtools.console.stdout.content": True,
        "extensions.webextensions.remote": True,
        # accessibility on (AT-SPI): the tree of desktop-mcp
        "accessibility.force_disabled": -1,
    }
    accounts, logins = [], []
    for n, uid in enumerate(uids, 1):
        email = f"{uid}@{domain}"
        prefs.update({
            f"mail.account.account{n}.server": f"server{n}", f"mail.account.account{n}.identities": f"id{n}",
            f"mail.server.server{n}.type": "imap", f"mail.server.server{n}.hostname": "james",
            f"mail.server.server{n}.port": 143, f"mail.server.server{n}.socketType": 0,
            f"mail.server.server{n}.authMethod": 3, f"mail.server.server{n}.userName": email,
            f"mail.server.server{n}.name": email, f"mail.server.server{n}.login_at_startup": True,
            f"mail.server.server{n}.check_new_mail": True, f"mail.server.server{n}.check_time": 1,
            f"mail.identity.id{n}.fullName": uid.capitalize(), f"mail.identity.id{n}.useremail": email,
            f"mail.identity.id{n}.smtpServer": f"smtp{n}", f"mail.identity.id{n}.valid": True,
            f"mail.smtpserver.smtp{n}.hostname": "james", f"mail.smtpserver.smtp{n}.port": 587,
            f"mail.smtpserver.smtp{n}.try_ssl": 0, f"mail.smtpserver.smtp{n}.authMethod": 3,
            f"mail.smtpserver.smtp{n}.username": email, f"mail.smtpserver.smtp{n}.description": email,
        })
        accounts.append(f"account{n}")
        logins += [(f"imap://james", f"imap://james", email), (f"smtp://james", f"smtp://james", email)]
    n = len(uids) + 1
    prefs.update({f"mail.account.account{n}.server": f"server{n}", f"mail.server.server{n}.type": "none",
                  f"mail.server.server{n}.hostname": "Local Folders", f"mail.server.server{n}.userName": "nobody",
                  f"mail.server.server{n}.name": "Local Folders",
                  "mail.accountmanager.accounts": ",".join(accounts + [f"account{n}"]),
                  "mail.accountmanager.defaultaccount": "account1", "mail.accountmanager.localfoldersserver": f"server{n}",
                  "mail.smtpservers": ",".join(f"smtp{i}" for i in range(1, len(uids) + 1)), "mail.smtp.defaultserver": "smtp1"})
    dav_realm = realm()
    found = []
    for uid in uids:
        email = f"{uid}@{domain}"
        try:
            cals = calendars(email, password)
        except Exception as e:  # the mail accounts are enough to start: said, not fatal
            print(f"    CalDAV of {email}: {e}", file=sys.stderr)
            continue
        for url, name, color in cals:
            cid = str(uuid.uuid4())
            prefs.update({f"calendar.registry.{cid}.type": "caldav", f"calendar.registry.{cid}.uri": url,
                          f"calendar.registry.{cid}.name": f"{name} ({uid})", f"calendar.registry.{cid}.color": color,
                          f"calendar.registry.{cid}.username": email, f"calendar.registry.{cid}.cache.enabled": True,
                          f"calendar.registry.{cid}.calendar-main-in-composite": True,
                          f"calendar.registry.{cid}.imip.identity.key": f"id{uids.index(uid) + 1}"})
            found.append(f"{uid}: {name} {url}")
        if dav_realm is not None:
            logins.append(("http://dav", dav_realm, email))
    (profile / "user.js").write_text("".join(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n" for k, v in prefs.items()))
    entries = ",\n".join(f"  [{json.dumps(o)}, {json.dumps(r)}, {json.dumps(u)}]" for o, r, u in logins)
    (QA / "mozilla.cfg").write_text(f"""// AutoConfig of the QA environment (profile.py): the passwords of the accounts, saved once the UI starts
const QA_LOGINS = [
{entries}
];
const QA_PASSWORD = {json.dumps(password)};
Services.obs.addObserver(function saveLogins() {{
  Services.obs.removeObserver(saveLogins, "final-ui-startup");
  const LoginInfo = Components.Constructor("@mozilla.org/login-manager/loginInfo;1", Ci.nsILoginInfo, "init");
  for (const [origin, realm, user] of QA_LOGINS) {{
    // (a login there already, from an earlier start on this profile: refused as a duplicate, kept)
    const login = new LoginInfo(origin, null, realm, user, QA_PASSWORD, "", "");
    (Services.logins.addLoginAsync ? Services.logins.addLoginAsync(login) : Promise.resolve(Services.logins.addLogin(login)))
      .catch(e => /already exists/.test(String(e)) || dump("QA logins: " + e + "\\n"));
  }}
}}, "final-ui-startup");
""")
    print(f"    accounts: {', '.join(f'{u}@{domain}' for u in uids)} (password {password})")
    print("    calendars: " + ("; ".join(found) if found else "none found") + f" (CalDAV realm: {dav_realm})")


if __name__ == "__main__":
    main()
