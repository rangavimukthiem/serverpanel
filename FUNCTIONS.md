# EKAFY Function Guide

This file explains the main EKAFY functions and the commands used to control them on a Linux VPS.

## 1. Installation

Run from any cloned repository location. The script copies the app into `/srv/ekafy` by default.

```bash
sudo bash init.sh
```

Install with Nginx:

```bash
sudo bash init.sh --install-nginx --domain panel.example.com
```

Install into a custom directory:

```bash
sudo bash init.sh --app-dir /srv/my-panel
```

The installer syncs the repository into the target directory, deletes stale files from previous installs, and backs up any existing `.env` to `/var/backups/ekafy/`.

Check installer options:

```bash
sudo bash init.sh --help
```

## 2. Systemd App Control

EKAFY is installed as a systemd service named `ekafy`.

Start:

```bash
sudo systemctl start ekafy
```

Stop:

```bash
sudo systemctl stop ekafy
```

Restart:

```bash
sudo systemctl restart ekafy
```

Check status:

```bash
sudo systemctl status ekafy
```

Watch logs:

```bash
sudo journalctl -u ekafy -f
```

## 3. Environment Configuration

Production config lives here:

```bash
/srv/ekafy/.env
```

Edit it:

```bash
sudo nano /srv/ekafy/.env
sudo systemctl restart ekafy
```

Important settings:

```env
PORT=3000
NODE_ENV=production
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=ekafy
DB_NAME=ekafy
JWT_EXPIRES_IN=8h
ALLOW_REGISTRATION=false
ENABLE_SERVICE_CONTROL=true
```

Keep `.env` private. It contains the database password and JWT secret.

## 4. Authentication API

Base URL without Nginx:

```text
http://SERVER_IP:3000
```

Base URL with Nginx:

```text
http://YOUR_DOMAIN
```

Create first admin user:

```bash
curl -X POST http://127.0.0.1:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"change-this-password","role":"admin"}'
```

Login:

```bash
curl -X POST http://127.0.0.1:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"change-this-password"}'
```

The login response returns a JWT token:

```json
{
  "token": "JWT_TOKEN_HERE",
  "user": {
    "id": 1,
    "username": "admin",
    "role": "admin"
  }
}
```

Use the token for protected API calls:

```bash
curl http://127.0.0.1:3000/api/system/status \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

Browser logins also set an `httpOnly` cookie, so the dashboard can stay signed in without storing the JWT in `localStorage`.

## 5. System Monitoring API

Endpoint:

```http
GET /api/system/status
```

Example:

```bash
curl http://127.0.0.1:3000/api/system/status \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

Response:

```json
{
  "cpu": 12.5,
  "ram": 62,
  "uptime": 12345,
  "disk": 70
}
```

## 6. Service Status API

Allowed services:

```text
nginx
mysql
mariadb
apache2
```

Check service status:

```bash
curl http://127.0.0.1:3000/api/services/nginx/status \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

Response:

```json
{
  "service": "nginx",
  "active": true
}
```

## 7. Service Control API

Allowed actions:

```text
start
stop
restart
```

Start Nginx:

```bash
curl -X POST http://127.0.0.1:3000/api/services/nginx/start \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

Restart MariaDB:

```bash
curl -X POST http://127.0.0.1:3000/api/services/mariadb/restart \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

Stop Apache:

```bash
curl -X POST http://127.0.0.1:3000/api/services/apache2/stop \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

Service control requires:

```env
ENABLE_SERVICE_CONTROL=true
```

The installer creates restricted sudoers rules for only the whitelisted `systemctl` commands.

## 8. Projects API

List projects:

```bash
curl http://127.0.0.1:3000/api/projects \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

Current response is a placeholder until project deployment management is expanded.

Create a project as a global admin:

```bash
curl -X POST http://127.0.0.1:3000/api/projects \
  -H "Authorization: Bearer JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"name":"Client API","slug":"client-api","path":"/srv/client-api"}'
