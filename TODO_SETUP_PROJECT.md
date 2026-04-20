# TODO\_SETUP\_PROJECT.md — HCD Title Transfer Agent: Complete Setup & Demo Guide

> **Purpose:** Step-by-step instructions to pull the Docker image from Docker Hub, configure
> the environment, run the container, verify it works, and perform a live demo of the
> HCD Title Transfer Agent on **any computer** with Docker Desktop installed.
>
> **Image:** `bassn/hcd-title-agent:latest`
> **Registry:** Docker Hub (private repository)
> **Image Digest:** `sha256:56f36d125f805658fdeb358018a0fae4ff16f190b0c11cf5fa35552e10cdf2a3`
> **Image Size:** ~2.91 GB (697 MB compressed on Docker Hub)
> **Port:** `3031`
> **Architecture:** `linux/amd64`

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Docker Hub Authentication](#2-docker-hub-authentication)
3. [Pull the Image](#3-pull-the-image)
4. [Create the Environment File](#4-create-the-environment-file)
5. [Run the Container](#5-run-the-container)
6. [Verify the Container is Healthy](#6-verify-the-container-is-healthy)
7. [Full Demo Walkthrough](#7-full-demo-walkthrough)
8. [Troubleshooting Guide](#8-troubleshooting-guide)
9. [Container Architecture Reference](#9-container-architecture-reference)
10. [Clean Up](#10-clean-up)

---

## 1. Prerequisites

### Required Software

| Software | Version | Why |
|---|---|---|
| **Docker Desktop** | 4.x+ (Engine 24+) | Runs the container (Linux containers mode) |
| **Web Browser** | Chrome, Edge, or Firefox | Access the UI at `http://localhost:3031` |
| **GitHub Account** | With Copilot access | Provides the `COPILOT_GITHUB_TOKEN` for AI agent |

### System Requirements

| Resource | Minimum | Recommended |
|---|---|---|
| RAM | 4 GB | 8 GB |
| Disk | 5 GB free | 10 GB free |
| CPU | 2 cores | 4 cores |
| Network | Internet access | Stable broadband (needed for AI model calls) |

### Pre-Flight Checklist

```powershell
# 1. Verify Docker Desktop is running and using Linux containers
docker version
# Expected: Client & Server both show, OS/Arch: linux/amd64

# 2. Verify Docker can pull images
docker pull hello-world
docker run --rm hello-world
# Expected: "Hello from Docker!" message

# 3. Check available disk space
# PowerShell:
Get-PSDrive C | Select-Object Used, Free
# Expected: At least 5 GB free

# 4. Check that port 3031 is available
Test-NetConnection -ComputerName localhost -Port 3031
# Expected: TcpTestSucceeded: False (port not in use yet)
```

> **IMPORTANT (Windows):** Docker Desktop must be in **Linux containers** mode,
> not Windows containers. Right-click the Docker tray icon → "Switch to Linux containers..."
> if needed.

---

## 2. Docker Hub Authentication

The image is in a **private** Docker Hub repository. You must log in before pulling.

### Option A: Interactive Login (Recommended)

```powershell
docker login -u bassn
# You will be prompted for a password.
# Enter your Docker Hub password or Personal Access Token (PAT).
# Expected output: "Login Succeeded"
```

### Option B: Login with PAT via stdin (Non-Interactive / CI)

```powershell
# PowerShell:
"YOUR_DOCKER_HUB_PAT" | docker login -u bassn --password-stdin

# Bash/macOS:
echo "YOUR_DOCKER_HUB_PAT" | docker login -u bassn --password-stdin
```

### Verify Login Succeeded

```powershell
docker info 2>&1 | Select-String "Username"
# Expected: Username: bassn
```

### Debug: Login Fails

| Error | Cause | Fix |
|---|---|---|
| `unauthorized: incorrect username or password` | Wrong password/PAT | Regenerate PAT at https://app.docker.com/settings → Security |
| `Error response from daemon: Get https://registry-1.docker.io/v2/` | Docker Desktop not running | Start Docker Desktop, wait for it to finish initializing |
| `certificate signed by unknown authority` | Corporate proxy/firewall | Configure Docker Desktop proxy settings |

### How to Create a Docker Hub PAT

1. Go to https://app.docker.com/settings
2. Click **Security** → **New Access Token**
3. Name it (e.g., "demo-laptop")
4. Set permissions to **Read-only** (sufficient for pulling)
5. Copy the token — it starts with `dckr_pat_`

---

## 3. Pull the Image

```powershell
docker pull bassn/hcd-title-agent:latest
```

**Expected output** (all layers will show "Pull complete" or "Already exists"):

```
latest: Pulling from bassn/hcd-title-agent
abc123def456: Pull complete
...
Digest: sha256:56f36d125f805658fdeb358018a0fae4ff16f190b0c11cf5fa35552e10cdf2a3
Status: Downloaded newer image for bassn/hcd-title-agent:latest
docker.io/bassn/hcd-title-agent:latest
```

### Verify the Image is Local

```powershell
docker images bassn/hcd-title-agent --format "table {{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}"
```

**Expected:**

```
REPOSITORY                  TAG       IMAGE ID       SIZE
bassn/hcd-title-agent       latest    56f36d125f80   2.91GB
```

### Debug: Pull Fails

| Error | Cause | Fix |
|---|---|---|
| `repository does not exist or may require docker login` | Not logged in or repo truly doesn't exist | Run `docker login -u bassn` first |
| `manifest unknown` | Image was deleted or tag doesn't exist | Check Docker Hub web UI for available tags |
| `error pulling image: timeout` | Slow network / large image (2.91GB) | Retry; check internet connection |
| `no space left on device` | Disk full | `docker system prune -a` then retry |

---

## 4. Create the Environment File

The container requires a **GitHub Copilot token** to power the AI agent. This token is
injected via an environment file — it is **never baked into the image**.

### Step 4a: Create a Project Directory

```powershell
# Create a working directory for the demo
mkdir C:\demo\hcd-agent
cd C:\demo\hcd-agent
```

### Step 4b: Create the `.env` File

Create a file called `.env` in the project directory with the following content:

```env
# =============================================================================
# HCD Title Transfer Agent — Environment Variables
# =============================================================================

# REQUIRED: GitHub Copilot CLI authentication token
# This token allows the AI agent inside the container to call Copilot models.
# Get this from: https://github.com/settings/tokens
# Required scopes: copilot (or use the same token from GitHub Copilot CLI auth)
COPILOT_GITHUB_TOKEN=ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# OPTIONAL: GitHub username (used for quota API display in the UI)
GITHUB_USERNAME=bassn
```

> **CRITICAL:** The `COPILOT_GITHUB_TOKEN` is the **most important** config. Without it,
> the AI agent cannot run and every upload will fail at the extraction stage.

### How to Get Your Copilot Token

**Method 1: From GitHub CLI (Recommended)**

```powershell
# Install GitHub CLI if not already installed
winget install --id GitHub.cli

# Authenticate
gh auth login

# Get the token
gh auth token
# Copy the output — this is your COPILOT_GITHUB_TOKEN
```

**Method 2: From GitHub Settings (PAT)**

1. Go to https://github.com/settings/tokens → **Fine-grained tokens** → **Generate new token**
2. Name: "HCD Agent Demo"
3. Expiration: 7 days (for demo)
4. Repository access: No repositories needed
5. Permissions: N/A (Copilot access is account-level)
6. Generate and copy the token

**Method 3: From an Existing Copilot CLI Installation**

If you already have `@github/copilot` CLI installed and authenticated:

```powershell
# The token is stored in the Copilot config directory
# Windows:
Get-Content "$env:LOCALAPPDATA\github-copilot\hosts.json" | ConvertFrom-Json
# Look for the oauth_token value
```

### Verify Your Token Works

```powershell
# Quick test: check if the token has Copilot access
$token = (Get-Content .env | Select-String "COPILOT_GITHUB_TOKEN" | ForEach-Object { ($_ -split "=", 2)[1] }).Trim()
$headers = @{Authorization = "Bearer $token"; "X-GitHub-Api-Version" = "2022-11-28"}
try {
    $r = Invoke-RestMethod -Uri "https://api.github.com/user" -Headers $headers
    Write-Host "Token valid for user: $($r.login)" -ForegroundColor Green
} catch {
    Write-Host "Token invalid or expired: $($_.Exception.Message)" -ForegroundColor Red
}
```

---

## 5. Run the Container

### Option A: `docker run` (Simplest)

```powershell
docker run -d `
  --name hcd-title-agent `
  --restart unless-stopped `
  -p 3031:3031 `
  --env-file .env `
  -v hcd_workspace_data:/workspace `
  bassn/hcd-title-agent:latest
```

### Option B: Docker Compose (Recommended for Repeatability)

Create a `docker-compose.yml` file in your project directory:

```yaml
# =============================================================================
# HCD Title Transfer Agent — Docker Compose
# Single-container deployment: Next.js + Copilot CLI + MCP PDF tools
# Port: 3031 | Volume: workspace_data → /workspace
# =============================================================================

name: hcd-title-agent

services:
  app:
    image: bassn/hcd-title-agent:latest
    container_name: hcd-title-agent
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "3031"
      HOSTNAME: "0.0.0.0"
      NEXT_TELEMETRY_DISABLED: "1"
    env_file:
      - path: .env
        required: true
    ports:
      - "3031:3031"
    volumes:
      - type: volume
        source: workspace_data
        target: /workspace

volumes:
  workspace_data:
    name: hcd_workspace_data
```

Then run:

```powershell
docker compose up -d
```

**Expected output:**

```
[+] Running 2/2
 ✔ Volume "hcd_workspace_data"  Created
 ✔ Container hcd-title-agent    Started
```

### Key Container Parameters Explained

| Parameter | Value | Purpose |
|---|---|---|
| `-p 3031:3031` | Host port → Container port | Access the UI at `http://localhost:3031` |
| `--env-file .env` | Environment file | Injects `COPILOT_GITHUB_TOKEN` (required for AI) |
| `-v hcd_workspace_data:/workspace` | Named volume | Persists run data (PDFs, transcripts, DB) across restarts |
| `--restart unless-stopped` | Restart policy | Auto-restarts on crash; stops only if manually stopped |
| `NODE_ENV=production` | Runtime mode | Enables Next.js standalone optimizations |
| `NEXT_TELEMETRY_DISABLED=1` | Telemetry | Disables Next.js analytics |

---

## 6. Verify the Container is Healthy

### Step 6a: Check Container Status

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

**Expected:**

```
NAMES               STATUS                    PORTS
hcd-title-agent     Up 30 seconds (healthy)   0.0.0.0:3031->3031/tcp
```

> **Note:** The container has a built-in healthcheck that probes `/api/health` every 30 seconds.
> It takes up to 15 seconds for the first health check (start period). The status will show
> `(health: starting)` initially, then `(healthy)` once it passes.

### Step 6b: Hit the Health Endpoint

```powershell
# PowerShell:
Invoke-WebRequest -Uri http://localhost:3031/api/health -UseBasicParsing | Select-Object StatusCode, Content

# curl (if available):
curl http://localhost:3031/api/health
```

**Expected:**

```
StatusCode Content
---------- -------
       200 {"ok":true}
```

### Step 6c: Open the UI in a Browser

```
http://localhost:3031
```

**Expected:** A dark-gray themed UI with:
- **Left sidebar:** "New Title" and "History" navigation links
- **Center panel:** Upload area (dashed rectangle) + Download area
- **Right panel:** "Copilot Thoughts" header (empty until a run starts)

### Step 6d: Check Container Logs (If Something Looks Wrong)

```powershell
docker logs hcd-title-agent --tail 30
```

**Expected:** You should see Next.js startup messages like:

```
▲ Next.js 16.2.4
- Local:        http://0.0.0.0:3031
- Network:      http://0.0.0.0:3031

✓ Starting...
✓ Ready in XXXms
```

### Debug: Container Not Starting

| Symptom | Check | Fix |
|---|---|---|
| Status: `Exited (1)` | `docker logs hcd-title-agent` | Check for missing dependencies or port conflicts |
| Status: `(unhealthy)` | `docker logs hcd-title-agent --tail 50` | Health endpoint not responding; wait longer or check logs |
| Status: `Created` (not starting) | `docker ps -a` | Port 3031 may be in use: `netstat -ano \| findstr :3031` |
| `port is already allocated` | Another service on 3031 | Stop conflicting service or use `-p 3032:3031` (then access via `:3032`) |
| `no matching manifest for windows/amd64` | Docker in Windows container mode | Switch to Linux containers (right-click Docker tray icon) |

---

## 7. Full Demo Walkthrough

This is the end-to-end demonstration flow for the Take Home Assignment interview.

### Overview of the Pipeline

```
Upload PDF → AI Extracts Data → Human Reviews (HITL) → AI Fills HCD Forms → Download ZIP
```

**Stages (visible in Progress Bar):**

| Stage | Progress | What Happens |
|---|---|---|
| `ingested` | 10% | PDF uploaded and saved to `/workspace/runs/<id>/in/` |
| `extracting` | 30% | Copilot CLI + MCP tools extract text, OCR, parse fields |
| `awaiting_human` | 50% | HITL modal appears — human reviews & edits extracted data |
| `filling` | 70% | Copilot CLI fills blank HCD forms with approved data |
| `zipping` | 90% | Filled PDFs + manifest + transcript packaged into ZIP |
| `done` | 100% | ZIP ready for download |

### Step 7a: Upload a Title PDF

1. Open `http://localhost:3031` (should redirect to `/new`)
2. Click the **dashed upload area** or drag-and-drop a PDF
3. Use the **sample title PDF** that ships inside the container (you can use any HCD title PDF)

> **Note:** The sample title (`sample_title.pdf`) is already baked into the container at
> `/app/assets/sample_title.pdf`. For the demo, you need a copy on your local machine.
> If you don't have one, you can extract it:
> ```powershell
> docker cp hcd-title-agent:/app/assets/sample_title.pdf .
> ```

4. After upload, the progress bar moves to **10% (ingested)** then **30% (extracting)**
5. The **Copilot Thoughts** panel on the right starts streaming AI agent activity:
   - Tool calls (`extract_text`, `convert_pdf`)
   - Reasoning about the PDF content
   - OCR and text extraction results

### Step 7b: Human-in-the-Loop Review (HITL)

6. After extraction (~30-90 seconds), a **modal dialog** appears automatically
7. The modal shows all extracted fields:

   | Field | Example Value |
   |---|---|
   | Decal Number | `LBP4255` |
   | Serial Number | `CAVI10AZ2321354A` |
   | Trade Name | `CAVCO` |
   | Manufacturer | `CAVCO INDUSTRIES INC` |
   | Manufacture Date | `05/11/2023` |
   | Model Name | `L1OEP14401A` |
   | Owner Name | `SNELL SANDERS LLC` |
   | Owner Address | `924 LAGUNA ST SUITE B` |
   | City / State / ZIP | `SANTA BARBARA / CA / 93101` |
   | Situs Address | `520 PINE AVE NUMBER 55` |
   | Situs City / State / ZIP | `SANTA BARBARA / CA / 93117` |

8. **You can edit any field** — modified fields are highlighted
9. Click **"Approve"** to continue, or **"Reject"** to cancel the run

> **Demo Tip:** During the interview, point out:
> - The HITL modal is the key safety checkpoint
> - Fields are editable — the human has full override power
> - The system uses Compare-and-Swap (CAS) to prevent double-approval race conditions
> - This is where a property manager would verify data before legal forms are generated

### Step 7c: Form Filling

10. After approval, progress moves to **70% (filling)**
11. The Copilot Thoughts panel shows the AI agent filling three HCD forms:
    - **HCD 476.6G** — Multi-Purpose Transfer Form
    - **HCD 476.6** — Statement of Facts
    - **HCD 480.5** — Application for Registration
12. The agent uses `fill_form_pdf` MCP tool to write data into PDF AcroForm fields

### Step 7d: Download the ZIP Packet

13. Progress reaches **100% (done)** and the **Download** button enables
14. Click **Download** to get a ZIP file containing:

```
hcd-packet-<runId>.zip
├── 476.6G.pdf          ← Filled Multi-Purpose Transfer Form
├── 476.6.pdf           ← Filled Statement of Facts
├── 480.5.pdf           ← Filled Application for Registration
├── manifest.json       ← Metadata about the run
└── transcript.jsonl    ← Full AI agent conversation log
```

15. Open the filled PDFs to verify fields are populated correctly

### Step 7e: Check History

16. Click **"History"** in the left sidebar
17. You'll see a table of all runs with status badges, timestamps, and download links
18. Completed runs show a green "done" badge with a download link

### Demo Timing

| Phase | Duration | Notes |
|---|---|---|
| Upload | ~1 second | Instant file save |
| Extraction | 30-90 seconds | AI reads PDF, performs OCR, parses fields |
| HITL Review | As long as you need | Paused until human approves |
| Form Filling | 30-90 seconds | AI maps fields to 3 HCD forms |
| Zipping | <1 second | Archiver packages output |
| **Total** | **~2-4 minutes** | Plus HITL review time |

---

## 8. Troubleshooting Guide

### 8.1 Container Won't Start

```powershell
# Check container status
docker ps -a --filter name=hcd-title-agent --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# View full logs
docker logs hcd-title-agent 2>&1 | Select-Object -Last 50

# Check if port is in use
netstat -ano | findstr :3031
# If something is using port 3031, either stop it or remap:
# docker run ... -p 3032:3031 ...  (then access via http://localhost:3032)
```

### 8.2 Health Check Failing

```powershell
# Check from inside the container
docker exec hcd-title-agent curl -fsS http://127.0.0.1:3031/api/health

# Check the healthcheck script exists
docker exec hcd-title-agent cat /app/scripts/healthcheck.sh

# Check if Node.js process is running
docker exec hcd-title-agent ps aux | grep node
```

### 8.3 Upload Succeeds but Extraction Fails (`run.failed`)

This is almost always a **missing or invalid `COPILOT_GITHUB_TOKEN`**.

```powershell
# Check if the token env var is set inside the container
docker exec hcd-title-agent sh -c 'echo "Token length: ${#COPILOT_GITHUB_TOKEN}"'
# Expected: Token length: 40+ (not 0)

# If token length is 0, your .env file is misconfigured.
# Verify .env contents (DO NOT print the actual token):
docker exec hcd-title-agent sh -c 'env | grep -c COPILOT'
# Expected: 1 (at least)

# Check if Copilot CLI is installed
docker exec hcd-title-agent which copilot
# Expected: /usr/local/bin/copilot

# Check if Copilot CLI can authenticate
docker exec hcd-title-agent copilot --version
# Expected: version string (e.g., 1.x.x)

# Check run directory for error details
docker exec hcd-title-agent ls -la /workspace/runs/
# Find the latest run directory and check transcript:
docker exec hcd-title-agent sh -c 'ls -t /workspace/runs/ | head -1'
# Then check its transcript for errors:
# docker exec hcd-title-agent cat /workspace/runs/<RUN_ID>/transcript.jsonl
```

**Common extraction failure causes:**

| Cause | Symptom | Fix |
|---|---|---|
| Missing `COPILOT_GITHUB_TOKEN` | `Token length: 0` | Add token to `.env` and restart container |
| Expired token | Copilot exits code 1 | Regenerate token (`gh auth token`) |
| No Copilot subscription | Auth error in transcript | Ensure GitHub account has Copilot access |
| Rate limited | Extraction starts then fails | Wait and retry; check quota in UI (click "Copilot Thoughts" header) |

### 8.4 Extraction Works but Form Filling Fails

```powershell
# Check MCP PDF tools are installed
docker exec hcd-title-agent which mcp-pdf
docker exec hcd-title-agent which pymupdf4llm-mcp
# Expected: paths under /home/app/.local/bin/

# Check blank form PDFs exist
docker exec hcd-title-agent ls -la /app/assets/
# Expected: hcd-rt-476-6.pdf, hcd-rt-476-6g.pdf, hcd-rt-480-5.pdf, sample_title.pdf

# Check the prompts directory
docker exec hcd-title-agent ls -la /app/prompts/
# Expected: extractor.md, filler.md, field_catalogue.json
```

### 8.5 SSE Events Not Showing in Thoughts Panel

```powershell
# Test SSE endpoint directly (replace RUN_ID with actual ID)
# Find the latest run ID:
docker exec hcd-title-agent sh -c 'sqlite3 /workspace/hcd.db "SELECT id, status FROM runs ORDER BY created_at DESC LIMIT 5;"'

# Test SSE stream in PowerShell:
$run_id = "YOUR_RUN_ID_HERE"
Invoke-WebRequest -Uri "http://localhost:3031/api/runs/$run_id/events" -UseBasicParsing -TimeoutSec 5
```

### 8.6 ZIP Download Not Working

```powershell
# Check run status
$run_id = "YOUR_RUN_ID_HERE"
Invoke-RestMethod -Uri "http://localhost:3031/api/runs/$run_id" | ConvertTo-Json

# Status must be "done" for download to work
# If status is "failed", check the error field in the response

# Manually check if ZIP exists in the container
docker exec hcd-title-agent sh -c "ls -la /workspace/runs/$run_id/*.zip"
```

### 8.7 Container Restart Recovery

If the container crashes or restarts mid-run:

- Runs in `extracting`, `filling`, or `zipping` are automatically marked `failed` on restart
- Runs in `awaiting_human` are **preserved** — you can still approve/cancel them
- Runs in `done` or `failed` are untouched
- The SQLite database and all run files persist in the `hcd_workspace_data` volume

```powershell
# Manually restart the container
docker restart hcd-title-agent

# Or via docker compose:
docker compose restart

# Verify health after restart
docker ps --format "table {{.Names}}\t{{.Status}}"
# Wait for "(healthy)" status
```

### 8.8 Network / Firewall Issues

The container needs **outbound internet access** to:
1. Call GitHub Copilot API (model inference via `claude-haiku-4.5`)
2. Fetch quota information from GitHub API

```powershell
# Test outbound connectivity from inside the container
docker exec hcd-title-agent curl -fsS https://api.github.com/zen
# Expected: A random GitHub zen quote

# Test Copilot API reachability
docker exec hcd-title-agent curl -fsS -o /dev/null -w "%{http_code}" https://api.githubcopilot.com
# Expected: 401 (unauthorized but reachable) or 404 — NOT a timeout
```

If behind a corporate proxy:
```powershell
# Add proxy env vars to .env:
# HTTP_PROXY=http://proxy.corp.com:8080
# HTTPS_PROXY=http://proxy.corp.com:8080
# NO_PROXY=localhost,127.0.0.1
```

---

## 9. Container Architecture Reference

### What's Inside the Container

```
Base: node:22-bookworm-slim (Debian Bookworm)
├── Node.js 22 (LTS) — Next.js 16 standalone server
├── Python 3 + uv — MCP PDF tool servers
├── Copilot CLI (@github/copilot) — AI agent orchestrator
│   └── Model: claude-haiku-4.5 (pinned)
├── MCP Servers (pre-installed via uv):
│   ├── mcp-pdf[forms] — PDF text extraction + AcroForm filling
│   └── pymupdf4llm-mcp — High-fidelity PDF → Markdown conversion
├── tesseract-ocr — Offline OCR for scanned titles
├── ghostscript + poppler-utils — PDF manipulation
├── git — Required by Copilot CLI
├── tini — PID 1 signal handling
├── sqlite3 — CLI for debugging the database
└── curl — Healthcheck probe
```

### Volume Layout (`/workspace`)

```
/workspace/
├── hcd.db              ← SQLite database (WAL mode) — run metadata
└── runs/
    └── <ULID>/         ← One directory per run (26-char ULID)
        ├── in/
        │   └── title.pdf           ← Uploaded PDF (original)
        ├── out/
        │   ├── 476.6G.pdf          ← Filled HCD 476.6G
        │   ├── 476.6.pdf           ← Filled HCD 476.6
        │   └── 480.5.pdf           ← Filled HCD 480.5
        ├── .copilot/
        │   └── mcp-config.json     ← Per-run MCP server config
        ├── transcript.jsonl        ← Full AI conversation log
        ├── output.json             ← Extracted fields JSON
        ├── approved.json           ← Human-approved fields JSON
        └── hcd-packet-<id>.zip     ← Final downloadable ZIP
```

### API Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Health check — returns `{"ok":true}` |
| `POST` | `/api/runs` | Upload PDF, start pipeline |
| `GET` | `/api/runs` | List all runs (newest first) |
| `GET` | `/api/runs/[id]` | Get single run details |
| `GET` | `/api/runs/[id]/events` | SSE stream (real-time events) |
| `POST` | `/api/runs/[id]/approve` | Approve HITL with (optionally edited) data |
| `POST` | `/api/runs/[id]/cancel` | Cancel/reject a run |
| `GET` | `/api/runs/[id]/download` | Download ZIP (only when status=done) |
| `GET` | `/api/runs/[id]/transcript` | Stream raw transcript JSONL |
| `GET` | `/api/quota` | GitHub Copilot premium request usage |

### Environment Variables Reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `COPILOT_GITHUB_TOKEN` | **YES** | — | GitHub token for Copilot CLI auth |
| `GITHUB_USERNAME` | No | — | Used for quota API display |
| `NODE_ENV` | No | `production` | Set by Dockerfile |
| `PORT` | No | `3031` | Server listen port |
| `HOSTNAME` | No | `0.0.0.0` | Bind address |
| `NEXT_TELEMETRY_DISABLED` | No | `1` | Disable Next.js telemetry |
| `HTTP_PROXY` | No | — | Corporate proxy support |
| `HTTPS_PROXY` | No | — | Corporate proxy support |

---

## 10. Clean Up

### Stop the Container

```powershell
# Via docker compose:
docker compose down

# Via docker directly:
docker stop hcd-title-agent
docker rm hcd-title-agent
```

### Remove the Image (Free 2.91 GB)

```powershell
docker rmi bassn/hcd-title-agent:latest
```

### Remove the Volume (Deletes All Run Data)

```powershell
# WARNING: This permanently deletes all uploaded PDFs, filled forms, and transcripts
docker volume rm hcd_workspace_data
```

### Full Cleanup

```powershell
docker compose down -v     # Stop container + remove volume
docker rmi bassn/hcd-title-agent:latest   # Remove image
```

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────────┐
│  HCD Title Transfer Agent — Quick Start                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. docker login -u bassn                                       │
│  2. docker pull bassn/hcd-title-agent:latest                    │
│  3. Create .env with COPILOT_GITHUB_TOKEN=ghp_...               │
│  4. docker run -d --name hcd-title-agent -p 3031:3031 \         │
│       --env-file .env -v hcd_workspace_data:/workspace \        │
│       bassn/hcd-title-agent:latest                              │
│  5. Open http://localhost:3031                                  │
│  6. Upload sample_title.pdf → Review → Approve → Download ZIP  │
│                                                                 │
│  Health:    curl http://localhost:3031/api/health                │
│  Logs:     docker logs hcd-title-agent --tail 30                │
│  Restart:  docker restart hcd-title-agent                       │
│  Stop:     docker compose down                                  │
│                                                                 │
│  Image:    bassn/hcd-title-agent:latest (2.91 GB)               │
│  Port:     3031                                                 │
│  Volume:   hcd_workspace_data → /workspace                      │
│  Token:    COPILOT_GITHUB_TOKEN in .env (REQUIRED)              │
│                                                                 │
│  Extract sample PDF from container:                             │
│  docker cp hcd-title-agent:/app/assets/sample_title.pdf .       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```
