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
