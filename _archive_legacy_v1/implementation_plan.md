# EKAFY — Full Project Management Expansion

## Goal

Transform the existing skeleton into a complete, production-grade VPS project management dashboard. Every project becomes a self-contained unit with its own folder structure, nginx config, SSL, database, API endpoint registry, Git repo, and linked systemd service — all visible and controllable from the UI.

---

## User Review Required

> [!IMPORTANT]
> **Two open questions before execution — please answer these:**
>
> 1. **SSL provider**: Should automatic SSL use `certbot` (Let's Encrypt) or just generate self-signed certs for dev? *(Certbot requires a real domain on the public internet; self-signed works locally.)*
> 2. **Git auth**: Should Git push/pull use SSH keys (already on the VPS) or HTTPS with a token stored per-project? *(SSH is more secure for automation; HTTPS token is simpler to set up.)*

> [!WARNING]
> **Breaking DB change**: New columns will be added to the `projects` table (`domain`, `port`, `git_repo_url`, `git_branch`, `ssl_enabled`, `nginx_config_path`). The existing `ensureProjectSchema()` boot migration will be extended to add them safely — no existing data will be lost.

> [!NOTE]
> **Service control gating**: All shell operations (folder creation, nginx reload, certbot, git, systemctl) are gated by `ENABLE_SERVICE_CONTROL=true` and execute only on Linux. The existing safety guard is reused. On Windows, all shell calls return a clear "Linux only" error.

---

## Open Questions

1. **Default project root**: Projects currently require an explicit `/srv/` path. Should the system auto-generate the path as `/srv/<slug>` so the user only fills in the name and slug?
2. **DB user password**: When the DB wizard creates a MariaDB user, should it auto-generate a secure random password and store it in the project `.env`, or should the admin set it manually?
3. **Nginx template**: Should the wizard generate a Node.js reverse-proxy config (proxy to `localhost:<port>`), a static file server config, or let the user choose per project?

---

## Architecture Overview

```
server.js
├── routes/projects.js      ← extended with sub-resource routes
├── routes/services.js      ← extended with global list + project services
│
├── controllers/
│   ├── projectController.js          (existing, minor changes)
│   ├── projectSetupController.js     [NEW] folder/nginx/ssl/env
│   ├── projectDatabaseController.js  [NEW] DB wizard + table ops
│   ├── projectGitController.js       [NEW] git operations
│   ├── projectEndpointController.js  [NEW] endpoint CRUD
│   └── serviceController.js          (extended: project service registry)
│
├── models/
│   ├── projectModel.js       (extended: new columns)
│   ├── projectEnvModel.js    [NEW] per-project key-value env store
│   └── projectServiceModel.js[NEW] project ↔ systemd service links
│
└── public/
    ├── dashboard.html               (reworked: project detail panel)
    ├── style.css                    (extended)
    └── js/
        ├── dashboard/
        │   ├── projects.js          (reworked: cards + detail drawer)
        │   ├── projectSetup.js      [NEW]
        │   ├── projectDatabase.js   [NEW]
        │   ├── projectGit.js        [NEW]
        │   ├── projectEndpoints.js  [NEW]
        │   ├── projectServices.js   [NEW]
        │   ├── services.js          (extended: ekafy service list)
        │   ├── wizard.js            (extended: domain/port/git fields)
        │   └── forms.js             (extended)
        └── shared/
            └── api.js               (unchanged)
```

---

## Proposed Changes

### 1 — Database Schema Migration

#### [MODIFY] [database.sql](file:///c:/Users/Ranga/Desktop/Codex/srv/database.sql)

Add new tables. **New columns on `projects`** will be added at boot via extended `ensureProjectSchema()`:

- `domain VARCHAR(253)` — primary domain for this project
- `port SMALLINT UNSIGNED` — app listen port (e.g. 4001)
- `git_repo_url VARCHAR(512)` — remote git URL
- `git_branch VARCHAR(120) DEFAULT 'main'`
- `ssl_enabled TINYINT(1) DEFAULT 0`
- `nginx_config_path VARCHAR(512)` — absolute path to generated nginx conf

**New tables:**

```sql
-- Per-project environment variables (stored encrypted at rest is a future concern;
-- for now stored as plaintext but never returned in list endpoints)
CREATE TABLE IF NOT EXISTS project_envs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id INT UNSIGNED NOT NULL,
  env_key VARCHAR(128) NOT NULL,
  env_value TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY project_envs_unique (project_id, env_key),
  CONSTRAINT project_envs_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Links a project to one or more named systemd services
CREATE TABLE IF NOT EXISTS project_services (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id INT UNSIGNED NOT NULL,
  service_name VARCHAR(128) NOT NULL,
  label VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY project_services_unique (project_id, service_name),
  CONSTRAINT project_services_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

---

### 2 — Extended `projectModel.js`

#### [MODIFY] [projectModel.js](file:///c:/Users/Ranga/Desktop/Codex/srv/models/projectModel.js)

- Extend `ensureProjectSchema()` to add all 6 new columns to `projects` if missing.
- Extend `createProject()` to accept `domain`, `port`, `gitRepoUrl`, `gitBranch`.
- Add `updateProjectFields(id, fields)` for partial updates.
- Add `listAllProjects()` for admin view (no membership filter).

---

### 3 — New `projectEnvModel.js`

#### [NEW] `models/projectEnvModel.js`

```
upsertProjectEnv(projectId, key, value)
deleteProjectEnv(projectId, key)
listProjectEnvs(projectId)          → returns { key, updated_at }[] (no values in list)
getProjectEnv(projectId, key)       → returns { key, value }
```

---

### 4 — New `projectServiceModel.js`

#### [NEW] `models/projectServiceModel.js`

```
addProjectService(projectId, serviceName, label)
removeProjectService(projectId, serviceName)
listProjectServices(projectId)
```

---

### 5 — New `projectSetupController.js`

#### [NEW] `controllers/projectSetupController.js`

Handles the 3-phase setup after project record is created:

**Phase 1 — Folder scaffold** (`POST /api/projects/:id/setup/scaffold`):
```
/srv/<slug>/
  public/        ← web root
  logs/          ← app logs
  releases/      ← git deploy target
  shared/        ← shared config / uploads
  .env           ← project env file (auto-written from project_envs table)
```
Uses Node's `fs.mkdir` (recursive) — no shell dependency.

**Phase 2 — Nginx config** (`POST /api/projects/:id/setup/nginx`):
Generates an nginx server block from template (reverse-proxy or static), writes to `/etc/nginx/sites-available/<slug>`, symlinks to `sites-enabled`, runs `nginx -t && systemctl reload nginx`.
Template: reverse-proxy by default; static if project kind is `static`.

**Phase 3 — SSL certificate** (`POST /api/projects/:id/setup/ssl`):
Calls `certbot --nginx -d <domain> --non-interactive --agree-tos -m <email>` (email from `.env`). On failure, falls back to generating a self-signed cert with `openssl`.

Each phase updates the project record and writes a log entry. Phases are **idempotent** — safe to re-run.

---

### 6 — New `projectDatabaseController.js`

#### [NEW] `controllers/projectDatabaseController.js`

Routes under `/api/projects/:id/database/`:

| Route | Description |
|---|---|
| `POST /provision` | Creates MariaDB database + user, saves credentials to `project_envs` |
| `GET /tables` | Lists tables in the project database |
| `POST /query` | Runs an admin-provided SQL statement (whitelist: CREATE TABLE, ALTER TABLE, DROP TABLE, INSERT, SELECT) |
| `GET /presets` | Returns SQL preset templates (create-schema, seed, add-index, etc.) |

The DB connection for project queries uses the credentials stored in `project_envs` (not the EKAFY root user). Query results are returned as `{ columns, rows }` for the table UI.

> [!CAUTION]
> Only `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `INSERT`, `SELECT`, `UPDATE`, `DELETE` are allowed. Any statement containing `DROP DATABASE`, `DROP USER`, `GRANT`, or `FLUSH PRIVILEGES` is rejected at the controller level.

---

### 7 — New `projectGitController.js`

#### [NEW] `controllers/projectGitController.js`

Routes under `/api/projects/:id/git/`:

| Route | Description |
|---|---|
| `POST /init` | `git init` in project path + `git remote add origin <url>` |
| `GET /status` | `git status --short` + `git log --oneline -10` |
| `POST /pull` | `git pull origin <branch>` |
| `POST /push` | `git add -A && git commit -m "<message>" && git push origin <branch>` |
| `POST /clone` | `git clone <url> <path>` (for new projects) |

All commands use `execFile('git', [...])` — no shell string interpolation. Output returned as `{ stdout, stderr }`.

---

### 8 — New `projectEndpointController.js`

#### [NEW] `controllers/projectEndpointController.js`

Replaces the embedded endpoint array in `config_json` with a proper CRUD interface operating on the `config_json.api.endpoints` array (no new table needed — stays in the JSON blob for now):

| Route | Description |
|---|---|
| `GET /api/projects/:id/endpoints` | List all endpoints |
| `POST /api/projects/:id/endpoints` | Add endpoint |
| `PUT /api/projects/:id/endpoints/:idx` | Update endpoint by index |
| `DELETE /api/projects/:id/endpoints/:idx` | Remove endpoint |

Access: project manager or admin.

---

### 9 — Extended `serviceController.js`

#### [MODIFY] [serviceController.js](file:///c:/Users/Ranga/Desktop/Codex/srv/controllers/serviceController.js)

- Add `GET /api/services` → list all services from `SERVICE_MAP` with current status (replaces the hardcoded constant on the frontend).
- Add `GET /api/projects/:id/services` → list services linked to a project.
- Add `POST /api/projects/:id/services` → register a new service name for a project (admin only; adds to `SERVICE_MAP` whitelist dynamically and to `project_services` table).
- Add `DELETE /api/projects/:id/services/:name` → unlink.

---

### 10 — Extended Routes

#### [MODIFY] [routes/projects.js](file:///c:/Users/Ranga/Desktop/Codex/srv/routes/projects.js)

```
GET    /                       listProjects
POST   /                       requireAdmin → createManagedProject
GET    /:id/wizard             getProjectWizard
PATCH  /:id/config             updateProjectWizardConfig
PUT    /:id/members            setProjectMember
DELETE /:id/members/:userId    deleteProjectMember

POST   /:id/setup/scaffold     projectSetupController.scaffold
POST   /:id/setup/nginx        projectSetupController.generateNginx
POST   /:id/setup/ssl          projectSetupController.provisionSsl

POST   /:id/database/provision projectDatabaseController.provision
GET    /:id/database/tables    projectDatabaseController.listTables
POST   /:id/database/query     projectDatabaseController.runQuery
GET    /:id/database/presets   projectDatabaseController.getPresets

GET    /:id/git/status         projectGitController.status
POST   /:id/git/init           projectGitController.init
POST   /:id/git/pull           projectGitController.pull
POST   /:id/git/push           projectGitController.push
POST   /:id/git/clone          projectGitController.clone

GET    /:id/endpoints          projectEndpointController.list
POST   /:id/endpoints          projectEndpointController.add
PUT    /:id/endpoints/:idx     projectEndpointController.update
DELETE /:id/endpoints/:idx     projectEndpointController.remove

GET    /:id/services           serviceController.listProjectServices
POST   /:id/services           requireAdmin → serviceController.addProjectService
DELETE /:id/services/:name     requireAdmin → serviceController.removeProjectService

GET    /:id/env                projectEnvController.list    (keys only, no values)
PUT    /:id/env                projectEnvController.upsert  (admin/manager)
DELETE /:id/env/:key           projectEnvController.remove  (admin/manager)
```

#### [MODIFY] [routes/services.js](file:///c:/Users/Ranga/Desktop/Codex/srv/routes/services.js)

```
GET  /                  serviceController.listServices  (all registered services)
GET  /:name/status      serviceController.serviceStatus
POST /:name/:action     requireAdmin → serviceController.controlService
```

---

### 11 — Frontend Rebuild

#### [MODIFY] [dashboard.html](file:///c:/Users/Ranga/Desktop/Codex/srv/public/dashboard.html)

**New layout**: The Projects tab gets a split view:
- Left: project list (cards with status badges + quick stats)
- Right: project detail drawer (tabs: Overview | Setup | Database | Endpoints | Git | Services)

Project creation form moves into a modal/slide-in panel instead of inline on the page.

Services tab: now fetches service list from `/api/services` instead of a hardcoded frontend constant; each card shows which project it belongs to.

#### [MODIFY] `public/style.css`

New CSS for: drawer/panel, tab strip inside drawer, terminal-output `<pre>` blocks, status badges (active/inactive/pending/error), SQL query editor area, git log list, endpoint table with inline edit.

#### [NEW] Frontend JS modules

| File | Purpose |
|---|---|
| `js/dashboard/projectSetup.js` | Scaffold / nginx / ssl panel |
| `js/dashboard/projectDatabase.js` | DB provision + table list + query editor |
| `js/dashboard/projectGit.js` | Git status + pull/push/clone UI |
| `js/dashboard/projectEndpoints.js` | Endpoint CRUD table with inline edit |
| `js/dashboard/projectServices.js` | Project-linked services + controls |
| `js/dashboard/projectDetail.js` | Orchestrates the detail drawer |

---

## Verification Plan

### Automated Checks
```bash
node --check server.js            # syntax check
node --check controllers/*.js
node server.js                    # boot + DB migration check (MariaDB must be running)
```

### Manual Verification (Linux VPS or WSL)
1. Create project → verify folder structure created at `/srv/<slug>/`
2. Run nginx setup → verify config file at `/etc/nginx/sites-available/<slug>` and `nginx -t` passes
3. Provision DB → verify database + user exist in MariaDB
4. Add SQL table via query tool → verify in MariaDB shell
5. Init git + pull → verify `.git/` created and files pulled
6. Add endpoint → edit endpoint → delete endpoint → verify persisted in `config_json`
7. Register project service → verify it appears in Services tab with start/stop/restart controls
8. All actions logged to `logs` table
