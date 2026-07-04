# EKAFY VPS Control Panel

EKAFY is a lightweight VPS control panel built with Express, MariaDB, JWT authentication, and a vanilla HTML/CSS/JavaScript frontend.

## Current Build Slice

- Express API server
- MariaDB connection pool
- User registration and login with bcrypt password hashing
- JWT route protection
- Login rate limiting
- System status endpoint at `GET /api/system/status`
- Whitelisted service control at `POST /api/services/:name/:action`
- Vanilla dashboard with auto-refreshing metrics
- Activity log writes for auth and service actions

## Setup

### Automated Linux VPS Setup

On Ubuntu/Debian, clone the repository anywhere, then run the initializer. It copies the project into `/srv/ekafy` automatically:

```bash
git clone https://github.com/rangavimukthiem/srv.git
cd srv
sudo bash init.sh
```

With Nginx reverse proxy:

```bash
sudo bash init.sh --install-nginx --domain panel.example.com
```

Use a custom target directory if needed:

```bash
sudo bash init.sh --app-dir /srv/my-panel
```

The initializer copies files to the target directory, installs system packages, creates a MariaDB database/user, writes `.env`, installs Node dependencies, creates a systemd service, and can create the first admin user.

Useful production commands:

```bash
sudo systemctl status ekafy
sudo journalctl -u ekafy -f
sudo systemctl restart ekafy
```

### Manual Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create the database and tables:

   ```bash
   mysql -u root -p < database.sql
   ```

3. Create `.env` from the example:

   ```bash
   cp .env.example .env
   ```

4. Update `.env` with your MariaDB credentials and a long `JWT_SECRET`.

5. Start the server:

   ```bash
   npm run dev
   ```

6. Open `http://localhost:3000/login.html`.

## Create First Admin

Use the registration endpoint once:

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"change-this-password","role":"admin"}'
```

After the first admin is created, disable or restrict open registration before production use.

## Security Notes

- Protected APIs require `Authorization: Bearer <token>`.
- SQL queries use parameter placeholders.
- Service control accepts only whitelisted services and actions.
- `systemctl` service control is disabled unless `ENABLE_SERVICE_CONTROL=true`.
- First-user registration is allowed for bootstrap; after that, registration is disabled unless `ALLOW_REGISTRATION=true`.
- The frontend stores JWTs in `localStorage` as requested. For higher-security deployments, consider short token TTLs and a refresh-token strategy with secure cookies.

## Deployment Path

On a Linux VPS, place the project at:

```bash
/srv/ekafy
```

Then run it behind Nginx with PM2 or systemd.
