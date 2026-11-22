#!/usr/bin/env python3
"""Seeds the accounts of the QA environment through JMAP (tmail-backend): what the extension reads over IMAP METADATA
(labels, custom identities with HTML signatures) and mails in the inbox, some carrying the keyword of a label.
Idempotent: what exists (same display name, same identity email, same subject) is not created again.

  seed.py --jmap http://127.0.0.1:18400 --domain open-paas.org --password secret alice bob carol
"""
import argparse
import base64
import json
import urllib.request

USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission",
         "com:linagora:params:jmap:labels"]
LABELS = [("Customer", "#e53935"), ("Invoices", "#43a047"), ("Project Phoenix", "#1e88e5"), ("Équipe RH", "#8e24aa"),
          ("Very long label name to check how Thunderbird shows it in the tag menus", None)]


def call(url, auth, calls):
    req = urllib.request.Request(url + "/jmap", method="POST", data=json.dumps({"using": USING, "methodCalls": calls}).encode(),
                                 headers={"Authorization": auth, "Content-Type": "application/json",
                                          "Accept": "application/json;jmapVersion=rfc-8621"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)["methodResponses"]
    for name, body, _ in out:
        if name == "error" or body.get("notCreated"):
            raise SystemExit(f"JMAP {name}: {json.dumps(body)[:600]}")
    return out


def seed(url, email, password, peers):
    auth = "Basic " + base64.b64encode(f"{email}:{password}".encode()).decode()
    req = urllib.request.Request(url + "/jmap/session", headers={"Authorization": auth, "Accept": "application/json;jmapVersion=rfc-8621"})
    with urllib.request.urlopen(req, timeout=30) as r:
        account = json.load(r)["primaryAccounts"]["urn:ietf:params:jmap:mail"]
    a = {"accountId": account}
    (_, labels, _), (_, idents, _), (_, boxes, _) = call(url, auth, [
        ["Label/get", {**a, "ids": None}, "l"], ["Identity/get", {**a, "ids": None}, "i"],
        ["Mailbox/get", {**a, "ids": None, "properties": ["name", "role"]}, "m"]])
    have = {l["displayName"] for l in labels["list"]}
    create = {f"l{n}": {"displayName": name, **({"color": color} if color else {})}
              for n, (name, color) in enumerate(LABELS) if name not in have}
    if create:
        call(url, auth, [["Label/set", {**a, "create": create}, "c"]])
    labels = call(url, auth, [["Label/get", {**a, "ids": None}, "l"]])[0][1]["list"]
    keyword = {l["displayName"]: l["keyword"] for l in labels}
    uid = email.split("@")[0]
    work = f"{uid}+work@{email.split('@')[1]}"
    if not any(i["email"] == email and i.get("mayDelete") for i in idents["list"]):
        call(url, auth, [["Identity/set", {**a, "create": {"i": {
            "name": f"{uid.capitalize()} (Linagora)", "email": email, "replyTo": [{"email": work}],
            "bcc": [{"email": email}], "textSignature": f"--\n{uid.capitalize()}\nLinagora, Paris",
            "htmlSignature": f'<p>--<br><b>{uid.capitalize()}</b><br><span style="color:#1e88e5">Linagora</span>, Paris</p>'}}}, "i"]])
    inbox = next(b["id"] for b in boxes["list"] if b.get("role") == "inbox")
    subjects = [("Contract renewal for 2027", ["Customer", "Invoices"]), ("Invoice #4512 overdue", ["Invoices"]),
                ("Phoenix: sprint 14 review", ["Project Phoenix"]), ("Entretiens annuels", ["Équipe RH"]),
                ("Lunch on Friday?", []), ("Tagged with the long label", ["Very long label name to check how Thunderbird shows it in the tag menus"])]
    (_, found, _), = call(url, auth, [["Email/query", {**a, "filter": {"inMailbox": inbox}, "limit": 200}, "q"]])
    (_, got, _), = call(url, auth, [["Email/get", {**a, "ids": found["ids"], "properties": ["subject"]}, "g"]])
    existing = {e["subject"] for e in got["list"]}
    create = {}
    for n, (subject, tags) in enumerate(subjects):
        if subject in existing:
            continue
        peer = peers[n % len(peers)]
        create[f"e{n}"] = {"mailboxIds": {inbox: True}, "keywords": {keyword[t]: True for t in tags},
                           "from": [{"name": peer.split("@")[0].capitalize(), "email": peer}], "to": [{"email": email}],
                           "subject": subject, "receivedAt": f"2026-11-{10 + n:02d}T09:00:00Z",
                           "bodyValues": {"b": {"value": f"Hello {uid},\n\n{subject}.\n\nRegards"}},
                           "textBody": [{"partId": "b", "type": "text/plain"}]}
    if create:
        call(url, auth, [["Email/set", {**a, "create": create}, "e"]])
    print(f"    {email}: {len(labels)} labels, {len(create)} mails added")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--jmap", required=True)
    p.add_argument("--domain", required=True)
    p.add_argument("--password", required=True)
    p.add_argument("uids", nargs="+")
    args = p.parse_args()
    emails = [f"{u}@{args.domain}" for u in args.uids]
    for email in emails:
        seed(args.jmap.rstrip("/"), email, args.password, [e for e in emails if e != email] or [email])


if __name__ == "__main__":
    main()
