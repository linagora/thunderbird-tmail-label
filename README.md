# Twake Mail for Thunderbird

A Thunderbird extension that brings Twake Mail features to Thunderbird. The first feature is label synchronization: labels defined on the Twake Mail server appear as native Thunderbird tags.

## Features

- **Label sync (read-only)**: Labels from the Twake Mail server appear as Thunderbird tags
- **Identity sync (read-only)**: Custom identities (display name, email, HTML signature, reply-to, BCC) are pulled from the server and applied to Thunderbird identities
- **Native integration**: Uses Thunderbird's built-in tag and identity UIs
- **Auto-sync**: Configurable automatic synchronization on startup and at regular intervals
- **Multi-account**: Supports multiple IMAP accounts simultaneously

> **Note**: Labels and identities are read-only via IMAP METADATA. Creating or deleting them
> must be done on the server side (e.g. via Twake Mail Admin). This extension only reads and
> applies them to Thunderbird.

## Requirements

- Thunderbird 128 or later
- Twake Mail server with IMAP METADATA support (RFC 5464)

## Installation

### From Source (Development)

1. Clone this repository
2. Open Thunderbird
3. Go to **Add-ons and Themes** (Ctrl+Shift+A)
4. Click the gear icon → **Debug Add-ons**
5. Click **Load Temporary Add-on**
6. Select the `manifest.json` file from this directory

### From XPI (Release)

1. Download the `.xpi` file from releases
2. Open Thunderbird → Add-ons and Themes
3. Click the gear icon → **Install Add-on From File**
4. Select the downloaded `.xpi` file

## How It Works

Both features use IMAP METADATA (RFC 5464) with a `GETMETADATA "INBOX" (DEPTH infinity)` command.

### Labels

```
/private/vendor/tmail/labels/{labelId}/keyword → UUID (IMAP keyword)
/private/vendor/tmail/labels/{labelId}/displayname → Human-readable name
/private/vendor/tmail/labels/{labelId}/color → (optional) Color hex code
```

The extension creates Thunderbird tags whose key matches the Twake Mail keyword UUID. Since the IMAP keyword is shared between the two clients, tagging a message in either app is reflected in the other.

### Identities

```
/private/vendor/tmail/identities/{hash}/id → Identity UUID
/private/vendor/tmail/identities/{hash}/displayname → Display name
/private/vendor/tmail/identities/{hash}/email → Email address
/private/vendor/tmail/identities/{hash}/html → HTML signature
/private/vendor/tmail/identities/{hash}/text → Plain-text signature
/private/vendor/tmail/identities/{hash}/replyto → (optional) Reply-to address
/private/vendor/tmail/identities/{hash}/bcc → (optional) BCC address
```

Only custom identities (`maydelete: true`) are synced. The extension matches server identities to Thunderbird identities by UUID (stored mapping) or email (first-sync fallback), then updates name, signature, reply-to, and BCC.

Labels and identities can only be created or deleted on the server side (e.g. via Twake Mail Admin).

## Testing with Docker

Start a Twake Mail test server:

```bash
docker run -p 8000:8000 -p 993:993 -d chibenwa/tmail-backend:memory-imap-label

# Get container ID
CONTAINER_ID=$(docker ps -q --filter ancestor=chibenwa/tmail-backend:memory-imap-label)

# Create test user
docker exec -ti $CONTAINER_ID james-cli addUser alice@localhost 123456
```

Provision labels using Twake Mail Admin, then verify via IMAP:

```bash
openssl s_client -connect 127.0.0.1:993
# Then type:
a0 login alice@localhost 123456
A1 GETMETADATA "INBOX" (DEPTH infinity) /private/vendor/tmail/labels
a2 logout
```

Configure Thunderbird:
1. Add account: alice@localhost / 123456, IMAP server: 127.0.0.1:993 (SSL)
2. Install the extension
3. Click the extension icon → Sync Labels

## Project Structure

```
thunderbird-tmail-label/
├── manifest.json                           # Extension manifest
├── experiment-apis/
│   └── imap-metadata/
│       ├── api.js                          # IMAP METADATA privileged API
│       └── schema.json                     # API schema
├── src/
│   ├── background.js                       # Background service worker
│   ├── core/
│   │   ├── constants.js                    # Configuration constants
│   │   └── label-sync.js                   # Label synchronization service
│   └── ui/
│       ├── popup.html                      # Popup UI
│       ├── popup.css                       # Popup styles
│       └── popup.js                        # Popup logic
├── icons/                                  # Extension icons
└── _locales/
    ├── en/messages.json                    # English translations
    └── fr/messages.json                    # French translations
```

## Development

### Debugging

1. Open Thunderbird → Tools → Developer Tools → Error Console
2. Filter by "Twake Mail" to see extension logs

### Creating XPI

```bash
zip -r ../twake-mail-thunderbird.xpi . -x "*.git*" -x "*.DS_Store"
```

## License

AGPL v3

## Contributing

Issues and pull requests welcome.
