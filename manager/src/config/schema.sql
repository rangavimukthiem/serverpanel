-- EKAFY Master Database Schema
-- This database tracks tenants (customers), their subscriptions, and the globally active feature flags.

CREATE TABLE IF NOT EXISTS tenants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  subdomain VARCHAR(120) NOT NULL UNIQUE,
  db_name VARCHAR(120) NOT NULL UNIQUE,
  plan_type ENUM('basic', 'pro', 'enterprise') DEFAULT 'basic',
  status ENUM('active', 'suspended', 'deleted') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(320) NOT NULL UNIQUE,
  google_sub VARCHAR(255) UNIQUE,
  role ENUM('admin', 'user') DEFAULT 'user',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feature_flags (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id INT NOT NULL,
  feature_key VARCHAR(120) NOT NULL,
  is_enabled BOOLEAN DEFAULT FALSE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  UNIQUE KEY (tenant_id, feature_key)
);

-- ==========================================
-- EKAFY Agency OS (CRM & Chat)
-- ==========================================

CREATE TABLE IF NOT EXISTS clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(320) NOT NULL UNIQUE,
  google_sub VARCHAR(255) UNIQUE,
  phone VARCHAR(20),
  status ENUM('active', 'inactive') DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS projects (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_id INT NOT NULL,
  tenant_id INT, -- If it is a Prebuilt Product, it links to the tenant database
  name VARCHAR(200) NOT NULL,
  project_type ENUM('prebuilt', 'custom') NOT NULL,
  status ENUM('pending_approval', 'in_development', 'deployed', 'suspended') DEFAULT 'pending_approval',
  git_repo_url VARCHAR(500), -- Used if project_type = 'custom'
  assigned_admin_id INT, -- The admin managing this project
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  FOREIGN KEY (assigned_admin_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  project_id INT NOT NULL,
  sender_type ENUM('admin', 'client') NOT NULL,
  sender_id INT NOT NULL, -- Refers to either users.id or clients.id based on sender_type
  message TEXT NOT NULL,
  read_status BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

