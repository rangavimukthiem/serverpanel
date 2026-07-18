# EKAFY — API & Function Reference

> Last updated: v0.2.1 — Project delete cleanup

All endpoints require a valid session cookie (`ekafy_token`) or `Authorization: Bearer <token>` header unless otherwise noted.

---

## Authentication

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/auth/login` | POST | Public | Login; sets httpOnly session cookie |
| `/api/auth/me` | GET | User | Returns current user object |
| `/api/auth/logout` | POST | User | Clears session cookie |

---

## System

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/system/status` | GET | User | CPU %, RAM %, disk %, uptime |
| `/health` | GET | Public | Service health ping |

---

## Users

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/users` | GET | Admin | List all users with project memberships |
| `/api/users` | POST | Admin | Create a new user |
| `/api/users/:id` | DELETE | Admin | Remove a user |

---

## Global Services

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/services` | GET | User | List all globally whitelisted systemd services with active status |
| `/api/services/:name/status` | GET | User | Get single service active status |
| `/api/services/:name/:action` | POST | **Admin** | Run `start`, `stop`, or `restart` on a global service |

**Allowed service names (global whitelist):** `nginx`, `mysql`, `mariadb`, `apache2`  
**Allowed actions:** `start`, `stop`, `restart`

---

## Projects

### Core CRUD

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/projects` | GET | User | List projects (admin sees all; users see assigned projects) |
| `/api/projects` | POST | **Admin** | Create a new project |
| `/api/projects/:id` | DELETE | **Admin** | Permanently delete a project and purge its configs, files, services, SSL, and database details |
| `/api/projects/:id/wizard` | GET | Member | Get project wizard config and DB/API wizard output |
| `/api/projects/:id/config` | PATCH | Manager | Update project wizard config (kind, db, api, presets, notes) |
| `/api/projects/:id/members` | PUT | Manager | Assign a user to a project with a role |
| `/api/projects/:id/members/:userId` | DELETE | Manager | Remove a user from a project |

**POST `/api/projects` body:**
```json
{
  "name": "My App",
  "slug": "my-app",
  "path": "/srv/my-app",
  "domain": "app.example.com",
  "port": 4001,
  "gitRepoUrl": "git@github.com:user/repo.git",
  "gitBranch": "main",
  "config": {
    "kind": "full",
    "database": { "provider": "mariadb", "host": "127.0.0.1", "port": 3306, "databaseName": "myapp", "username": "myapp_user" },
    "api": { "baseUrl": "https://api.example.com", "endpoints": [{ "name": "Health", "method": "GET", "path": "/health" }] }
  }
}
```

---

### Infrastructure Setup (Phase 1–3)

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/projects/:id/setup/scaffold` | POST | Manager | Create folder tree + seed .env file |
| `/api/projects/:id/setup/nginx` | POST | Manager | Generate nginx server block, enable, reload |
| `/api/projects/:id/setup/ssl` | POST | Manager | Provision SSL with Certbot; self-signed fallback only when explicitly enabled |

**Scaffold** creates: `public/` `logs/` `releases/` `shared/` `config/` `.env`

**Nginx body:**
```json
{ "domain": "app.example.com", "runtime": "node-app", "port": 4001 }
```
`runtime` can be `static-site`, `static-api`, `node-app`, `python-api`, `php-site`, or `wordpress-site`.
Static projects use Nginx `root`, Node/Python/API projects use localhost `proxy_pass`, and PHP/WordPress projects use `fastcgi_pass`.

**Requires:** `ENABLE_SERVICE_CONTROL=true` in `.env` and a Linux host.

---

