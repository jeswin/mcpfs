[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/jeswin-mcpfs-badge.png)](https://mseep.ai/app/jeswin-mcpfs)

# Filesystem MCP Server (HTTP Streaming)

An HTTP streaming port of the official [MCP Filesystem Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) by Anthropic.

## About This Port

This is a port of [@modelcontextprotocol/server-filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) that replaces the **stdio** transport with **HTTP Streaming** (Streamable HTTP transport).

### Why HTTP Streaming?

The original MCP filesystem server uses stdio transport, which works well for local CLI integrations but has limitations:

- Requires spawning a subprocess for each connection
- Not suitable for remote/networked deployments
- Can't be accessed by web-based MCP clients

This port uses HTTP Streaming, enabling:

- **Remote access** - Connect over HTTP from anywhere
- **Multiple concurrent sessions** - Handle many clients simultaneously
- **Web client compatibility** - Works with browser-based MCP clients
- **Standalone deployment** - Run as a service without subprocess management

All filesystem functionality from the original is preserved.

---

## Features

- Read/write files
- Create/list/delete directories
- Move files/directories
- Search files
- Get file metadata
- Dynamic directory access control via [Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots)
- **OAuth 2.1 authentication** with PKCE support
- **ChatGPT integration** via MCP connectors

## Installation

```bash
npm install -g mcpfs
```

Or for local development:

```bash
npm install
npm run build
```

## Quick Start

```bash
# Initialize credentials (creates .env with random values)
mcpfs --init

# Start the server
mcpfs /path/to/your/project
```

## Using with ChatGPT

ChatGPT requires a publicly accessible HTTPS URL. Use Cloudflare Tunnel (free) to expose your local server:

### Step 1: Install Cloudflare Tunnel

```bash
# Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
chmod +x cloudflared
sudo mv cloudflared /usr/local/bin/

# Mac
brew install cloudflared

# Windows - download from:
# https://github.com/cloudflare/cloudflared/releases
```

### Step 2: Start mcpfs

```bash
mcpfs --init  # First time only - creates credentials
mcpfs /path/to/your/project
```

### Step 3: Start the Tunnel

In a separate terminal:

```bash
cloudflared tunnel --url http://localhost:24024
```

You'll get a URL like `https://random-words.trycloudflare.com`

### Step 4: Connect in ChatGPT

1. Go to **ChatGPT → Settings → Connectors → Create**
2. **Name**: `mcpfs` (or any name you prefer)
3. **URL**: `https://random-words.trycloudflare.com/mcp` (use your tunnel URL + `/mcp`)
4. **Authentication**: OAuth
5. **Client ID**: Copy from your `.env` file
6. **Client Secret**: Copy from your `.env` file
7. Click **Create**

ChatGPT will redirect you to authorize. Once complete, you can use filesystem tools in ChatGPT!

### Note on Tunnel URLs

Quick tunnels generate a new URL each time. For a permanent URL:

- Create a free Cloudflare account
- Set up a named tunnel with your own domain

---

## Usage

### Default Directory Behavior

When no directories are specified, the server will serve the **current working directory** if it's considered safe. The server will refuse to auto-serve:

- Root directory (`/`)
- Home directory (`~`)
- System directories (`/usr`, `/etc`, `/var`, `/System`, etc.)

To serve these directories, you must specify them explicitly as command-line arguments.

### Command Line Options

| Option    | Description                                     |
| --------- | ----------------------------------------------- |
| `--init`  | Generate random credentials and save to `.env`  |
| `--force` | Used with `--init` to overwrite existing `.env` |

### Environment Variables

```bash
CLIENT_ID=myid CLIENT_SECRET=mysecret mcpfs /path/to/dir

# With custom port
PORT=8080 CLIENT_ID=myid CLIENT_SECRET=mysecret mcpfs /path/to/dir
```

| Variable        | Required | Default | Description         |
| --------------- | -------- | ------- | ------------------- |
| `CLIENT_ID`     | Yes      | -       | OAuth client ID     |
| `CLIENT_SECRET` | Yes      | -       | OAuth client secret |
| `PORT`          | No       | 24024   | Server port         |

---

## HTTP Endpoints

### OAuth 2.1 Discovery (RFC 9728, RFC 8414)

| Method | Path                                      | Description                   |
| ------ | ----------------------------------------- | ----------------------------- |
| GET    | `/.well-known/oauth-protected-resource`   | Protected resource metadata   |
| GET    | `/.well-known/oauth-authorization-server` | Authorization server metadata |

### OAuth 2.1 Endpoints

| Method | Path         | Description                            |
| ------ | ------------ | -------------------------------------- |
| POST   | `/register`  | Dynamic client registration (RFC 7591) |
| GET    | `/authorize` | Authorization endpoint with PKCE       |
| POST   | `/token`     | Token endpoint                         |

### MCP Endpoints

| Method | Path   | Auth   | Description                                      |
| ------ | ------ | ------ | ------------------------------------------------ |
| POST   | `/mcp` | Bearer | Send MCP messages (initialize, tool calls, etc.) |
| GET    | `/mcp` | Bearer | SSE stream for server-to-client notifications    |
| DELETE | `/mcp` | Bearer | Terminate session                                |

---

## Authentication

This server supports OAuth 2.1 with multiple authentication flows:

### Authorization Code Flow with PKCE (Recommended)

Used by ChatGPT and other MCP clients. The flow is:

1. Client discovers OAuth endpoints via `/.well-known/oauth-authorization-server`
2. Client registers dynamically via `/register` (or uses static credentials)
3. Client redirects to `/authorize` with PKCE challenge
4. Server redirects back with authorization code
5. Client exchanges code for tokens at `/token`

### Client Credentials Flow (Machine-to-Machine)

For direct API access without user interaction:

```bash
curl -X POST http://localhost:24024/token \
  -d "grant_type=client_credentials" \
  -d "client_id=YOUR_CLIENT_ID" \
  -d "client_secret=YOUR_CLIENT_SECRET"
```

Response:

```json
{
  "access_token": "abc123...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

### Using the Token

```bash
curl -X POST http://localhost:24024/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "my-client", "version": "1.0.0" }
    }
  }'
