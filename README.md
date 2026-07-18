# EKAFY VPS Control Panel

EKAFY is a lightweight VPS control panel for hosting and managing projects on a Linux VPS. It provides a browser dashboard for projects, users, services, Git deployments, Nginx configs, SSL certificates, databases, environment variables, and project-level API endpoint documentation.

The backend is built with Express and MariaDB. The frontend is plain HTML, CSS, and JavaScript. EKAFY is designed to run behind Nginx on a VPS, usually from `/srv/ekafy`.

For a route-by-route API reference, see [FUNCTIONS.md](FUNCTIONS.md).

## What EKAFY Manages

EKAFY manages the control panel and the deployment metadata for your hosted projects.

It can:

- Create users and assign project roles.
- Create project records with domain, runtime, path, port, Git branch, and config.
- Scaffold project folders such as `public/`, `logs/`, `releases/`, `shared/`, and `config/`.
- Generate Nginx configs for static sites, API apps, PHP apps, WordPress, and static frontend plus API projects.
- Provision Let's Encrypt SSL certificates with Certbot.
- Clone, pull, and push Git repositories inside project paths.
- Provision MariaDB databases and users for projects.
- Store project environment variables and write project `.env` files.
- Link project-owned systemd services and control them from the dashboard.
- Show server metrics, server IP, server time, resource usage, project counts, and service resource details.
- Remove projects and clean up related Nginx, systemd, database, Git, API registry, and project files.

EKAFY does not automatically write your application code. Your project repository still needs to include the correct frontend/backend files for the runtime you selected.

## Architecture

There are two separate API flows.

### 1. EKAFY Control Panel API

This is the API used by the EKAFY dashboard itself.

```txt
Browser dashboard
  -> https://panel.example.com/api/projects
  -> Nginx
  -> EKAFY Node app on 127.0.0.1:3000
  -> Express route
  -> Controller
  -> MariaDB / systemctl / nginx / git / certbot
```

Important files:

```txt
server.js                         Express app and route mounting
routes/                           API route definitions
controllers/                      Request handlers
models/                           MariaDB data access
middleware/authMiddleware.js      JWT/session protection
public/js/shared/api.js           Frontend fetch wrapper
```

The frontend calls API routes with:

```js
api('/api/projects')
```

The browser sends the `ekafy_token` cookie automatically because the fetch wrapper uses:

```js
credentials: 'include'
```

### 2. Hosted Project App API

This is the API for your own hosted project.

For a `Static site + API` project such as:

```txt
Domain: slbftracker.ekafy.com
Path: /srv/slbftracker
Port: 4001
Runtime: static-api
```

the flow is:

```txt
Visitor browser
  -> https://slbftracker.ekafy.com/
  -> Nginx serves /srv/slbftracker/public/index.html

Visitor browser
  -> https://slbftracker.ekafy.com/api/health
  -> Nginx location /api/
  -> http://127.0.0.1:4001/api/health
  -> Your app server
```

Your frontend should call:

```js
fetch('/api/health')
```

Do not call this from browser code:

```js
fetch('http://127.0.0.1:4001/api/health')
```

In the visitor's browser, `127.0.0.1` means the visitor's own computer, not your VPS.

## Requirements

Recommended production server:

- Ubuntu or Debian VPS
- Node.js 20
- MariaDB
- Nginx
- Certbot
- Git
- systemd

Local development can run on Windows/macOS/Linux, but shell operations such as `systemctl`, Nginx reloads, Certbot, and project scaffolding are intended for Linux VPS use.

## Quick Production Install

Clone this repository on your VPS:

```bash
git clone https://github.com/rangavimukthiem/srv.git
cd srv
sudo bash init.sh
```

Install with Nginx and SSL for a dashboard domain:

```bash
sudo bash init.sh --domain dashboard.example.com --ssl-email admin@example.com
```

Install to a custom app directory:

```bash
sudo bash init.sh --app-dir /srv/ekafy
```

Skip SSL during setup:

```bash
sudo bash init.sh --domain dashboard.example.com --skip-ssl
```

Disable service controls:

```bash
sudo bash init.sh --disable-service-control
```

The initializer does the heavy lifting:

- Installs required packages.
- Creates the Linux app user.
- Copies the repository to the app directory.
- Backs up existing `.env` files.
- Creates MariaDB database and users.
- Writes `.env`.
- Installs Node dependencies.
- Creates and starts the `ekafy` systemd service.
- Optionally configures Nginx.
- Optionally provisions SSL.
- Optionally creates the first admin user.
- Writes sudoers rules for allowed service, Nginx, Certbot, cleanup, and resource-limit operations.

