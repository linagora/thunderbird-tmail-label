# TMail Labels Sync for Thunderbird

A Thunderbird extension that synchronizes labels from TMail/James server with Thunderbird's native tag system.

## Features

- **Read-only sync**: Labels defined on the TMail server appear as Thunderbird tags
- **Native integration**: Uses Thunderbird's built-in tag UI (columns, context menus, etc.)
- **Auto-sync**: Configurable automatic synchronization on startup and at intervals
- **Multi-account**: Supports multiple IMAP accounts

> **Note**: Labels are read-only via IMAP METADATA. Creating or deleting labels must be done
> directly on the server (e.g. via Twake Mail Admin). This extension only reads and displays them.

## Requirements

- Thunderbird 128 or later
- TMail server 1.0.16 or later

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

TMail/James stores labels as IMAP METADATA entries:

```
/private/vendor/tmail/labels/{labelId}/keyword → UUID (IMAP keyword)
/private/vendor/tmail/labels/{labelId}/displayname → Human-readable name
/private/vendor/tmail/labels/{labelId}/color → (optional) Color hex code
```

This extension:
1. Fetches labels from the server using IMAP `GETMETADATA` (read-only)
2. Creates corresponding Thunderbird tags with matching keywords

Since the IMAP keyword is shared between TMail and Thunderbird, applying a tag to a message automatically applies the label on the server.

Labels can only be created or deleted on the server side (e.g. via Twake Mail Admin or the WebAdmin API).

## Testing with Docker

Start a TMail test server:

```bash
docker run -p 8000:8000 -p 993:993 -d chibenwa/tmail-backend:memory-imap-label

# Get container ID
CONTAINER_ID=$(docker ps -q --filter ancestor=chibenwa/tmail-backend:memory-imap-label)

# Create test user
docker exec -ti $CONTAINER_ID james-cli addUser alice@localhost 123456
```

Provision labels using Twake Mail Admin:

```bash
cd ~/Documents/twake-mail-admin
bun run dev
# Browse http://localhost:3000/users/user/alice%40localhost
# Create INBOX first, then add labels
```

Verify labels via IMAP:

```bash
openssl s_client -connect 127.0.0.1:993
# Then type:
a0 login alice@localhost 123456
A1 GETMETADATA "INBOX" (DEPTH infinity) /private/vendor/tmail/labels
a2 logout
```

Configure Thunderbird:
1. Add account: alice@localhost / 123456
2. IMAP server: 127.0.0.1:993 (SSL)
3. Install the extension
4. Click the extension icon → Sync Labels

## Project Structure

```
thunderbird-labels/
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

### Building

No build step required - the extension runs directly from source.

### Debugging

1. Open Thunderbird → Tools → Developer Tools → Error Console
2. Filter by "TMail Labels" to see extension logs

### Creating XPI

```bash
cd thunderbird-labels
zip -r ../thunderbird-labels.xpi . -x "*.git*" -x "*.DS_Store"
```

## License

MIT

## Contributing

Issues and pull requests welcome at https://github.com/yadd/thunderbird-labels
