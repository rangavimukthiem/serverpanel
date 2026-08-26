# EKAFY Web Solutions Platform - v2

Welcome to **EKAFY v2**, a modern, cloud-native, multi-tenant SaaS platform built on Docker, Node.js, and Traefik.

## 🚀 Architecture Overview

This platform has been entirely re-architected from a legacy monolithic Systemd/Nginx approach into a highly scalable, stateless containerized ecosystem.

### Key Components

1. **Traefik (Edge Router):** Automatically routes incoming traffic to the correct Docker containers and dynamically generates Let's Encrypt SSL certificates for all subdomains.
2. **Server Manager (`/manager`):** The administrative control panel API (`dashboard.ekafy.com`). It handles Google OAuth authentication and contains the **Automated Tenant Provisioning Engine** which creates isolated databases for new customers on the fly.
3. **EKAFY Core (`/core`):** The actual Multi-Tenant SaaS application (`*.ekafy.com`). It features dynamic database routing middleware that connects requests to a customer's specific, isolated database (e.g., `restaurant-a.ekafy.com` connects exclusively to `db_tenant_restaurant_a`).
4. **MariaDB:** The high-performance relational database holding both the `ekafy_master` database and all isolated tenant databases.
5. **Redis:** In-memory caching and session management.

## 🛠️ Local Development Setup

To run the entire ecosystem locally on your machine, you must have **Docker Desktop** installed.

1. **Environment Variables:**
   Create a `.env` file from the example template:
   ```bash
   cp .env.example .env
   ```
   *Edit `.env` to configure your local domains (e.g., `dashboard.localhost`)*

2. **Boot the Cluster:**
   ```bash
   docker compose up --build
   ```

3. **Local Testing via Hosts File:**
   To test subdomain routing locally, map domains in your local OS `hosts` file (`C:\Windows\System32\drivers\etc\hosts` or `/etc/hosts`):
   ```text
   127.0.0.1  dashboard.ekafy.com
   127.0.0.1  restaurant.ekafy.com
   ```

## 🌍 Production Deployment

Deploying to a raw, fresh Ubuntu VPS is completely automated via the `setup-vps.sh` script.

1. Clone this repository onto your new Ubuntu Server.
2. Ensure you have pointed your DNS A-Records (`dashboard.ekafy.com`, `*.ekafy.com`) to your server's public IP.
3. Run the setup script as root:
   ```bash
   chmod +x setup-vps.sh
   ./setup-vps.sh
   ```
   *This script automatically hardens SSH, installs UFW/Fail2Ban, installs Webmin securely, installs Docker, and boots the cluster!*

## 🔒 Security & OAuth

The Server Manager (`/manager`) is strictly protected by a Google OAuth & JWT pipeline.
- Users must authenticate via the `POST /api/auth/google` endpoint.
- The system verifies the token, checks the `users` table, and ensures registration is permitted via the `.env` settings.
- All administrative endpoints (like Tenant Creation) require a valid Admin JWT session.

## 📂 Code Organization

- `/manager`: Node.js Express API for administrative tasks.
- `/core`: Node.js Express API containing business logic modules (Employees, Quotations, etc.).
- `/core/src/config/tenantSchema.sql`: The database blueprint injected into every new customer's database.
- `_archive_legacy_v1/`: All deprecated code from the V1 architecture.
