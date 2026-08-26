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
echo -e "${YELLOW}Step 1: System Updates & Automatic Patching...${NC}"
apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
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

# 9. Environment Validation
echo -e "${YELLOW}Step 8: Validating Environment Configuration...${NC}"
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}Warning: .env file not found. Copying from .env.example...${NC}"
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "${RED}ACTION REQUIRED: Please configure your passwords and domains in the .env file before starting the cluster.${NC}"
        echo -e "Run: nano .env && sudo bash setup-vps.sh"
        exit 1
    else
        echo -e "${RED}Error: .env.example not found.${NC}"
        exit 1
    fi
fi

# 9. Persistent Storage Prep
echo -e "${YELLOW}Step 8: Preparing Persistent Data Directories...${NC}"
mkdir -p data/mariadb
mkdir -p data/redis
mkdir -p data/letsencrypt
touch data/letsencrypt/acme.json
chmod 600 data/letsencrypt/acme.json

# 10. Spin up cluster
echo -e "${YELLOW}Step 9: Starting the EKAFY Cluster via Docker Compose...${NC}"
docker compose up -d --build

echo -e "${GREEN}==========================================${NC}"
echo -e "${GREEN}  EKAFY VPS is Secured & Platform Live!   ${NC}"
echo -e "${GREEN}==========================================${NC}"
echo -e "Check cluster status with: docker compose ps"
echo -e "Check proxy logs with:     docker compose logs -f traefik"
