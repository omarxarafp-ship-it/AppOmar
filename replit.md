# Overview

This is a WhatsApp bot application that enables users to download Android APK and XAPK files through WhatsApp messages. The system consists of two main components:

1. **Node.js WhatsApp Bot** - Handles WhatsApp messaging, user interactions, and app search functionality using the Baileys library
2. **Python API Server** - Manages APK/XAPK downloads from APKPure with intelligent file type detection and caching

The bot allows users to search for Android apps via Google Play Store metadata and download them directly through WhatsApp, with support for both regular APK files and split APK packages (XAPK/APKS).

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

**WhatsApp Interface (bot.js)**
- Uses `@whiskeysockets/baileys` library for WhatsApp Web API integration
- Implements multi-file authentication state for persistent sessions
- Handles QR code authentication for initial connection
- Processes incoming messages and commands from WhatsApp users
- Integrates with `google-play-scraper` for app metadata and search functionality

**File Processing**
- Analyzes XAPK contents using `adm-zip` to determine file structure
- Compresses and optimizes images using `sharp` before sending via WhatsApp
- Implements automatic cleanup of old downloads (30-minute retention)

## Backend Architecture

**Python FastAPI Server (api_server.py)**
- RESTful API design with asynchronous request handling
- CORS middleware enabled for cross-origin requests
- Background task processing for non-blocking operations
- Multi-client HTTP approach using `httpx`, `curl-cffi`, and standard libraries

**Download Management**
- Integration with `aria2p` for parallel, multi-threaded downloads
- Per-file download locking mechanism to prevent duplicate simultaneous downloads
- User-based download tracking to manage concurrent requests
- Implements pending deletion tasks for temporary file cleanup

**Caching Strategy**
- Two-tier caching system:
  1. URL cache with 1800-second TTL for download links
  2. File metadata cache for recently accessed files
- In-memory cache dictionaries for fast lookup
- Reduces redundant scraping and improves response times

**APKPure Client (apkpure_client.py)**
- Intelligent file type detection (APK vs XAPK vs APKS)
- Multiple HTTP client fallback chain for reliability:
  - Primary: `cloudscraper` (bypasses Cloudflare protection)
  - Secondary: `curl-cffi` (browser impersonation)
  - Tertiary: `httpx` and `requests`
- Dataclass-based result structures for type safety
- BeautifulSoup HTML parsing for extracting download metadata

## Data Storage Solutions

**PostgreSQL Database**
- Connection pooling via `pg` library (Node.js) and `psycopg2` (Python)
- Schema initialization through `database/schema.sql`
- SSL-enabled connections for production environments
- Likely stores user activity, download history, and bot state

**File System Storage**
- Local directory: `app_cache/` for Python server downloads
- Local directory: `downloads/` for Node.js bot processing
- Temporary file storage with automatic cleanup mechanisms
- Directory creation on startup if not exists

## Authentication and Authorization

**WhatsApp Authentication**
- Multi-file auth state persistence for maintaining sessions
- QR code-based initial authentication
- Automatic reconnection handling with exponential backoff
- Session management through Baileys library

**No User Authentication**
- The system appears to be open-access through WhatsApp
- No explicit API key or token-based authentication for the Python server
- Security relies on WhatsApp's built-in user identification

## Design Patterns

**Async/Await Pattern**
- Extensive use of asynchronous programming in both Node.js and Python
- Non-blocking I/O operations for scalability
- Background task processing for long-running operations

**Resource Pooling**
- HTTP client connection pooling
- Database connection pooling
- Download lock management using asyncio primitives

**Facade Pattern**
- `APKPureClient` abstracts complexity of multiple HTTP libraries and scraping logic
- Provides simple interface: `download_file()` and `get_smart_download_info()`

**Factory Pattern**
- Dynamic HTTP client selection based on availability and success
- Fallback chain creates appropriate client instances

# External Dependencies

## Third-Party Services

**APKPure** (https://apkpure.com)
- Primary source for APK and XAPK file downloads
- Requires web scraping due to lack of official API
- Cloudflare protection necessitates advanced HTTP clients

**Google Play Store**
- Metadata source via `google-play-scraper` library
- Used for app search, ratings, descriptions, and icons
- No official API usage; relies on scraping

**WhatsApp Web**
- Core messaging platform via unofficial Baileys library
- WebSocket-based real-time communication
- QR code authentication flow

## Key NPM Packages

- `@whiskeysockets/baileys` ^7.0.0-rc.9 - WhatsApp Web API client
- `google-play-scraper` ^10.1.2 - Google Play Store data extraction
- `pg` ^8.16.3 - PostgreSQL client for Node.js
- `sharp` ^0.34.5 - High-performance image processing
- `adm-zip` ^0.5.16 - ZIP file handling for XAPK analysis
- `pino` ^10.1.0 - Logging framework
- `undici` ^7.16.0 - HTTP/1.1 client

## Key Python Packages

- `fastapi` >=0.109.0 - Modern async web framework
- `httpx` >=0.26.0 - Async HTTP client
- `curl-cffi` >=0.6.0 - Browser-like HTTP client with TLS fingerprinting
- `cloudscraper` >=1.2.71 - Cloudflare bypass library
- `aria2p` >=0.12.0 - Python wrapper for aria2c download manager
- `beautifulsoup4` >=4.12.0 - HTML parsing and scraping
- `aiofiles` >=23.2.1 - Async file operations
- `psycopg2-binary` >=2.9.9 - PostgreSQL adapter for Python
- `uvicorn` >=0.27.0 - ASGI server implementation

## Database

**PostgreSQL**
- Schema managed through SQL files in `database/` directory
- Accessed from both Node.js and Python services
- Connection configuration via `DATABASE_URL` environment variable
- Supports SSL for secure connections in production

## External Binaries

**aria2c**
- High-performance download manager with multi-connection support
- Managed via `aria2p` Python library
- Spawned as subprocess by the Python server
- Provides resumable downloads and connection multiplexing