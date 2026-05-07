# mTLS API Client

A local web-based API client (like Postman) that runs on Node.js. Supports **mutual TLS (mTLS)** and **OAuth 2.0 client credentials** — the Express backend proxies all outbound API calls using Node's built-in `https` module so mTLS works natively.

## Quick Start

```bash
cd api-test-client
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Features

- **mTLS support** — configure client cert, key, and CA paths per profile
- **OAuth 2.0 client credentials** — automatic token fetch and caching
- **Request collection** — save, load, and manage API requests
- **Profiles** — reusable configurations for certs + OAuth
- **Dark theme** — developer-tool aesthetic
- **Zero external HTTP libraries** — uses Node's built-in `https` module
- **JSON file storage** — no database required

## Tech Stack

- **Backend**: Node.js, Express
- **Frontend**: Single HTML file (vanilla JS)
- **Storage**: JSON files in `/data`
- **No axios/got** — Node built-in `https` only

## Usage

1. **Create a Profile** — click "Profiles" in the sidebar, then "+ New". Add your mTLS certificate paths and/or OAuth 2.0 credentials.
2. **Make a Request** — enter the URL, select the method, add headers/body as needed.
3. **Select a Profile** — in the Auth or Certs tab, pick your profile to attach mTLS certs and OAuth tokens.
4. **Send** — click Send (or press Ctrl+Enter). The backend proxies the call with your certs and token.
5. **Save** — click the 💾 button to save requests to your collection.
