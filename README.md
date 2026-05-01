# Twake Mail for Thunderbird

A Thunderbird extension that brings Twake Mail features to Thunderbird. The first feature is label synchronization: labels defined on the Twake Mail server appear as native Thunderbird tags.

## Features

- **Label sync (read-only)**: Labels from the Twake Mail server appear as Thunderbird tags
- **Native integration**: Uses Thunderbird's built-in tag UI (columns, context menus, filters, etc.)
- **Auto-sync**: Configurable automatic synchronization on startup and at regular intervals
- **Multi-account**: Supports multiple IMAP accounts simultaneously

> **Note**: Labels are read-only via IMAP METADATA. Creating or deleting labels must be done
> on the server side (e.g. via Twake Mail Admin). This extension only reads and displays them.

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

Twake Mail stores labels as IMAP METADATA entries (RFC 5464):

```
/private/vendor/tmail/labels/{labelId}/keyword → UUID (IMAP keyword)
/private/vendor/tmail/labels/{labelId}/displayname → Human-readable name
/private/vendor/tmail/labels/{labelId}/color → (optional) Color hex code
```

This extension:
1. Fetches labels from the server using IMAP `GETMETADATA` (read-only)
2. Creates corresponding Thunderbird tags with matching names and colors

Since the IMAP keyword is shared between Twake Mail and Thunderbird, applying a tag in Thunderbird automatically applies the corresponding label on the server (and vice versa).

Labels can only be created or deleted on the server side (e.g. via Twake Mail Admin).

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
