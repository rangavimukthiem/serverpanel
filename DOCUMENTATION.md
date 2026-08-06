# EKAFY Operations Guide

This guide explains how to install, configure, operate, and troubleshoot the
EKAFY VPS Control Panel. It is intended for server administrators and developers
deploying projects through EKAFY.

## Contents

1. [Overview](#overview)
2. [Requirements](#requirements)
3. [Production installation](#production-installation)
4. [Manual and local setup](#manual-and-local-setup)
5. [Environment configuration](#environment-configuration)
6. [First login and authentication](#first-login-and-authentication)
7. [Dashboard sections](#dashboard-sections)
8. [Creating and deploying a project](#creating-and-deploying-a-project)
9. [Runtime types](#runtime-types)
10. [Nginx, DNS, and SSL](#nginx-dns-and-ssl)
11. [Database configuration](#database-configuration)
12. [Git deployment](#git-deployment)
13. [Services](#services)
14. [Backups and restore](#backups-and-restore)
15. [Users and permissions](#users-and-permissions)
16. [Updates and maintenance](#updates-and-maintenance)
17. [Security checklist](#security-checklist)
18. [Troubleshooting](#troubleshooting)

## Overview

EKAFY is a lightweight web control panel for managing applications on a Linux
VPS. The backend uses Node.js, Express, and MariaDB. The browser interface uses
plain HTML, CSS, and JavaScript.

EKAFY manages:

- Server health and service status.
- Static, Node.js, Python, PHP, WordPress, and combined frontend/API projects.
- Project folders, Nginx virtual hosts, and Let's Encrypt certificates.
- Git repositories and deployment operations.
- MariaDB databases and per-project database users.
- Project environment variables and documented API endpoints.
- Project-owned systemd services and resource limits.
- Local backups, optional Google Drive copies, and restore operations.
- Panel users, global roles, and project memberships.

EKAFY does not generate complete application business logic. Your repository
must contain code appropriate for the selected runtime.

## Requirements

Recommended production platform:

- Ubuntu or Debian VPS with systemd.
- Root or sudo access during installation.
- A domain whose DNS points to the VPS.
- Node.js 20 or newer.
- MariaDB, Nginx, Git, and Certbot.
- PHP-FPM when hosting PHP or WordPress projects.
- `rclone` only when Google Drive backup replication is required.

The installer can provision the normal server packages. Windows and macOS are
suitable for interface and API development, but systemd, Nginx, Certbot, and
Linux project provisioning cannot be fully exercised there.

## Production installation

Clone the repository and run the initializer:

```bash
git clone https://github.com/rangavimukthiem/serverpanel.git
cd serverpanel
sudo bash init.sh --domain dashboard.example.com --ssl-email admin@example.com
```

Useful alternatives:

```bash
# Install without requesting a certificate yet
sudo bash init.sh --domain dashboard.example.com --skip-ssl

# Select a different application directory
sudo bash init.sh --app-dir /srv/ekafy

# Install without system service controls
sudo bash init.sh --disable-service-control
```

The installer creates the application user, MariaDB accounts, `.env`, systemd
unit, Nginx configuration, optional certificate, and restricted sudo rules.

After installation, verify the service:

```bash
sudo systemctl status ekafy
curl http://127.0.0.1:3000/health
sudo nginx -t
```

The health endpoint should return an object containing `"ok": true`.

## Manual and local setup

Install dependencies and create the database:

```bash
npm install
mysql -u root -p < database.sql
cp .env.example .env
```

Edit `.env`, then start the development server:

```bash
npm run dev
```

Open `http://localhost:3000/login.html`.

For production, use `npm start` under systemd instead of leaving a terminal
session running.

## Environment configuration

Use `.env.example` as the canonical template. A production configuration looks
like this:

```env
HOST=127.0.0.1
PORT=3000
NODE_ENV=production
APP_DIR=/srv/ekafy
SERVICE_NAME=ekafy

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ekafy
DB_PASSWORD=replace-with-a-strong-password
DB_NAME=ekafy
DB_ADMIN_HOST=127.0.0.1
DB_ADMIN_PORT=3306
DB_ADMIN_USER=ekafy_admin
DB_ADMIN_PASSWORD=replace-with-a-separate-strong-password

JWT_SECRET=replace-with-a-long-random-secret
JWT_EXPIRES_IN=8h
ALLOW_REGISTRATION=false

GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://dashboard.example.com/api/auth/google/callback
GOOGLE_OAUTH_ALLOW_SIGNUP=false
GOOGLE_OAUTH_ALLOWED_EMAILS=
GOOGLE_OAUTH_ALLOWED_DOMAINS=

ENABLE_SERVICE_CONTROL=true
PROJECTS_ROOT=/srv
SSL_EMAIL=admin@example.com
ALLOW_SELF_SIGNED_SSL=false
PHP_FPM_SOCKET=/run/php/php8.1-fpm.sock

PROJECT_SERVICE_USER=ekafy
PROJECT_SERVICE_GROUP=ekafy
PROJECT_SERVICE_NPM_BIN=/usr/bin/npm
PROJECT_SERVICE_NODE_BIN=/usr/bin/node
PROJECT_SERVICE_PYTHON_BIN=/usr/bin/python3

EXCEL_IMPORT_MAX_BYTES=10485760
EXCEL_IMPORT_MAX_ROWS=5000

BACKUP_ROOT=/srv/ekafy/backups
GOOGLE_DRIVE_REMOTE=
MARIADB_DUMP_BIN=mariadb-dump
MARIADB_BIN=mariadb
```

### Variable groups

| Group | Purpose |
| --- | --- |
| `HOST`, `PORT` | Address and port used by the Express server. Use `127.0.0.1` behind Nginx. |
| `APP_DIR`, `SERVICE_NAME` | Installed panel location and its systemd unit name. |
| `DB_*` | Normal control-panel database connection. |
| `DB_ADMIN_*` | Privileged connection used to provision and remove project databases/users. |
| `JWT_*` | Session signing secret and lifetime. Changing the secret signs out all users. |
| `GOOGLE_OAUTH_*` | Google login credentials, callback, signup policy, and allowlists. |
| `ENABLE_SERVICE_CONTROL` | Enables Linux service, Nginx, Certbot, and cleanup operations. |
| `PROJECTS_ROOT` | Parent directory within which managed project paths must remain. |
| `SSL_EMAIL` | Email passed to Certbot. |
| `PHP_FPM_SOCKET` | Installed PHP-FPM Unix socket. Verify the PHP version on the server. |
| `PROJECT_SERVICE_*` | User, group, and executable paths used in generated systemd units. |
| `EXCEL_IMPORT_*` | Spreadsheet database-import limits. |
| `BACKUP_ROOT` | Private local archive directory. |
| `GOOGLE_DRIVE_REMOTE` | Optional configured rclone destination. |

After changing `.env`, restart the panel:

```bash
sudo systemctl restart ekafy
sudo journalctl -u ekafy -n 100 --no-pager
```

## First login and authentication

The installer can create the initial administrator. For a manual installation,
temporarily allow registration, create the first account, and disable it again:

```env
ALLOW_REGISTRATION=true
```

```bash
curl -X POST http://127.0.0.1:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"use-a-unique-long-password","role":"admin"}'
```

Set `ALLOW_REGISTRATION=false` and restart EKAFY immediately afterward.

### Google login

1. Create a Web application OAuth client in Google Cloud.
2. Register the exact callback URL shown in `GOOGLE_OAUTH_REDIRECT_URI`.
3. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
4. Decide whether new Google identities may create users with
   `GOOGLE_OAUTH_ALLOW_SIGNUP`.
5. Optionally restrict access with comma-separated email or domain allowlists.
6. Restart EKAFY and reload the login page.

The callback URI is case-sensitive and must match the scheme, hostname, path,
and port exactly. Keep signup disabled unless automatic account creation is
intended.

## Dashboard sections

### Dashboard

The overview shows CPU, RAM, disk, uptime, network identity, OS, Node.js version,
load averages, and project totals. Use it for a quick health check, not as a
replacement for long-term monitoring.

The top bar also provides the theme selector. The selected theme is stored in
the browser and is shared with the login page.

### Services

This section lists recognized host services and project-linked systemd units.
It reports state, PID, memory, CPU time, tasks, restart count, and unit paths.
Administrators can start, stop, restart, or reload supported services and set
resource limits on project units. Nginx is reloaded instead of restarted.

### System Logs

System Logs displays recent service journal output. Select a supported service
to diagnose startup errors, crashes, and configuration problems. Sensitive data
may appear in application logs, so access should remain authenticated.

### Projects

Projects is the main workspace. Each project stores its name, slug, filesystem
path, domain, runtime, port, Git settings, status, configuration, and members.

The project detail tools cover:

- Wizard configuration and runtime selection.
- Folder scaffolding.
- Nginx and SSL setup.
- Git initialization, clone, pull, forced pull, push, and remote removal.
- Database provisioning, table browsing, restricted SQL, and spreadsheet import.
- Per-project environment variables.
- API endpoint documentation.
- Linked systemd services.
- Member assignments and project roles.

Deleting a project can remove files, database accounts, Nginx configuration,
certificates, and systemd units. Review the target path and cleanup summary.

### Backups & Restore

Administrators can create per-project backup rules, run backups immediately,
review history, and restore completed archives. Rules may include files,
database content, or both, with manual, daily, or weekly schedules and retention.
Every restore first attempts a safety backup of the current project.

### Users

Administrators can create accounts, change global roles, delete users, search,
and assign project membership. Avoid sharing administrator accounts; assign the
lowest role needed for normal work.

## Creating and deploying a project

Recommended sequence:

1. Open **Projects** and create a record.
2. Choose the runtime, unique slug, path under `PROJECTS_ROOT`, domain, and port.
3. Save the wizard configuration.
4. Scaffold the folder structure or clone an existing repository.
5. Install application dependencies inside the project directory.
6. Add required project environment variables.
7. Provision a database if the application needs one.
8. Create and link a systemd service for a dynamic backend.
9. Generate the Nginx configuration and verify it with `nginx -t`.
10. Point DNS to the server and provision SSL.
11. Confirm the application and its `/api` routes from an external browser.
12. Configure backups before placing the project into production.

Use a unique port for each Node.js or Python backend. Do not expose backend ports
publicly when Nginx can proxy them through `127.0.0.1`.

## Runtime types

| Runtime | Use case | Nginx behavior |
| --- | --- | --- |
| `static-site` | HTML, CSS, and browser JavaScript | Serves the project's `public` directory. |
| `static-api` | Static frontend plus separate API process | Serves frontend files and proxies `/api/` to the project port. |
| `node-app` | Express or another Node.js server | Proxies requests to the configured local port. |
| `python-api` | Flask, FastAPI, Django, or similar | Proxies requests to the configured local port. |
| `php-site` | PHP application | Serves files and forwards PHP requests to PHP-FPM. |
| `wordpress-site` | WordPress or WooCommerce | Uses a WordPress-oriented PHP/Nginx configuration. |

For dynamic runtimes, ensure the application listens on the configured port and
prefer binding it to `127.0.0.1`.

## Nginx, DNS, and SSL

Before requesting a certificate:

1. Create an A or AAAA record for the project domain.
2. Confirm the record resolves to the VPS.
3. Ensure ports 80 and 443 are allowed by the firewall.
4. Generate the Nginx configuration.
5. Run `sudo nginx -t`.
6. Provision the certificate from the project setup screen.

For Cloudflare, use Full (strict) after a valid origin certificate exists. Keep
`ALLOW_SELF_SIGNED_SSL=false` in production. A Cloudflare 520 commonly indicates
that Nginx or the upstream application stopped responding; inspect both logs.

## Database configuration

EKAFY itself uses the `DB_*` connection. The database wizard uses `DB_ADMIN_*`
to create isolated project databases and users, then stores the project
credentials as project environment variables.

Spreadsheet imports are bounded by `EXCEL_IMPORT_MAX_BYTES` and
`EXCEL_IMPORT_MAX_ROWS`. The SQL interface blocks privileged and dangerous
server-level operations, but changes to project data may still be destructive.
Create a backup before migrations or bulk imports.

## Git deployment

Configure a repository URL and branch in the project wizard. Public repositories
can use HTTPS. Private repositories require credentials available to the EKAFY
service user, preferably an SSH deploy key with only the necessary repository
permissions.

A normal update flow is:

1. Check status.
2. Pull the configured branch.
3. Install dependencies or run migrations when required.
4. Restart the linked project service.
5. Verify application and service health.

Forced pull discards conflicting project working-tree changes. Use it only when
the deployed folder is not the source of truth.

## Services

Set `ENABLE_SERVICE_CONTROL=true` only on the intended Linux host. Generated
project units run as `PROJECT_SERVICE_USER` and `PROJECT_SERVICE_GROUP`. Verify
that this account can read the project and write only the directories the app
needs.

Useful diagnostics:

```bash
sudo systemctl status project-service-name
sudo journalctl -u project-service-name -n 100 --no-pager
sudo systemctl daemon-reload
```

## Backups and restore

Create and protect the local archive directory:

```bash
sudo install -d -o ekafy -g ekafy -m 700 /srv/ekafy/backups
```

For Google Drive replication, configure rclone as the service user:

```bash
sudo -u ekafy -H rclone config
sudo -u ekafy -H rclone lsd gdrive:
```

Then configure and restart:

```env
BACKUP_ROOT=/srv/ekafy/backups
GOOGLE_DRIVE_REMOTE=gdrive:EKAFY Backups
```

Archives exclude `.git`, `node_modules`, and nested `backups` directories.
Database backups require valid database variables stored for the project.
Regularly test restore on a non-production project; an untested backup is not a
verified recovery plan.

## Users and permissions

Global roles:

- `admin`: panel-wide management, including destructive and host operations.
- `user`: limited to accessible project functionality.

Project roles:

- `manager`: manages permitted settings for assigned projects.
- `user`: views or uses assigned project capabilities.

Browser authentication uses the HTTP-only `ekafy_token` JWT cookie. The API also
accepts a bearer token. Sessions expire according to `JWT_EXPIRES_IN`.

## Updates and maintenance

Use **Update manager** to fast-forward the installed checkout, install production
dependencies, and restart EKAFY. It preserves `.env`, databases, and managed
project directories. A command-line update is also available:

```bash
sudo bash /srv/ekafy/init.sh --update \
  --app-dir /srv/ekafy \
  --repo-url https://github.com/rangavimukthiem/serverpanel.git \
  --branch main
```

Routine checks:

```bash
sudo systemctl status ekafy
sudo journalctl -u ekafy -n 100 --no-pager
sudo nginx -t
sudo certbot certificates
curl https://dashboard.example.com/health
```

Back up `.env` securely before manual changes. Never commit it to Git.

## Security checklist

- Rotate all credentials that have been pasted into chat, tickets, or logs.
- Use different strong passwords for normal and administrative DB accounts.
- Generate a long random `JWT_SECRET` and keep `.env` mode `600`.
- Keep `ALLOW_REGISTRATION=false` after creating the first administrator.
- Restrict Google signup and use email/domain allowlists when appropriate.
- Put EKAFY behind HTTPS and bind its Node process to `127.0.0.1`.
- Keep `ALLOW_SELF_SIGNED_SSL=false` for production.
- Enable service control only when installer-created sudo rules are present.
- Do not expose MariaDB or application backend ports to the public internet.
- Review project paths before deletion or restore.
- Patch the OS, Node.js, MariaDB, Nginx, and application dependencies regularly.
- Store backups outside the VPS and test recovery periodically.

## Troubleshooting

### Google login is disabled

Confirm the three required `GOOGLE_OAUTH_*` values, verify the exact Google Cloud
redirect URI, restart EKAFY, and check `/api/auth/google/status`.

### Database connection fails

Test the configured account directly:

```bash
mariadb -h 127.0.0.1 -P 3306 -u ekafy -p ekafy
```

Check both normal and admin credentials and remove stale socket variables if the
server should use TCP.

### Backups fail to load

Update to a version whose backup queries return unique column names, restart the
service, and inspect `journalctl`. Also verify that startup successfully created
the `backup_rules` and `backup_runs` tables.

### Backup creation fails

Check `BACKUP_ROOT` ownership, available disk space, project path validation,
database credentials, `mariadb-dump`, `tar`, and the rclone remote if enabled.

### Nginx setup or SSL fails

Run `sudo nginx -t`, verify DNS, inspect `/var/log/nginx/error.log`, and confirm
that the configured domain reaches this server on ports 80 and 443.

### A project service will not start

Inspect its journal, confirm executable paths and working directory, validate its
project `.env`, and run its start command manually as the configured service user.

### The dashboard cannot reach the API

Check EKAFY, Nginx, and the health endpoint:

```bash
sudo systemctl status ekafy
curl http://127.0.0.1:3000/health
sudo nginx -t
sudo tail -n 100 /var/log/nginx/error.log
```

For endpoint-level details, consult [FUNCTIONS.md](FUNCTIONS.md). The longer
[README.md](README.md) contains runtime examples and implementation notes.
