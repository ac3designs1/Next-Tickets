# Ticket Bot

A Discord ticket bot that works across **two separate Discord servers**:

| Server | Purpose |
|--------|---------|
| **Main Server** | Public-facing — users open tickets here via a button or `/ticket` |
| **Staff Server** | Private — each ticket gets its own channel here, staff work tickets here |

---

## How it works

```
User clicks "Open a Ticket" (Main Server)
        │
        ▼
Bot creates a private channel in the Staff Server  ←── only staff can see it
        │
        ▼
User receives a DM confirmation from the bot
        │
User DMsthe bot  ──────────────────────────────▶  Message appears in ticket channel (Staff Server)
                                                          │
Staff types a normal message  ──────────────────▶  Internal note (user never sees it)
Staff types  % Hello!          ──────────────────▶  Bot DMs the user "Hello!"
```

---

## Setup

### 1. Create the bot

1. Go to https://discord.com/developers/applications and create a new Application
2. Go to **Bot** → enable **Message Content Intent**, **Server Members Intent**, **Presence Intent**
3. Copy the **Bot Token**
4. Go to **OAuth2** → copy the **Client ID**

### 2. Invite the bot to BOTH servers

Use this URL (replace `CLIENT_ID` with yours):

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=8&scope=bot+applications.commands
```

The bot needs **Administrator** permission in the **Staff Server** so it can create channels and manage permissions.
In the **Main Server** it only needs basic permissions (Send Messages, Embed Links, Use Slash Commands).

### 3. Configure environment variables

Copy `.env.example` to `.env` and fill in every value:

```
cp .env.example .env
```

```env
BOT_TOKEN=           # Bot token from Discord Developer Portal
CLIENT_ID=           # Application ID from Discord Developer Portal
MAIN_GUILD_ID=       # ID of your public/main Discord server
STAFF_GUILD_ID=      # ID of your separate staff-only Discord server
DEFAULT_STAFF_ROLE_ID=  # Role ID in the STAFF server that sees all unassigned tickets
TICKET_CATEGORY_NAME=Tickets   # Name of the category to group ticket channels under
PANEL_CHANNEL_ID=    # Optional — auto-post ticket panel in this main-server channel
DATA_DIR=./data      # Persistent volume for tickets / bans / apps / quick replies
STALE_TICKET_DAYS=7  # Auto-close inactive open tickets after N days
```

> To get an ID: enable **Developer Mode** in Discord settings, then right-click any server/role and click **Copy ID**.

### 4. Configure departments

Edit `departments.json` — replace every `REPLACE_WITH_ROLE_ID` with the actual role ID from your **Staff Server**:

```json
[
  {
    "id": "gang",
    "name": "Gang Staff",
    "emoji": "🔫",
    "roleId": "123456789012345678",
    "color": 15158332
  },
  ...
]
```

Add or remove departments as needed. The `color` is a decimal color code (use https://www.bgreco.net/hexcolor/ to convert hex).

### 5. Install dependencies

```bash
npm install
```

### 6. Deploy slash commands

```bash
npm run deploy
```

### 7. Start the bot

```bash
npm start
```

---

## Staff Server — Recommended Setup

1. Create a **Staff Server** (or use an existing private one)
2. Create roles for each department (Gang Staff, Higher Up, Admin, etc.)
3. Fill in those role IDs in `departments.json`
4. Create a `DEFAULT_STAFF_ROLE` and give it to all staff — this role sees unassigned tickets
5. Invite the bot with Administrator permission

The bot will automatically:
- Create a `Tickets` category (or whatever you set in `TICKET_CATEGORY_NAME`)
- Create one channel per ticket inside that category
- Lock down channel visibility based on department when transferred

---

## Commands

| Command | Where | Who |
|---------|-------|-----|
| `/setup` | Main Server | Staff — posts the "Open a Ticket" button panel |
| `/ticket <subject>` | Main Server | Anyone — opens a ticket directly |
| `/transfer` | Staff Server (ticket channel) | Staff — transfers ticket to a department |
| `/claim` / `/unclaim` | Staff Server (ticket channel) | Staff — take or release ownership |
| `/close` | Staff Server (ticket channel) | Staff — closes the ticket (saves transcript) |
| `/reopen` | Staff Server (ticket channel) | Staff — reopens a closed ticket |
| `/tickets` | Staff Server | Staff — lists all open tickets |
| `/stats` | Either | Staff — open/closed/claim/ban metrics |
| `/ticketban ban` | Either | Admin / Management — ban a user from opening tickets |
| `/ticketban unban` | Either | Admin / Management — lift a ticket ban |
| `/ticketban list` | Either | Admin / Management — list ticket bans |

## Staff messaging

Inside any ticket channel in the **Staff Server**:

| Message | What happens |
|---------|-------------|
| `Hello, just checking in` | Internal staff note — reformatted in-channel, user is NOT notified |
| `%Hello, just checking in` | Bot DMs the user "Hello, just checking in" — user SEES it |

Attachments work with both methods. If DMs are closed, `%` replies go to a private **Ticket Relay** channel on the main server instead.

---

## Department transfers

Run `/transfer` inside any ticket channel. A dropdown appears with all departments from `departments.json`.
When you select one:

- The channel's permissions are updated so **that department's role** can see it
- **Admin Team** and **Management Team** always keep access
- Any active claim is cleared so the destination team can `/claim`
- A log message is posted (and the department role is pinged)
- The topic is updated to reflect the department

---

## File structure

```
ticket-bot/
├── index.js            # Main bot logic
├── deploy-commands.js  # Run once to register slash commands
├── database.js         # JSON-based ticket storage
├── ticket-bans-db.js   # Users banned from opening tickets
├── transcript.js       # Close-time ticket transcripts
├── departments.json    # Department config (names, role IDs, colours)
├── .env                # Your secrets (never commit this!)
├── .env.example        # Template for .env
├── package.json
└── data/
    ├── tickets.json        # Auto-created — stores all ticket records
    ├── ticket-bans.json    # Auto-created — ticket ban list
    ├── applications.json   # Staff applications
    ├── quick-replies.json  # Canned replies (survives restarts)
    └── transcripts/        # Saved close transcripts
```
