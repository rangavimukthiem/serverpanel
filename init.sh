#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="ekafy"
APP_DIR="/srv/ekafy"
SOURCE_DIR=""
APP_USER="ekafy"
APP_GROUP="ekafy"
SERVICE_NAME="ekafy"
DB_NAME="ekafy"
DB_USER="ekafy"
PORT="3000"
NODE_MAJOR="20"
INSTALL_NGINX="no"
DOMAIN_NAME=""
SSL_EMAIL=""
SKIP_SSL="no"
CREATE_ADMIN="yes"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD=""
ENABLE_SERVICE_CONTROL="true"
ENV_BACKUP_DIR="/var/backups/ekafy"
SSL_METHOD="none"

log()  { printf '\n\033[1;32m[EKAFY]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[EKAFY:WARN]\033[0m %s\n' "$*" >&2; }
fail() { printf '\n\033[1;31m[EKAFY:ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<USAGE
EKAFY production initializer

Usage:
  sudo bash init.sh [options]

Options:
  --app-dir PATH              App directory. Default: /srv/ekafy
  --source-dir PATH           Repository source directory. Default: directory containing init.sh
  --app-user USER             Linux user for the app. Default: ekafy
  --db-name NAME              MariaDB database name. Default: ekafy
  --db-user USER              MariaDB app user. Default: ekafy
  --port PORT                 Local Node.js port. Default: 3000
  --node-major VERSION        NodeSource major version. Default: 20
  --domain DOMAIN             Configure Nginx + SSL for this domain (skips interactive prompt)
  --ssl-email EMAIL           Email for Let's Encrypt notifications
  --skip-ssl                  Set up Nginx but skip SSL certificate provisioning
  --install-nginx             Prompt for domain and configure Nginx reverse proxy
  --no-admin                  Skip first admin user creation
  --admin-username USER       First admin username. Default: admin
  --disable-service-control   Keep systemctl controls disabled in .env
  -h, --help                  Show this help

Examples:
  sudo bash init.sh
  sudo bash init.sh --domain panel.example.com --ssl-email admin@example.com
  sudo bash init.sh --domain panel.example.com --skip-ssl
  sudo bash init.sh --app-dir /srv/ekafy --admin-username owner
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)
      APP_DIR="${2:-}"
      shift 2
      ;;
    --source-dir)
      SOURCE_DIR="${2:-}"
      shift 2
      ;;
    --app-user)
      APP_USER="${2:-}"
      APP_GROUP="$APP_USER"
      shift 2
      ;;
    --db-name)
      DB_NAME="${2:-}"
      shift 2
      ;;
    --db-user)
      DB_USER="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --node-major)
      NODE_MAJOR="${2:-}"
      shift 2
      ;;
    --domain)
      DOMAIN_NAME="${2:-}"
      INSTALL_NGINX="yes"
      shift 2
      ;;
    --ssl-email)
      SSL_EMAIL="${2:-}"
      shift 2
      ;;
    --skip-ssl)
      SKIP_SSL="yes"
      shift
      ;;
    --install-nginx)
      INSTALL_NGINX="yes"
      shift
      ;;
    --no-admin)
      CREATE_ADMIN="no"
      shift
      ;;
    --admin-username)
      ADMIN_USERNAME="${2:-}"
      shift 2
      ;;
    --disable-service-control)
      ENABLE_SERVICE_CONTROL="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Run this script with sudo or as root."
  fi
}

require_linux() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    fail "This initializer is intended for Linux servers."
  fi
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