## Manual Local Setup

Install dependencies:

```bash
npm install
```

Create the database:

```bash
mysql -u root -p < database.sql
```

Create `.env`:

```bash
cp .env.example .env
```

Edit `.env` with your local MariaDB credentials and a strong `JWT_SECRET`.

Start in dev mode:

```bash
npm run dev
```

Open:

```txt
http://localhost:3000/login.html
```

## Environment Variables

Common variables:

```env
PORT=3000
NODE_ENV=production

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ekafy
DB_PASSWORD=change-me
DB_NAME=ekafy

DB_ADMIN_HOST=127.0.0.1
DB_ADMIN_PORT=3306
DB_ADMIN_USER=ekafy_admin
DB_ADMIN_PASSWORD=change-me-admin

JWT_SECRET=replace-with-a-long-random-secret
JWT_EXPIRES_IN=8h
ALLOW_REGISTRATION=false

ENABLE_SERVICE_CONTROL=true
PROJECTS_ROOT=/srv
SERVER_IP=your.public.server.ip

SSL_EMAIL=admin@example.com
ALLOW_SELF_SIGNED_SSL=false
PHP_FPM_SOCKET=/run/php/php8.1-fpm.sock
```

Important notes:

- `ENABLE_SERVICE_CONTROL=true` is required for systemctl, Nginx, Certbot, project cleanup, and resource limit operations.
- Keep `ALLOW_SELF_SIGNED_SSL=false` when using Cloudflare Full (strict).
- `PROJECTS_ROOT=/srv` means project paths must be inside `/srv`.
- `SERVER_IP` is optional. If set, the dashboard shows it instead of auto-detected network IPs.
- `DB_ADMIN_*` is used for privileged database provisioning and cleanup.
- Normal app database access should use `DB_*`.

## First Admin User

