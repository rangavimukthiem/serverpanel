-- EKAFY — full schema (safe to re-run; all statements use IF NOT EXISTS)
CREATE DATABASE IF NOT EXISTS ekafy CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE ekafy;

-- ─── Core Tables ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id          INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  username    VARCHAR(64)    NOT NULL,
  password    VARCHAR(255)   NOT NULL,
  role        ENUM('admin','user') NOT NULL DEFAULT 'user',
  created_at  TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY users_username_unique (username)
);

CREATE TABLE IF NOT EXISTS logs (
  id          INT UNSIGNED   NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED   NULL,
  action      VARCHAR(255)   NOT NULL,
  timestamp   TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY logs_user_id_index (user_id),
  CONSTRAINT logs_user_id_foreign
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ─── Projects ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id                INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  name              VARCHAR(120)    NOT NULL,
  slug              VARCHAR(120)    NOT NULL,
  path              VARCHAR(255)    NOT NULL,
  domain            VARCHAR(253)    NULL,
  port              SMALLINT UNSIGNED NULL,
  status            VARCHAR(64)     NOT NULL DEFAULT 'active',
  config_json       LONGTEXT        NULL,
  git_repo_url      VARCHAR(512)    NULL,
  git_branch        VARCHAR(120)    NOT NULL DEFAULT 'main',
  ssl_enabled       TINYINT(1)      NOT NULL DEFAULT 0,
  nginx_config_path VARCHAR(512)    NULL,
  created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY projects_slug_unique (slug)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  INT UNSIGNED NOT NULL,
  user_id     INT UNSIGNED NOT NULL,
  role        ENUM('manager','user') NOT NULL DEFAULT 'user',
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id),
  KEY project_members_user_id_index (user_id),
  CONSTRAINT project_members_project_id_foreign
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT project_members_user_id_foreign
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ─── Per-project Environment Variables ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_envs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id  INT UNSIGNED NOT NULL,
  env_key     VARCHAR(128) NOT NULL,
  env_value   TEXT         NOT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY project_envs_unique (project_id, env_key),
  CONSTRAINT project_envs_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- ─── Per-project Linked systemd Services ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_services (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id   INT UNSIGNED NOT NULL,
  service_name VARCHAR(128) NOT NULL,
  label        VARCHAR(255) NOT NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY project_services_unique (project_id, service_name),
  CONSTRAINT project_services_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