validate_inputs() {
  [[ "$APP_DIR" == /* ]] || fail "--app-dir must be an absolute path."
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ "$SOURCE_DIR" == /* ]] || fail "--source-dir must be an absolute path."
  fi
  [[ "$APP_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || fail "--app-user must be a valid Linux system username."
  [[ "$DB_NAME" =~ ^[A-Za-z0-9_]{1,64}$ ]] || fail "--db-name must contain only letters, numbers, and underscores."
  [[ "$DB_USER" =~ ^[A-Za-z0-9_]{1,32}$ ]] || fail "--db-user must contain only letters, numbers, and underscores."
  [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9_-]{3,32}$ ]] || fail "--admin-username must be 3-32 letters, numbers, underscores, or dashes."
  [[ "$PORT" =~ ^[0-9]+$ ]] || fail "--port must be numeric."

  if (( PORT < 1024 || PORT > 65535 )); then
    fail "--port must be between 1024 and 65535."
  fi
}

prompt_secret() {
  local prompt="$1"
  local value=""

  while [[ -z "$value" ]]; do
    read -r -s -p "$prompt: " value
    printf '\n'
  done

  printf '%s' "$value"
}

validate_domain_name() {
  local domain="$1"

  [[ "$domain" =~ ^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$ ]]
}

random_secret() {
  openssl rand -base64 48 | tr -d '\n'
}

apt_update() {
  if ! apt-get update; then
    warn "Retrying apt update after accepting repository metadata changes"
    apt-get update -o Acquire::AllowReleaseInfoChange::Label=true
  fi
}

install_packages() {
  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive

  apt_update
  apt-get install -y ca-certificates curl gnupg openssl rsync sudo mariadb-server

  if ! command -v node >/dev/null 2>&1; then
    log "Installing Node.js ${NODE_MAJOR}.x from NodeSource"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi

  if [[ "$INSTALL_NGINX" == "yes" ]]; then
    apt-get install -y nginx
  fi
}

create_app_user() {
  if ! getent group "$APP_GROUP" >/dev/null 2>&1; then
    log "Creating Linux group: $APP_GROUP"
    groupadd --system "$APP_GROUP"
  fi

  if ! id "$APP_USER" >/dev/null 2>&1; then
    log "Creating Linux user: $APP_USER"
    useradd --system --gid "$APP_GROUP" --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
  fi
}

prepare_app_dir() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

  if [[ -z "$SOURCE_DIR" ]]; then
    SOURCE_DIR="$script_dir"
  fi

  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"

  [[ -f "$SOURCE_DIR/package.json" ]] || fail "Missing $SOURCE_DIR/package.json"
  [[ -f "$SOURCE_DIR/database.sql" ]] || fail "Missing $SOURCE_DIR/database.sql"

  log "Preparing application directory: $APP_DIR"
  mkdir -p "$APP_DIR"

  if [[ "$SOURCE_DIR" == "$APP_DIR" ]]; then
    fail "Target app directory must be different from the source directory."
  fi

  case "$APP_DIR/" in
    "$SOURCE_DIR"/*)
      fail "Target app directory cannot be inside the source directory. Use a separate path such as /srv/ekafy."
      ;;
  esac

  if [[ -f "$APP_DIR/.env" ]]; then
    mkdir -p "$ENV_BACKUP_DIR"
    local backup="$ENV_BACKUP_DIR/.env.$(date +%Y%m%d%H%M%S).bak"
    log "Backing up existing .env to $backup"
    cp "$APP_DIR/.env" "$backup"
  fi

  log "Syncing project files from $SOURCE_DIR to $APP_DIR"
  rsync -a \
    --delete \
    --delete-excluded \
    --exclude '.git/' \
    "$SOURCE_DIR/" "$APP_DIR/"

  [[ -f "$APP_DIR/package.json" ]] || fail "Sync failed: missing $APP_DIR/package.json"
  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

  # Ensure the parent /srv directory is owned by the app user so that projects can be created without manual chmod/chown
  log "Configuring /srv directory permissions for automatic project deployment"
  mkdir -p /srv
  chown "$APP_USER:$APP_GROUP" /srv
}

setup_mariadb() {
  log "Configuring MariaDB"
  systemctl enable --now mariadb

  local db_password
  db_password="$(random_secret)"

  mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${db_password}';
ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${db_password}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

  mysql "$DB_NAME" < "$APP_DIR/database.sql"

  DB_PASSWORD="$db_password"
}

write_env() {
  local env_file="$APP_DIR/.env"
  local jwt_secret
  jwt_secret="$(random_secret)"

  log "Writing production .env"
  cat > "$env_file" <<ENV
PORT=${PORT}
NODE_ENV=production

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}

JWT_SECRET=${jwt_secret}
JWT_EXPIRES_IN=8h
ALLOW_REGISTRATION=false

ENABLE_SERVICE_CONTROL=${ENABLE_SERVICE_CONTROL}
ENV

  # Append SSL email so projectSetupController can use it for per-project certs
  if [[ -n "$SSL_EMAIL" ]]; then
    printf 'SSL_EMAIL=%s\n' "$SSL_EMAIL" >> "$env_file"
  fi

  chown "$APP_USER:$APP_GROUP" "$env_file"
  chmod 600 "$env_file"
}

install_node_dependencies() {
  log "Installing Node.js dependencies"
  cd "$APP_DIR"

  if [[ -f package-lock.json ]]; then
    sudo -u "$APP_USER" npm ci --omit=dev
  else
    sudo -u "$APP_USER" npm install --omit=dev
  fi
}

write_systemd_service() {
  log "Creating systemd service"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=EKAFY VPS Control Panel
After=network.target mariadb.service
Wants=mariadb.service

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=$(command -v node) ${APP_DIR}/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
}

configure_sudoers_for_services() {
  [[ "$ENABLE_SERVICE_CONTROL" != "true" ]] && return

  local systemctl_path nginx_path
  systemctl_path="$(command -v systemctl)"
  nginx_path="$(command -v nginx || echo '/usr/sbin/nginx')"

  log "Allowing EKAFY service user to control whitelisted systemd units & Nginx checks"
  cat > "/etc/sudoers.d/${APP_NAME}-services" <<SUDOERS
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_path} start nginx, ${systemctl_path} stop nginx, ${systemctl_path} restart nginx, ${systemctl_path} reload nginx, ${systemctl_path} is-active --quiet nginx, ${nginx_path} -t
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_path} start mysql, ${systemctl_path} stop mysql, ${systemctl_path} restart mysql, ${systemctl_path} is-active --quiet mysql
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_path} start mariadb, ${systemctl_path} stop mariadb, ${systemctl_path} restart mariadb, ${systemctl_path} is-active --quiet mariadb
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_path} start apache2, ${systemctl_path} stop apache2, ${systemctl_path} restart apache2, ${systemctl_path} is-active --quiet apache2
SUDOERS
  chmod 440 "/etc/sudoers.d/${APP_NAME}-services"
  visudo -cf "/etc/sudoers.d/${APP_NAME}-services" >/dev/null
}

# ── Domain prompt + DNS notice ────────────────────────────────────────────────

prompt_domain() {
  [[ "$INSTALL_NGINX" != "yes" ]] && return
  [[ -n "$DOMAIN_NAME" ]] && return   # already set via --domain flag

  # Auto-detect public IP
  local public_ip
  public_ip=$(curl -s --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}')
  public_ip="${public_ip// /}"

  printf '\n'
  printf '\033[1;36m╔════════════════════════════════════════════════════════════╗\033[0m\n'
  printf '\033[1;36m║           DOMAIN & DNS SETUP — READ THIS FIRST             ║\033[0m\n'
  printf '\033[1;36m╠════════════════════════════════════════════════════════════╣\033[0m\n'
  printf '\033[1;36m║\033[0m  For EKAFY to work on a domain, add this DNS record:       \033[1;36m║\033[0m\n'
  printf '\033[1;36m║\033[0m                                                            \033[1;36m║\033[0m\n'
  printf '\033[1;36m║\033[0m   Type  : \033[1;33mA\033[0m                                                \033[1;36m║\033[0m\n'
  printf '\033[1;36m║\033[0m   Name  : \033[1;33mpanel\033[0m  (or @ for root domain, or any subdomain) \033[1;36m║\033[0m\n'
  printf '\033[1;36m║\033[0m   Value : \033[1;33m%-47s\033[1;36m║\033[0m\n' "$public_ip"
  printf '\033[1;36m║\033[0m   TTL   : \033[1;33m300\033[0m  (5 min, raise to 3600 later)                \033[1;36m║\033[0m\n'
  printf '\033[1;36m║\033[0m                                                            \033[1;36m║\033[0m\n'
  printf '\033[1;36m║\033[0m  DNS changes take 1–30 min to propagate.                   \033[1;36m║\033[0m\n'
  printf '\033[1;36m║\033[0m  If the record is not live yet, SSL will fall back to a   \033[1;36m║\033[0m\n'
  printf '\033[1;36m║\033[0m  self-signed certificate (browser will show a warning).   \033[1;36m║\033[0m\n'
  printf '\033[1;36m╚════════════════════════════════════════════════════════════╝\033[0m\n'
  printf '\n'

  while true; do
    read -r -p "Enter your public domain (e.g. panel.example.com): " DOMAIN_NAME
    DOMAIN_NAME="${DOMAIN_NAME// /}"

    if validate_domain_name "$DOMAIN_NAME"; then
      break
    fi

    warn "A valid domain is required for Nginx. Example: panel.example.com"
  done

  if [[ -z "$SSL_EMAIL" && "$SKIP_SSL" != "yes" ]]; then
    read -r -p "Email for Let's Encrypt notifications (Enter to skip): " SSL_EMAIL
    SSL_EMAIL="${SSL_EMAIL// /}"
  fi
}

prompt_nginx_setup() {
  if [[ "$INSTALL_NGINX" == "yes" ]]; then
    prompt_domain
    return
  fi

  local answer=""
  read -r -p "Do you want to configure Nginx? [y/N]: " answer
  answer="${answer,,}"

  if [[ "$answer" =~ ^(y|yes)$ ]]; then
    INSTALL_NGINX="yes"
    prompt_domain
  fi
}

configure_nginx() {
  [[ "$INSTALL_NGINX" != "yes" || -z "$DOMAIN_NAME" ]] && return

  log "Configuring Nginx reverse proxy → ${DOMAIN_NAME}:80 → 127.0.0.1:${PORT}"

  # Default catch-all block rejects raw IP and unknown host requests.
  cat > "/etc/nginx/sites-available/${APP_NAME}" <<NGINX
# EKAFY — managed by init.sh
server {
    listen 80 default_server;
    server_name _;
    return 444;
}

server {
    listen 80;
    server_name ${DOMAIN_NAME};

    client_max_body_size 1m;

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        'upgrade';
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
NGINX

  # Remove default site to avoid conflicts on port 80
  rm -f /etc/nginx/sites-enabled/default

  ln -sfn "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"

  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  log "Nginx configured — ${DOMAIN_NAME} → 127.0.0.1:${PORT}"
}

configure_nginx_permissions() {
  if [[ -d /etc/nginx ]]; then
    log "Configuring Nginx directory permissions for ${APP_GROUP}"
    chown -R root:"${APP_GROUP}" /etc/nginx/sites-available /etc/nginx/sites-enabled
    chmod -R g+w /etc/nginx/sites-available /etc/nginx/sites-enabled
  fi
}

cleanup_nginx_sites() {
  [[ -d /etc/nginx/sites-enabled ]] || return

  log "Removing stale Nginx site links"

  find /etc/nginx/sites-enabled -maxdepth 1 -type l ! -exec test -e {} \; -print -delete >/dev/null 2>&1 || true

  rm -f \
    /etc/nginx/sites-enabled/default \
    /etc/nginx/sites-enabled/ekafy-router
}

# ── SSL via certbot (Let's Encrypt) with self-signed fallback ─────────────────

provision_ssl() {
  [[ "$INSTALL_NGINX" != "yes" || -z "$DOMAIN_NAME" || "$SKIP_SSL" == "yes" ]] && return

  log "Provisioning SSL certificate for ${DOMAIN_NAME}"

  if ! command -v certbot >/dev/null 2>&1; then
    log "Installing certbot"
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y certbot python3-certbot-nginx
  fi

  local certbot_args=(--nginx -d "$DOMAIN_NAME" --non-interactive --agree-tos --redirect)
  if [[ -n "$SSL_EMAIL" ]]; then
    certbot_args+=(-m "$SSL_EMAIL")
  else
    certbot_args+=(--register-unsafely-without-email)
  fi

  if certbot "${certbot_args[@]}"; then
    SSL_METHOD="lets-encrypt"
    log "Let's Encrypt certificate issued. Nginx updated to HTTPS."
    systemctl enable certbot.timer 2>/dev/null || true
  else
    warn "Let's Encrypt issuance failed (DNS may not have propagated yet)."
    warn "Falling back to a self-signed certificate."
    _provision_self_signed
  fi
}

_provision_self_signed() {
  local ssl_dir="/etc/nginx/ssl/${APP_NAME}"
  mkdir -p "$ssl_dir"
  local key_file="$ssl_dir/server.key"
  local crt_file="$ssl_dir/server.crt"

  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$key_file" -out "$crt_file" \
    -subj "/CN=${DOMAIN_NAME}" 2>/dev/null

  # Replace nginx config with HTTPS self-signed block
  cat > "/etc/nginx/sites-available/${APP_NAME}" <<NGINX
# EKAFY — self-signed SSL fallback
server {
    listen 80 default_server;
    server_name _;
    return 444;
}

server {
    listen 80;
    server_name ${DOMAIN_NAME};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN_NAME};

    ssl_certificate     ${crt_file};
    ssl_certificate_key ${key_file};

    client_max_body_size 1m;

    location / {
        proxy_pass         http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        'upgrade';
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}

server {
    listen 443 ssl default_server;
    server_name _;

    ssl_certificate     ${crt_file};
    ssl_certificate_key ${key_file};

    return 444;
}
NGINX

  nginx -t && systemctl reload nginx
  SSL_METHOD="self-signed"
  warn "Self-signed certificate active. Browsers will show a security warning."
  warn "Upgrade when DNS propagates:  sudo certbot --nginx -d ${DOMAIN_NAME}"
}

create_admin_user() {
  if [[ "$CREATE_ADMIN" != "yes" ]]; then
    return
  fi

  require_command node
  require_command mysql

  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(prompt_secret "First admin password for ${ADMIN_USERNAME}")"
  fi

  log "Creating or updating first admin user"
  sleep 2

  local password_hash
  password_hash="$(node -e 'const bcrypt = require("bcrypt"); const password = process.argv[1]; console.log(bcrypt.hashSync(password, 12));' "$ADMIN_PASSWORD")"

  mysql "$DB_NAME" <<SQL
INSERT INTO users (username, password, role)
VALUES ('${ADMIN_USERNAME}', '${password_hash}', 'admin')
ON DUPLICATE KEY UPDATE
  password = VALUES(password),
  role = 'admin';
SQL

  log "Admin user ready: ${ADMIN_USERNAME}"
}

print_summary() {
  local url proto
  if [[ "$INSTALL_NGINX" == "yes" && -n "$DOMAIN_NAME" ]]; then
    if [[ "$SSL_METHOD" == "lets-encrypt" || "$SSL_METHOD" == "self-signed" ]]; then
      proto="https"
    else
      proto="http"
    fi
    url="${proto}://${DOMAIN_NAME}/login.html"
  else
    local server_ip
    server_ip="$(hostname -I | awk '{print $1}')"
    url="http://${server_ip}:${PORT}/login.html"
  fi

  printf '\n\033[1;32m'
  printf '╔══════════════════════════════════════════════════════════════╗\n'
  printf '║            EKAFY — Installation Complete                     ║\n'
  printf '╚══════════════════════════════════════════════════════════════╝\n'
  printf '\033[0m\n'

  cat <<SUMMARY
  App directory    : ${APP_DIR}
  Systemd service  : ${SERVICE_NAME}
  Database         : ${DB_NAME}
  DB user          : ${DB_USER}
  Service control  : ${ENABLE_SERVICE_CONTROL}
  SSL method       : ${SSL_METHOD}

  Open your panel  : ${url}

Useful commands:
  sudo systemctl status   ${SERVICE_NAME}
  sudo journalctl -u ${SERVICE_NAME} -f
  sudo systemctl restart  ${SERVICE_NAME}

SUMMARY

  if [[ "$SSL_METHOD" == "self-signed" ]]; then
    printf '\033[1;33m'
    printf '⚠  Self-signed certificate in use.\n'
    printf '   Browsers will show a security warning until you get a trusted cert.\n'
    printf '\n'
    printf '   Once DNS for "%s" points to this server, run:\n' "$DOMAIN_NAME"
    printf '     sudo certbot --nginx -d %s\n' "$DOMAIN_NAME"
    printf '\033[0m\n'
  fi

  if [[ "$INSTALL_NGINX" != "yes" || -z "$DOMAIN_NAME" ]]; then
    server_ip="$(hostname -I | awk '{print $1}')"
    printf '\033[1;36mℹ  No domain configured. EKAFY is accessible at:\033[0m\n'
    printf '   http://%s:%s/login.html\n' "$server_ip" "$PORT"
    printf '\n'
    printf '   To add a domain later, re-run:\n'
    printf '     sudo bash %s/init.sh --domain your.domain.com --ssl-email you@example.com\n' "$APP_DIR"
    printf '\n'
  fi

  printf '  Keep %s/.env private — it contains production secrets.\n\n' "$APP_DIR"
}

main() {
  require_root
  require_linux
  validate_inputs

  require_command apt-get
  require_command systemctl

  # Prompt for Nginx/domain interactively before any package installs
  prompt_nginx_setup

  install_packages
  require_command mysql
  create_app_user
  prepare_app_dir
  setup_mariadb
  write_env
  install_node_dependencies
  write_systemd_service
  configure_sudoers_for_services
  cleanup_nginx_sites
  configure_nginx
  configure_nginx_permissions
  provision_ssl        # Let's Encrypt or self-signed, after nginx is live
  create_admin_user
  print_summary
}

main "$@"