### Database Wizard

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/projects/:id/database/provision` | POST | Manager | Create MariaDB DB + user, save creds to project_envs |
| `/api/projects/:id/database/tables` | GET | Member | List tables in the project's database |
| `/api/projects/:id/database/query` | POST | Manager | Run a whitelisted SQL statement |
| `/api/projects/:id/database/presets` | GET | Member | Get SQL template presets |

**Provision body:**
```json
{ "databaseName": "myapp_db", "dbUser": "myapp_user" }
```
Password is **auto-generated** and saved to `project_envs`; never returned in the API response.

**SQL whitelist (allowed statement prefixes):** `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`, `DROP`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `TRUNCATE`

**Blocked patterns:** `DROP DATABASE`, `DROP USER`, `GRANT`, `REVOKE`, `FLUSH`, `LOAD DATA`, `INTO OUTFILE`, `CALL`

---

### Git Operations

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/projects/:id/git/status` | GET | Member | `git status --short` + last 15 log lines |
| `/api/projects/:id/git/init` | POST | Manager | `git init` + optional remote add |
| `/api/projects/:id/git/clone` | POST | Manager | `git clone <url>` into project path |
| `/api/projects/:id/git/pull` | POST | Manager | `git pull origin <branch>` |
| `/api/projects/:id/git/push` | POST | Manager | `git add -A && git commit -m "<msg>" && git push` |

**Init/Clone body:**
```json
{ "repoUrl": "git@github.com:user/repo.git", "branch": "main" }
```
**Push body:**
```json
{ "message": "feat: add new feature" }
```

All git commands use `execFile('git', [...])` — no shell string interpolation.

---

### API Endpoint Registry

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/projects/:id/endpoints` | GET | Member | List all registered endpoints |
| `/api/projects/:id/endpoints` | POST | Manager | Add an endpoint |
| `/api/projects/:id/endpoints/:idx` | PUT | Manager | Update an endpoint by array index |
| `/api/projects/:id/endpoints/:idx` | DELETE | Manager | Remove an endpoint |

Endpoints are stored in `config_json.api.endpoints[]` and editable at any time.

**Endpoint object:**
```json
{ "name": "Health", "method": "GET", "path": "/health", "description": "Service health check" }
```

---

### Environment Variables

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/projects/:id/env` | GET | Manager | List env key names and update timestamps (values NOT returned) |
| `/api/projects/:id/env` | PUT | Manager | Upsert a single key-value; rewrites `.env` on disk |
| `/api/projects/:id/env/:key` | DELETE | Manager | Remove a key; rewrites `.env` on disk |

**Upsert body:**
```json
{ "key": "MY_SECRET", "value": "somevalue" }
```
Keys must match `^[A-Z][A-Z0-9_]{0,127}$`.

---

### Project-Linked Services

| Route | Method | Auth | Description |
|---|---|---|---|
| `/api/projects/:id/services` | GET | Member | List linked services with live status |
| `/api/projects/:id/services` | POST | **Admin** | Link a systemd service, optionally creating/updating the unit file |
| `/api/projects/:id/services/:name/unit` | POST | **Admin** | Create or update the systemd unit file for a linked service |
| `/api/projects/:id/services/:name` | DELETE | **Admin** | Unlink a service |
| `/api/projects/:id/services/:name/status` | GET | Member | Get active status of a linked service |
| `/api/projects/:id/services/:name/:action` | POST | Manager | `start`, `stop`, or `restart` a linked service |

**Link body:**
```json
{
  "serviceName": "my-app",
  "label": "My App Service",
  "createUnit": true,
  "execStart": "npm start",
  "enable": true,
  "start": false
}
```

API runtimes (`node-app`, `python-api`, `static-api`) automatically link a project-owned service at project creation. Linked services are validated against the `project_services` table — only services registered for a project can be controlled through its project routes.

---

## Database Schema

### Tables

| Table | Purpose |
|---|---|
| `users` | System accounts |
| `logs` | Activity audit log |
| `projects` | Project records with config, domain, port, git, ssl |
| `project_members` | Project role assignments |
| `project_envs` | Per-project key-value environment store |
| `project_services` | Per-project linked systemd service registry |

### New columns on `projects` (v0.2.0)

| Column | Type | Description |
|---|---|---|
| `domain` | VARCHAR(253) | Primary domain for nginx/ssl |
| `port` | SMALLINT UNSIGNED | App listen port |
| `git_repo_url` | VARCHAR(512) | Remote git URL |
| `git_branch` | VARCHAR(120) | Default branch (main) |
| `ssl_enabled` | TINYINT(1) | SSL provisioned flag |
| `nginx_config_path` | VARCHAR(512) | Path to generated nginx config |