```

Assign a user to a project:

```bash
curl -X PUT http://127.0.0.1:3000/api/projects/1/members \
  -H "Authorization: Bearer JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"userId":2,"role":"manager"}'
```

Project member roles:

```text
manager - can manage users for that specific project
user    - can use assigned project API access only
```

Remove a user from a project:

```bash
curl -X DELETE http://127.0.0.1:3000/api/projects/1/members/2 \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

## 9. User Management API

Global user roles:

```text
admin - can manage all projects, services, system controls, and users
user  - no global administrative privileges
```

Project roles are separate from global roles. A global `user` can be a `manager` on one project and a regular `user` on another project.

List users as admin:

```bash
curl http://127.0.0.1:3000/api/users \
  -H "Authorization: Bearer JWT_TOKEN_HERE"
```

Create user as admin:

```bash
curl -X POST http://127.0.0.1:3000/api/users \
  -H "Authorization: Bearer JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"username":"developer","password":"change-this-password","role":"user"}'
```

Change global role as admin:

```bash
curl -X PATCH http://127.0.0.1:3000/api/users/2/role \
  -H "Authorization: Bearer JWT_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}'
```

## 10. Database Control

Open MariaDB shell:

```bash
sudo mysql
```

Use EKAFY database:

```sql
USE ekafy;
```

List users:

```sql
SELECT id, username, role, created_at FROM users;
```

List projects:

```sql
SELECT id, name, slug, path, status, created_at FROM projects;
```

List project memberships:

```sql
SELECT
  p.name AS project,
  u.username,
  pm.role
FROM project_members pm
JOIN projects p ON p.id = pm.project_id
JOIN users u ON u.id = pm.user_id
ORDER BY p.name, u.username;
```

List activity logs:

```sql
SELECT id, user_id, action, timestamp FROM logs ORDER BY timestamp DESC LIMIT 50;
```

Backup database:

```bash
sudo mysqldump ekafy > ekafy-backup.sql
```

Restore database:

```bash
sudo mysql ekafy < ekafy-backup.sql
```

## 11. Nginx Control

If installed through `init.sh --install-nginx`, config is created at:

```bash
/etc/nginx/sites-available/ekafy
```

Test Nginx config:

```bash
sudo nginx -t
```

Reload Nginx:

```bash
sudo systemctl reload nginx
```

Restart Nginx:

```bash
sudo systemctl restart nginx
```

## 12. Frontend Pages

Login page:

```text
/login.html
```

Dashboard:

```text
/dashboard.html
```

The frontend uses an `httpOnly` auth cookie for browser sessions. API clients can still use Bearer tokens.

Dashboard sections:

```text
System metrics
Services
Projects
User Management
```

Only global admins see the User Management controls.

## 13. Updating EKAFY

If the source clone is still available:

```bash
cd /path/to/cloned/repo
git pull
sudo bash init.sh --no-admin
```

Then restart:

```bash
sudo systemctl restart ekafy
```

The installer copies updated files to `/srv/ekafy`, backs up existing `.env`, and installs dependencies.

## 14. Troubleshooting

Check app status:

```bash
sudo systemctl status ekafy
```

Watch app logs:

```bash
sudo journalctl -u ekafy -f
```

Check if port is listening:

```bash
sudo ss -ltnp | grep 3000
```

Check MariaDB:

```bash
sudo systemctl status mariadb
```

Check Nginx:

```bash
sudo nginx -t
sudo systemctl status nginx
```

Common fixes:

```bash
sudo systemctl restart mariadb
sudo systemctl restart ekafy
sudo systemctl reload nginx
```

## 15. Security Checklist

- Use a strong admin password.
- Keep `/srv/ekafy/.env` private.
- Keep `ALLOW_REGISTRATION=false` after the first admin user exists.
- Use HTTPS before public production use.
- Keep service control enabled only if you need it.
- Never add arbitrary shell execution endpoints.
- Keep only required VPS ports open in the firewall.