The installer can create the first admin user for you. If doing it manually, register once:

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"change-this-password","role":"admin"}'
```

After the first user exists, registration is blocked unless:

```env
ALLOW_REGISTRATION=true
```

For production, keep it false.

## Useful Server Commands

Check EKAFY service:

```bash
sudo systemctl status ekafy
```

Watch EKAFY logs:

```bash
sudo journalctl -u ekafy -f
```

Restart EKAFY:

```bash
sudo systemctl restart ekafy
```

Reload Nginx safely:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

View Nginx generated config:

```bash
sudo nginx -T
```

Check SSL certificates:

```bash
sudo certbot certificates
```

## Dashboard Sections

### Dashboard

Shows:

- CPU usage
- RAM usage
- Disk usage
- Uptime
- Server IP
- Hostname
- Panel host
- OS and architecture
- Node version
- Server time and timezone
- CPU model and core count
- Memory used and total
- Disk used and total
- Load average
- Total projects
- Active, inactive, and provisioned project counts
- Project type summary

### Services

Shows two service groups:

- Global host services: `nginx`, `mysql`, `mariadb`, `apache2`
- EKAFY project-linked services from the `project_services` table

For each service, the dashboard can show:

- Active state
- PID
- Memory usage and memory limit
- CPU time and CPU limit
- Tasks usage and task limit
- Restart count
- Unit file path

Admin controls:

- Start
- Reload Nginx
- Restart non-Nginx services
- Stop
- Adjust CPU, memory, and task limits for EKAFY project services

Nginx uses reload instead of restart from the dashboard because restarting Nginx can interrupt the dashboard request and cause Cloudflare `520`.

### Projects

Project records store:

- Name
- Slug
- Path
- Domain
- Port
- Status
- Runtime
- Git repo URL
- Git branch
- SSL enabled flag
- Nginx config path
- Project config JSON
- Members
- Environment variable keys
- API endpoint registry
- Linked systemd services

Project management actions:

- Disable project
- Enable project
- Remove project

Removing a project attempts to wipe:

- Project database and DB user
- Nginx config and enabled link
- SSL certificate
- Linked systemd services and unit files
- Project files
- Project database record
- API endpoint registry
- Env records
- Project service links
- Project memberships

Cleanup warnings are returned if a system action cannot be completed.

### Users

Admin users can:

- Create users
- Change user roles
- Delete users
- Search users
- Assign users to projects
- Set project member role as `manager` or `user`

Project managers can manage some project-level settings for projects they belong to.

## Project Runtimes

EKAFY supports these runtime types.

### Static HTML/CSS/JS

Use for simple websites.

Nginx serves:

```txt
/srv/project-name/public
```

Repo layout:

```txt
my-static-site/
├── public/
│   ├── index.html
│   ├── style.css
│   ├── app.js
│   └── assets/
└── README.md
```

No private app port is required.

### Static Site + API

Use for a frontend plus a backend API.

Nginx serves frontend files from:

```txt
/srv/project-name/public
```

Nginx proxies `/api/` to:

```txt
http://127.0.0.1:<project-port>
```

Repo layout:

```txt
my-static-api/
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── server.js
├── package.json
├── .env.example
└── README.md
```

Frontend API calls:

```js
fetch('/api/health')
fetch('/api/login')
fetch('/api/items')
```

Example Express API:

```js
const express = require('express');

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`API running on 127.0.0.1:${PORT}`);
});
```

Example `package.json`:

```json
{
  "name": "my-static-api",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.21.2"
  }
}
```

### Node.js App/API

Use when the entire app is served by Node.

Nginx proxies `/` to:

```txt
http://127.0.0.1:<project-port>
```

Repo layout:

```txt
my-node-app/
├── server.js
├── package.json
├── public/
└── README.md
```

Your app must listen on the assigned port and preferably on `127.0.0.1`.

### Python API/App

Use when the app is served by Python.

Nginx proxies `/` to:

```txt
http://127.0.0.1:<project-port>
```

Repo layout example:

```txt
my-python-api/
├── app.py
├── requirements.txt
├── .env.example
└── README.md
```

You need your own systemd service to run the Python app.

### PHP Site

Use when Nginx should pass PHP requests to PHP-FPM.

Nginx serves:

```txt
/srv/project-name/public
```

and sends PHP files to:

```txt
/run/php/php8.1-fpm.sock
```

Repo layout:

```txt
my-php-site/
├── public/
│   ├── index.php
│   └── assets/
└── README.md
```

### WordPress / WooCommerce

Use for WordPress-like PHP apps with a database.

Nginx root:

```txt
/srv/project-name/public
```

Database wizard should be enabled for this runtime.

## Project Folder Structure

When you scaffold a project, EKAFY creates:

```txt
/srv/project-name
├── config/
├── logs/
│   ├── access.log
│   └── error.log
├── public/
├── releases/
└── shared/
```

For static and PHP-based projects, public web files must be inside:

```txt
/srv/project-name/public
```

Incorrect for static site:

```txt
/srv/project-name/index.html
```

Correct:

```txt
/srv/project-name/public/index.html
```

For `Static site + API`, the frontend goes in `public/` and the backend files go in the project root.

## Git Deployment Flow

EKAFY Git actions run inside the project path.

If project path is:

```txt
/srv/slbftracker
```

then Git clone runs into:

```txt
/srv/slbftracker
```

That means your repository should already contain the correct structure:

```txt
repo/
├── public/
│   └── index.html
├── server.js
└── package.json
```

Git endpoints:

- Status: `GET /api/projects/:id/git/status`
- Init: `POST /api/projects/:id/git/init`
- Clone: `POST /api/projects/:id/git/clone`
- Pull: `POST /api/projects/:id/git/pull`
- Push: `POST /api/projects/:id/git/push`

For private GitHub repositories, configure SSH keys or HTTPS credentials for the Linux user running EKAFY.

Recommended SSH check:

```bash
sudo -u ekafy ssh -T git@github.com
```

## Creating a Project in EKAFY

Basic flow:

1. Open dashboard.
2. Go to Projects.
3. Click New.
4. Enter name, slug, path, domain, runtime, and port if required.
5. Create project.
6. Open the project detail drawer.
7. Run scaffold.
8. Configure Git and clone/pull repository.
9. Generate Nginx config.
10. Provision SSL.
11. If the project has a backend API, create a systemd service for it.
12. Link the systemd service in the project Services tab.
13. Start the service.
14. Test the domain.

## Example: Static Site

Project settings:

```txt
Name: ekappz
Domain: ekappz.ekafy.com
Path: /srv/ekappz
Runtime: Static HTML/CSS/JS
Port: not required
```

Repository:

```txt
ekappz/
├── public/
│   ├── index.html
│   ├── app-ads.txt
│   ├── logo.png
│   └── assets/
└── README.md
```

Nginx serves:

```txt
/srv/ekappz/public
```

## Example: Static Site + API

Project settings:

```txt
Name: slbftracker
Domain: slbftracker.ekafy.com
Path: /srv/slbftracker
Runtime: Static site + API
Port: 4001
```

Repository:

```txt
slbftracker/
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── server.js
├── package.json
├── .env.example
└── README.md
```

Frontend calls:

```js
fetch('/api/health')
```

Backend listens:

```txt
127.0.0.1:4001
```

## Systemd Service for a Project API

Example service file:

```ini
[Unit]
Description=SLBF Tracker API
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/slbftracker
EnvironmentFile=/srv/slbftracker/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
```

For API runtimes, EKAFY creates and enables a project-owned systemd unit during project creation. The default unit name is the project slug, and the default command is `npm start` for Node/static API projects or `python3 app.py` for Python projects.

To create or update a unit later:

1. Open the project.
2. Go to Services.
3. Click `+ Service`.
4. Enter the service name, label, and ExecStart command.
5. Keep `Create/update unit` checked, then save.

Use the project Services tab to Start, Restart, Stop, or rewrite the unit.

## Nginx Behavior by Runtime

### `static-site`

```nginx
root /srv/project/public;
location / {
    try_files $uri $uri/ /index.html;
}
```

### `static-api`

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:PORT;
}

root /srv/project/public;
location / {
    try_files $uri $uri/ /index.html;
}
```