All new columns are added idempotently at boot by `ensureProjectSchema()`.

---

## Backend Module Map

```
server.js                            ← Express app, boot, error handler
├── routes/
│   ├── auth.js
│   ├── system.js
│   ├── users.js
│   ├── services.js                  ← Global services (GET /, GET /:name/status, POST /:name/:action)
│   └── projects.js                  ← All project sub-resource routes
│
├── controllers/
│   ├── authController.js
│   ├── systemController.js
│   ├── userController.js
│   ├── projectController.js         ← Core CRUD + wizard config + delete cleanup
│   ├── projectSetupController.js    ← scaffold / nginx / ssl
│   ├── projectDatabaseController.js ← provision / tables / SQL query
│   ├── projectGitController.js      ← init / clone / pull / push / status
│   ├── projectEndpointController.js ← endpoint CRUD (stored in config_json)
│   ├── projectEnvController.js      ← env CRUD (project_envs table)
│   └── serviceController.js         ← global + project-linked service control
│
├── models/
│   ├── userModel.js
│   ├── logModel.js
│   ├── projectModel.js              ← ensureProjectSchema, CRUD, membership
│   ├── projectEnvModel.js           ← project_envs table + .env file writer
│   └── projectServiceModel.js       ← project_services table
│
├── middleware/
│   └── authMiddleware.js            ← authenticateToken, requireAdmin
│
├── config/
│   └── db.js                        ← MariaDB pool + query helper
│
└── errors/
    └── AppError.js                  ← Structured error with status + code
```

---

## Frontend Module Map

```
public/
├── dashboard.html                   ← Full SPA shell
├── login.html
├── style.css                        ← Design tokens, layout, all components
└── js/
    ├── pages/
    │   └── dashboard.js             ← Boot, auth, tab routing, module wiring
    │
    ├── dashboard/
    │   ├── state.js                 ← Shared mutable state (user, users, projects, selectedProject)
    │   ├── constants.js             ← Wizard presets, SQL editor presets
    │   ├── projects.js              ← Project card list, badge rendering, click events
    │   ├── services.js              ← Global services panel (fetched from API)
    │   ├── users.js                 ← Users table + member form sync
    │   ├── status.js                ← System metrics (CPU/RAM/disk)
    │   ├── forms.js                 ← Project modal + user form + member form
    │   ├── wizard.js                ← In-form DB/API wizard preset logic
    │   ├── projectDetail.js         ← Drawer orchestrator: tab switching + overview
    │   ├── projectSetup.js          ← Setup tab: scaffold / nginx / ssl
    │   ├── projectDatabase.js       ← Database tab: provision / tables / SQL editor
    │   ├── projectGit.js            ← Git tab: init / clone / pull / push / status
    │   ├── projectEndpoints.js      ← Endpoints tab: CRUD inline-edit table
    │   └── projectServices.js       ← Services tab: linked services + controls
    │
    └── shared/
        ├── api.js                   ← Fetch wrapper with JSON + error handling
        ├── auth.js                  ← isAdmin, redirectOnAuthError, clearSession
        ├── dom.js                   ← escapeHtml, setMeter, formatUptime
        └── errors.js                ← reportGlobalError, showGlobalMessage
```

---

## Security Notes

- All shell commands use `execFile` — never template strings passed to a shell.
- `ENABLE_SERVICE_CONTROL=true` must be explicitly set; all shell ops are gated.
- SQL query tool whitelists statement prefixes; blocks destructive admin commands.
- Database provisioning and project cleanup use privileged MariaDB credentials from `DB_ADMIN_*` when set; the normal app account in `DB_*` can remain least-privilege.
- Env variable values are **never returned** over the API; only key names + timestamps are listed.
- DB credentials (auto-generated password) are stored in `project_envs` and written to the `.env` file; never appear in API responses.
- Project service control validates that the service is registered in `project_services` for that project before running `systemctl`.
