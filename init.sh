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
CREATE_ADMIN="yes"
ADMIN_USERNAME="admin"
ADMIN_PASSWORD=""
ENABLE_SERVICE_CONTROL="true"
ENV_BACKUP_DIR="/var/backups/ekafy"

log() {
  printf '\n[EKAFY] %s\n' "$*"
}

warn() {
  printf '\n[EKAFY:WARN] %s\n' "$*" >&2
}

fail() {
  printf '\n[EKAFY:ERROR] %s\n' "$*" >&2
  exit 1
}

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
  --domain DOMAIN             Configure Nginx reverse proxy for this domain
  --install-nginx             Install/configure Nginx reverse proxy
  --no-admin                  Skip first admin user creation
  --admin-username USER       First admin username. Default: admin
  --disable-service-control   Keep systemctl controls disabled in .env
  -h, --help                  Show this help

Examples:
  sudo bash init.sh
  sudo bash /tmp/srv/init.sh --app-dir /srv/ekafy
  sudo bash init.sh --install-nginx --domain panel.example.com
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

random_secret() {
  openssl rand -base64 48 | tr -d '\n'
}

install_packages() {
  log "Installing system packages"
  export DEBIAN_FRONTEND=noninteractive

  apt-get update
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

  [[ -f "$APP_DIR/package.json" ]] || fail "Missing $APP_DIR/package.json"
  [[ -f "$APP_DIR/database.sql" ]] || fail "Missing $APP_DIR/database.sql"

  chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"
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
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${APP_DIR}

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
}

configure_sudoers_for_services() {
  if [[ "$ENABLE_SERVICE_CONTROL" != "true" ]]; then
    return
  fi

  local systemctl_path
  systemctl_path="$(command -v systemctl)"

  log "Allowing EKAFY service user to control whitelisted systemd units"
  cat > "/etc/sudoers.d/${APP_NAME}-services" <<SUDOERS
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_path} start nginx, ${systemctl_path} stop nginx, ${systemctl_path} restart nginx, ${systemctl_path} is-active --quiet nginx
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_path} start mysql, ${systemctl_path} stop mysql, ${systemctl_path} restart mysql, ${systemctl_path} is-active --quiet mysql
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_path} start mariadb, ${systemctl_path} stop mariadb, ${systemctl_path} restart mariadb, ${systemctl_path} is-active --quiet mariadb
${APP_USER} ALL=(root) NOPASSWD: ${systemctl_path} start apache2, ${systemctl_path} stop apache2, ${systemctl_path} restart apache2, ${systemctl_path} is-active --quiet apache2
SUDOERS
  chmod 440 "/etc/sudoers.d/${APP_NAME}-services"
  visudo -cf "/etc/sudoers.d/${APP_NAME}-services" >/dev/null
}

configure_nginx() {
  if [[ "$INSTALL_NGINX" != "yes" ]]; then
    return
  fi

  if [[ -z "$DOMAIN_NAME" ]]; then
    read -r -p "Domain name for Nginx server_name, or _ for IP-only access: " DOMAIN_NAME
    DOMAIN_NAME="${DOMAIN_NAME:-_}"
  fi

  log "Configuring Nginx reverse proxy"
  cat > "/etc/nginx/sites-available/${APP_NAME}" <<NGINX
server {
    listen 80;
    server_name ${DOMAIN_NAME};

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX

  ln -sfn "/etc/nginx/sites-available/${APP_NAME}" "/etc/nginx/sites-enabled/${APP_NAME}"
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
}

create_admin_user() {
  if [[ "$CREATE_ADMIN" != "yes" ]]; then
    return
  fi

  require_command curl

  if [[ -z "$ADMIN_PASSWORD" ]]; then
    ADMIN_PASSWORD="$(prompt_secret "First admin password for ${ADMIN_USERNAME}")"
  fi

  log "Creating first admin user if it does not already exist"
  sleep 2

  local payload
  payload="$(node -e 'console.log(JSON.stringify({ username: process.argv[1], password: process.argv[2], role: "admin" }))' "$ADMIN_USERNAME" "$ADMIN_PASSWORD")"

  local response
  response="$(curl -sS -o /tmp/ekafy-register-response.json -w "%{http_code}" \
    -X POST "http://127.0.0.1:${PORT}/api/auth/register" \
    -H "Content-Type: application/json" \
    -d "$payload" || true)"

  if [[ "$response" == "201" ]]; then
    log "Admin user created: $ADMIN_USERNAME"
  elif [[ "$response" == "409" ]]; then
    warn "Admin user already exists: $ADMIN_USERNAME"
  else
    warn "Admin creation returned HTTP $response"
    warn "Response: $(cat /tmp/ekafy-register-response.json 2>/dev/null || true)"
  fi

  rm -f /tmp/ekafy-register-response.json
}

print_summary() {
  local url="http://SERVER_IP:${PORT}/login.html"
  if [[ "$INSTALL_NGINX" == "yes" ]]; then
    if [[ "$DOMAIN_NAME" == "_" || -z "$DOMAIN_NAME" ]]; then
      url="http://SERVER_IP/login.html"
    else
      url="http://${DOMAIN_NAME}/login.html"
    fi
  fi

  cat <<SUMMARY

EKAFY installation complete.

App directory: ${APP_DIR}
Systemd service: ${SERVICE_NAME}
Database: ${DB_NAME}
Database user: ${DB_USER}
Service control enabled: ${ENABLE_SERVICE_CONTROL}

Useful commands:
  sudo systemctl status ${SERVICE_NAME}
  sudo journalctl -u ${SERVICE_NAME} -f
  sudo systemctl restart ${SERVICE_NAME}

Open:
  ${url}

Keep ${APP_DIR}/.env private. It contains production secrets.
SUMMARY
}

main() {
  require_root
  require_linux
  validate_inputs

  require_command apt-get
  require_command systemctl

  install_packages
  require_command mysql
  create_app_user
  prepare_app_dir
  setup_mariadb
  write_env
  install_node_dependencies
  write_systemd_service
  configure_sudoers_for_services
  configure_nginx
  create_admin_user
  print_summary
}

main "$@"