### `node-app` and `python-api`

```nginx
location / {
    proxy_pass http://127.0.0.1:PORT;
}
```

### `php-site` and `wordpress-site`

```nginx
root /srv/project/public;
location ~ \.php$ {
    fastcgi_pass unix:/run/php/php8.1-fpm.sock;
}
```

## SSL and Cloudflare

For normal Let's Encrypt:

1. DNS record must point to the VPS.
2. Nginx config must exist and pass `nginx -t`.
3. Certbot provisions the certificate.
4. EKAFY marks `ssl_enabled`.

For Cloudflare Full (strict):

- The origin certificate must be trusted.
- Keep `ALLOW_SELF_SIGNED_SSL=false`.
- Do not rely on self-signed fallback.
- The certificate must cover the exact hostname.

These are different hostnames:

```txt
ekappz.ekafy.com
www.ekappz.ekafy.com
```

If you want both, DNS, Nginx, and SSL must include both.

Useful commands:

```bash
dig +short app.example.com
sudo nginx -T | grep -n "server_name .*app"
sudo certbot certificates
curl -I https://app.example.com/
```

## Database Wizard

The Database Wizard stores project database configuration and can provision a MariaDB database and user.

Provision creates:

- Database
- Database user
- Random password
- Grants for the project database
- Project env records
- Project `.env` entries

The password is not returned in API responses.

Typical env output:

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=myapp_db
DB_USER=myapp_user
DB_PASSWORD=generated-password
```

MariaDB and MySQL note:

- EKAFY itself uses the `mariadb` Node package.
- MariaDB is the expected default on the VPS.
- MySQL-compatible SQL works for most app usage.
- In the wizard, prefer MariaDB unless your server is truly running MySQL.

## API Endpoint Registry

The API Wizard and Endpoints tab are a registry/documentation feature.

They do not create backend code automatically.

They help you define planned endpoints such as:

```txt
GET /api/health
POST /api/auth/login
GET /api/items
POST /api/items
```

These records are stored in the project config JSON:

```txt
projects.config_json.api.endpoints
```

Your project backend must still implement those routes.

## Authentication and Roles

EKAFY uses JWT authentication.

Login flow:

```txt
POST /api/auth/login
  -> verifies username/password
  -> signs JWT
  -> sets httpOnly cookie ekafy_token
```

Protected request flow:

```txt
Browser sends ekafy_token cookie
  -> authenticateToken middleware
  -> jwt.verify
  -> find user in database
  -> req.user is attached
  -> route handler runs
