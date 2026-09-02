#!/usr/bin/env bash
set -e

# ==============================================================================
# EKAFY SaaS Platform - Secure VPS Setup & Deployment Script
# ==============================================================================
# This script prepares a fresh Linux VPS, implements critical security measures,
# installs Docker, and starts the EKAFY platform cluster.
# ==============================================================================

# Colors
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
NC='\033[0m'

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}  Starting EKAFY VPS Security & Setup     ${NC}"
echo -e "${GREEN}==========================================${NC}"

# 1. Require Root
if [[ "${EUID}" -ne 0 ]]; then
  echo -e "${RED}Error: Run this script with sudo or as root.${NC}"
  exit 1
fi

# 2. System Updates & Essential Packages
# Clean up any malformed docker.com repo entries if present
grep -l "docker.com jammy" /etc/apt/sources.list /etc/apt/sources.list.d/* 2>/dev/null | xargs sed -i '/docker\.com jammy/d' 2>/dev/null || true
apt-get update || true
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban ufw unattended-upgrades curl wget git
# Enable unattended-upgrades silently
dpkg-reconfigure --priority=low unattended-upgrades || true

# 3. Configure Timezone
echo -e "${YELLOW}Step 2: Configuring Timezone (UTC)...${NC}"
timedatectl set-timezone UTC

# 4. Harden SSH
echo -e "${YELLOW}Step 3: Hardening SSH (Disabling Password & Root Login)...${NC}"
# Check if authorized_keys exists for the current real user (or root) to prevent lockout
if [ -f "/root/.ssh/authorized_keys" ] || { [ -n "$SUDO_USER" ] && [ -f "/home/$SUDO_USER/.ssh/authorized_keys" ]; }; then
    sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
    sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
    systemctl restart ssh || systemctl restart sshd
    echo -e "${GREEN}SSH Hardened: Passwords disabled. Key-based authentication required.${NC}"
else
    echo -e "${RED}WARNING: No SSH public key found! Skipping strict SSH hardening to prevent locking you out.${NC}"
fi

# 5. UFW Firewall Configuration
echo -e "${YELLOW}Step 4: Configuring UFW Firewall...${NC}"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
echo -e "${GREEN}Firewall enabled. Database ports are securely blocked from the outside.${NC}"

# 6. Fail2Ban
echo -e "${YELLOW}Step 5: Enabling Fail2Ban Intrusion Prevention...${NC}"
systemctl enable fail2ban
systemctl start fail2ban

# 7. Install Docker
echo -e "${YELLOW}Step 6: Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
    systemctl enable docker
    systemctl start docker
    echo -e "${GREEN}Docker installed successfully.${NC}"
else
    echo -e "${GREEN}Docker is already installed.${NC}"
fi

# 8. Install Webmin
echo -e "${YELLOW}Step 7: Installing Webmin on Host...${NC}"
if ! command -v webmin &> /dev/null; then
    curl -s -o setup-repos.sh https://raw.githubusercontent.com/webmin/webmin/master/setup-repos.sh
    sh setup-repos.sh -f
    apt-get install -y webmin --install-recommends
    
    # Disable Webmin's internal SSL so Traefik can safely proxy it over HTTP
    sed -i 's/ssl=1/ssl=0/' /etc/webmin/miniserv.conf
    systemctl restart webmin
    echo -e "${GREEN}Webmin installed. It is secured behind Traefik (Port 10000 is blocked from public internet).${NC}"
else
    echo -e "${GREEN}Webmin is already installed.${NC}"
fi

# 8. Environment Setup & Password Generation
echo -e "${YELLOW}Step 8: Configuring Environment & Secrets...${NC}"
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}.env file not found. Auto-generating configuration...${NC}"
    if [ -f ".env.example" ]; then
        cp .env.example .env
    else
        echo -e "${RED}Error: .env.example not found.${NC}"
        exit 1
    fi

    # Helper function to generate secure random strings
    gen_secret() {
        if command -v openssl &> /dev/null; then
            openssl rand -hex 16
        else
            tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32
        fi
    }

    gen_jwt() {
        if command -v openssl &> /dev/null; then
            openssl rand -base64 32
        else
            tr -dc 'A-Za-z0-9_=-' < /dev/urandom | head -c 44
        fi
    }

    # Generate secure random credentials
    DB_ROOT_PASS=$(gen_secret)
    DB_ADMIN_PASS=$(gen_secret)
    REDIS_PASS=$(gen_secret)
    JWT_SEC=$(gen_jwt)

    # Interactive Domain Configuration (or defaults if non-interactive)
    CORE_DOM="ekafy.com"
    MGR_DOM="dashboard.ekafy.com"
    WEBMIN_DOM="panel.ekafy.com"
    EMAIL="admin@ekafy.com"

    if [ -t 0 ] || [ -e /dev/tty ]; then
        echo -e "${GREEN}--------------------------------------------------${NC}"
        echo -e "${GREEN} Quick Setup: Enter your domain settings below     ${NC}"
        echo -e "${GREEN} (Press [ENTER] to accept the suggested defaults)  ${NC}"
        echo -e "${GREEN}--------------------------------------------------${NC}"

        exec < /dev/tty || true
        read -r -p "Base Domain [ekafy.com]: " input_core
        [ -n "$input_core" ] && CORE_DOM="$input_core"

        read -r -p "Server Manager Domain [dashboard.${CORE_DOM}]: " input_mgr
        MGR_DOM="${input_mgr:-dashboard.${CORE_DOM}}"

        read -r -p "Webmin Domain [panel.${CORE_DOM}]: " input_webmin
        WEBMIN_DOM="${input_webmin:-panel.${CORE_DOM}}"

        read -r -p "Let's Encrypt SSL Email [admin@${CORE_DOM}]: " input_email
        EMAIL="${input_email:-admin@${CORE_DOM}}"
    fi

    # Apply configuration to .env
    sed -i "s|^CORE_DOMAIN=.*|CORE_DOMAIN=${CORE_DOM}|" .env
    sed -i "s|^MANAGER_DOMAIN=.*|MANAGER_DOMAIN=${MGR_DOM}|" .env
    sed -i "s|^WEBMIN_DOMAIN=.*|WEBMIN_DOMAIN=${WEBMIN_DOM}|" .env
    sed -i "s|^SSL_EMAIL=.*|SSL_EMAIL=${EMAIL}|" .env

    sed -i "s|^DB_ROOT_PASSWORD=.*|DB_ROOT_PASSWORD=${DB_ROOT_PASS}|" .env
    sed -i "s|^DB_ADMIN_PASSWORD=.*|DB_ADMIN_PASSWORD=${DB_ADMIN_PASS}|" .env
    sed -i "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${REDIS_PASS}|" .env
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SEC}|" .env

    echo -e "${GREEN}✓ .env created successfully with secure credentials!${NC}"
    echo -e "  - Core Domain:    ${CORE_DOM}"
    echo -e "  - Manager Domain: ${MGR_DOM}"
    echo -e "  - Webmin Domain:  ${WEBMIN_DOM}"
    echo -e "  - SSL Email:      ${EMAIL}"
else
    echo -e "${GREEN}✓ Existing .env file found.${NC}"
    # Replace any leftover default placeholder passwords in existing .env
    gen_secret() {
        if command -v openssl &> /dev/null; then
            openssl rand -hex 16
        else
            tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32
        fi
    }
    gen_jwt() {
        if command -v openssl &> /dev/null; then
            openssl rand -base64 32
        else
            tr -dc 'A-Za-z0-9_=-' < /dev/urandom | head -c 44
        fi
    }
    if grep -q "your_secure_root_password" .env; then
        sed -i "s|^DB_ROOT_PASSWORD=your_secure_root_password|DB_ROOT_PASSWORD=$(gen_secret)|" .env
        sed -i "s|^DB_ADMIN_PASSWORD=your_secure_admin_password|DB_ADMIN_PASSWORD=$(gen_secret)|" .env
        sed -i "s|^REDIS_PASSWORD=your_secure_redis_password|REDIS_PASSWORD=$(gen_secret)|" .env
        sed -i "s|^JWT_SECRET=your_secure_random_jwt_secret|JWT_SECRET=$(gen_jwt)|" .env
        echo -e "${GREEN}✓ Replaced placeholder passwords in .env with secure random credentials.${NC}"
    fi
fi

# 9. Free Port 80 & 443 from Host Web Servers
echo -e "${YELLOW}Step 9: Ensuring Ports 80 & 443 are free for Traefik...${NC}"
for svc in apache2 nginx httpd caddy lighttpd; do
    if systemctl is-active --quiet "$svc" 2>/dev/null; then
        echo -e "${YELLOW}Stopping and disabling host $svc to free port 80/443 for Traefik...${NC}"
        systemctl stop "$svc" || true
        systemctl disable "$svc" || true
    fi
done

# 10. Persistent Storage Prep
echo -e "${YELLOW}Step 10: Preparing Persistent Data Directories...${NC}"
mkdir -p data/mariadb
mkdir -p data/redis
mkdir -p data/letsencrypt
touch data/letsencrypt/acme.json
chmod 600 data/letsencrypt/acme.json

# 11. Spin up cluster
echo -e "${YELLOW}Step 11: Starting the EKAFY Cluster via Docker Compose...${NC}"
docker compose up -d --build

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}  EKAFY VPS is Secured & Platform Live!   ${NC}"
echo -e "${GREEN}==========================================${NC}"
echo -e "Check cluster status with: docker compose ps"
echo -e "Check proxy logs with:     docker compose logs -f traefik"