```

---

## Directory Access Control

The server uses a flexible directory access control system.

### Method 1: Command-line Arguments

```bash
mcpfs /path/to/dir1 /path/to/dir2
```

### Method 2: MCP Roots (Recommended)

MCP clients that support [Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots) can dynamically update the allowed directories.

### How It Works

1. **Server Startup** - Server starts with directories from command-line arguments
2. **Client Connection** - Client connects and sends `initialize` request
3. **Roots Protocol** - If client supports roots, server uses client's roots
4. **Fallback** - If client doesn't support roots, server uses command-line directories
5. **Access Control** - All filesystem operations are restricted to allowed directories

---

## API

### Tools

- **read_text_file**
  - Read complete contents of a file as text
  - Inputs:
    - `path` (string)
    - `head` (number, optional): First N lines
    - `tail` (number, optional): Last N lines

- **read_media_file**
  - Read an image or audio file as base64
  - Input: `path` (string)

- **read_multiple_files**
  - Read multiple files simultaneously
  - Input: `paths` (string[])

- **write_file**
  - Create new file or overwrite existing
  - Inputs: `path` (string), `content` (string)

- **edit_file**
  - Make selective edits with pattern matching
  - Inputs: `path`, `edits` (array of oldText/newText), `dryRun` (boolean)

- **create_directory**
  - Create new directory or ensure it exists
  - Input: `path` (string)

- **list_directory**
  - List directory contents with [FILE] or [DIR] prefixes
  - Input: `path` (string)

- **list_directory_with_sizes**
  - List directory with file sizes
  - Inputs: `path` (string), `sortBy` ("name" | "size")

- **move_file**
  - Move or rename files and directories
  - Inputs: `source` (string), `destination` (string)

- **search_files**
  - Recursively search for files matching patterns
  - Inputs: `path`, `pattern`, `excludePatterns`

- **directory_tree**
  - Get recursive JSON tree structure
  - Inputs: `path`, `excludePatterns`

- **get_file_info**
  - Get detailed file/directory metadata
  - Input: `path` (string)

- **list_allowed_directories**
  - List all accessible directories
  - No input required

### Tool Annotations

| Tool                        | readOnlyHint | idempotentHint | destructiveHint |
| --------------------------- | ------------ | -------------- | --------------- |
| `read_text_file`            | `true`       | –              | –               |
| `read_media_file`           | `true`       | –              | –               |
| `read_multiple_files`       | `true`       | –              | –               |
| `list_directory`            | `true`       | –              | –               |
| `list_directory_with_sizes` | `true`       | –              | –               |
| `directory_tree`            | `true`       | –              | –               |
| `search_files`              | `true`       | –              | –               |
| `get_file_info`             | `true`       | –              | –               |
| `list_allowed_directories`  | `true`       | –              | –               |
| `create_directory`          | `false`      | `true`         | `false`         |
| `write_file`                | `false`      | `true`         | `true`          |
| `edit_file`                 | `false`      | `false`        | `true`          |
| `move_file`                 | `false`      | `false`        | `false`         |

---

## Security

- **OAuth 2.1 authentication** with PKCE for authorization code flow
- **Token audience validation** - tokens are bound to the resource server
- **Refresh token rotation** - tokens are rotated on each refresh (OAuth 2.1 requirement)
- Only directories specified at startup (or via MCP Roots) are accessible
- Symlinks are resolved to prevent directory escape attacks

## License

MIT License. See LICENSE file for details.

## Credits

Based on the [MCP Filesystem Server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) by Anthropic, PBC.