```

Global roles:

- `admin`: full panel access.
- `user`: limited access to assigned projects.

Project roles:

- `manager`: can manage project settings.
- `user`: can view assigned project details.

## Main API Routes

Public:

```txt
GET  /health
POST /api/auth/login
POST /api/auth/register
POST /api/auth/logout
```

Authenticated:

```txt
GET /api/auth/me
GET /api/system/status
GET /api/projects
GET /api/services
```

Admin:

```txt
GET    /api/users
POST   /api/users
PATCH  /api/users/:id/role
DELETE /api/users/:id
POST   /api/projects
DELETE /api/projects/:id
PATCH  /api/projects/:id/status
POST   /api/projects/:id/services/:name/unit
POST   /api/services/:name/:action
PATCH  /api/services/ekafy/:name/limits
```

Project manager/member routes are documented in [FUNCTIONS.md](FUNCTIONS.md).

## Security Notes

- Browser sessions use an `httpOnly` cookie.
- APIs also accept `Authorization: Bearer <token>`.
- Passwords are hashed with bcrypt.
- Login is rate-limited.
- SQL queries use parameter placeholders.
- Project SQL editor blocks dangerous admin statements such as `DROP DATABASE`, `DROP USER`, `GRANT`, `REVOKE`, `FLUSH`, `LOAD DATA`, `INTO OUTFILE`, and `CALL`.
- Shell operations use `execFile`, not shell string interpolation.
- Service control is gated behind `ENABLE_SERVICE_CONTROL=true`.
- Global service control is whitelisted.
- Project service control only works for services linked to that project.
- Env variable values are not returned by list endpoints.
- Removing a project is destructive and should be treated carefully.

## Troubleshooting

### Dashboard says "Cannot reach server"

Check EKAFY service:

```bash
sudo systemctl status ekafy
sudo journalctl -u ekafy -n 100 --no-pager
```

Check Nginx:

```bash
sudo nginx -t
sudo systemctl status nginx
```

### `sudo: a password is required`

The EKAFY service user does not have the needed sudoers rule.

Re-run the initializer or inspect:

```bash
sudo visudo -cf /etc/sudoers.d/ekafy-services
sudo cat /etc/sudoers.d/ekafy-services
```

### Nginx setup fails with missing certificate

Error example:

```txt
cannot load certificate "/etc/letsencrypt/live/domain/fullchain.pem"
```

That means an enabled Nginx site references a certificate that does not exist.

Fix by reissuing the certificate or disabling the stale site:

```bash
sudo certbot certificates
sudo ls -la /etc/nginx/sites-enabled
sudo nginx -t
```

### Cloudflare returns 520 after Nginx restart

Restarting Nginx can drop the current dashboard request.

Use reload:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

The dashboard uses reload for Nginx.

### Static site shows 404

Check that files are inside `public/`:

```bash
ls -la /srv/project-name/public
```

For static sites, this is wrong:

```txt
/srv/project-name/index.html
```

This is correct:

```txt
/srv/project-name/public/index.html
```

### API route does not work

For `static-api`, check:

```bash
curl -I https://domain.example.com/
curl https://domain.example.com/api/health
curl http://127.0.0.1:4001/api/health
sudo systemctl status your-service
sudo journalctl -u your-service -f
```

Your frontend should call:

```js
fetch('/api/health')
```

### SSL handshake failure

Check exact hostname:

```bash
curl -I https://domain.example.com/
curl -I https://www.domain.example.com/
```

If `www.domain` is used, DNS, Nginx, and SSL must all include `www.domain`.

### Git clone fails

Check project path permissions and Git credentials:

```bash
ls -la /srv/project-name
sudo -u ekafy git ls-remote git@github.com:user/repo.git
sudo -u ekafy ssh -T git@github.com
```

### Database access denied

Check project env:

```bash
cat /srv/project-name/.env
```

Check MariaDB user:

```bash
sudo mysql
SHOW GRANTS FOR 'project_user'@'localhost';
```

### Project delete leaves warnings

Warnings mean EKAFY removed what it could but some shell/database cleanup step failed.

Common causes:

- Missing sudoers permission
- Missing service unit
- Missing Nginx config
- Missing SSL certificate
- Database admin credentials not configured

Review:

```bash
sudo journalctl -u ekafy -n 200 --no-pager
```

## Repository Map

```txt
.
├── server.js
├── package.json
├── database.sql
├── init.sh
├── config/
│   └── db.js
├── controllers/
├── errors/
├── middleware/
├── models/
├── routes/
├── public/
│   ├── dashboard.html
│   ├── login.html
│   ├── style.css
│   └── js/
└── README.md
```

## Development Notes

Run syntax checks:

```bash
node --check server.js
node --check controllers/systemController.js
```

Check browser modules:

```bash
node --input-type=module --check < public/js/pages/dashboard.js
```

Start development server:

```bash
npm run dev
```

Start production server:

```bash
npm start
```

## Production Checklist

Before using EKAFY seriously:

- Set a strong `JWT_SECRET`.
- Keep `ALLOW_REGISTRATION=false`.
- Use HTTPS for the dashboard.
- Confirm `ENABLE_SERVICE_CONTROL=true` only on the target VPS.
- Confirm `/etc/sudoers.d/ekafy-services` validates with `visudo`.
- Set `SSL_EMAIL`.
- Keep `ALLOW_SELF_SIGNED_SSL=false` for Cloudflare Full (strict).
- Confirm MariaDB admin credentials work.
- Confirm project paths stay inside `PROJECTS_ROOT`.
- Confirm project repos use the correct `public/` structure.
- Confirm API apps listen on `127.0.0.1:<port>`.
- Confirm each API app has a systemd service.
- Link project services in EKAFY for dashboard control.
- Keep backups before destructive project removal.

## License

MIT
