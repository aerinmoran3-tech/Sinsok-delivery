# Agent Instructions — READ BEFORE TAKING ANY ACTION

This file is a binding instruction set for any AI agent (including Replit AI) working in this repository.

---

## What This Project Is

A static single-page web application with no server, no build process, and no runtime dependencies.

- `index.html` — the entire frontend (HTML, CSS, JavaScript)
- `Code.gs` — Google Apps Script backend (runs inside Google, NOT on any server)
- `docs/` — documentation only
- `README.md` — project overview
- `netlify.toml` — Netlify deployment configuration

---

## Deployment Flow

```
Code edited in Replit → Pushed to GitHub → Netlify auto-deploys
```

Replit is a **code editor only** for this project. GitHub is the source of truth. Netlify handles all deployment.

---

## STRICTLY FORBIDDEN — Do Not Do Any of the Following

1. **No package installation** — Do not run npm, pip, yarn, pnpm, or any package manager
2. **No server setup** — Do not create Express, Flask, FastAPI, or any server configuration
3. **No workflows** — Do not configure, start, or modify any Replit workflows or run commands
4. **No backend integration** — Do not add databases, APIs, authentication services, or third-party integrations
5. **No environment variables or secrets** — Do not add, modify, or request any secrets or env vars
6. **No build tools** — Do not add webpack, vite, parcel, or any bundler
7. **No new files** unless explicitly requested by the user
8. **No migrations or setup scripts** — Do not run any scripts that change the environment
9. **No Docker, containers, or infrastructure config** of any kind
10. **No modifications to `netlify.toml`** unless the user explicitly asks

---

## What You ARE Allowed To Do

- Edit `index.html` when explicitly instructed by the user
- Edit `Code.gs` when explicitly instructed by the user
- Edit documentation files when explicitly instructed by the user
- Read files to understand the codebase

---

## Why These Rules Exist

The owner of this project has deliberately chosen a zero-infrastructure, serverless architecture. Any "setup", "improvement", or "migration" added by an AI agent would break the deployment pipeline or add unwanted complexity. When in doubt, do nothing and ask the user.
