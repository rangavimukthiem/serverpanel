/**
 * constants.js — Static lookup tables for wizard presets.
 * The global services list is now fetched from GET /api/services instead
 * of being hard-coded here.
 */

export const databaseQueryPresets = [
  { key: 'create-database', label: 'Create DB' },
  { key: 'grant-access',    label: 'Grant access' },
  { key: 'create-schema',   label: 'Create schema' },
  { key: 'seed-baseline',   label: 'Seed data' }
];

export const apiEndpointPresets = [
  { key: 'health',      label: 'Health' },
  { key: 'auth',        label: 'Auth' },
  { key: 'resources',   label: 'Resources' },
  { key: 'custom-crud', label: 'CRUD' }
];

export const apiEndpointPresetMap = {
  health:       { name: 'Health',     method: 'GET',  path: '/health',       description: 'Service health check' },
  auth:         { name: 'Auth',       method: 'POST', path: '/auth/login',   description: 'Login or token exchange' },
  resources:    { name: 'Resources',  method: 'GET',  path: '/resources',    description: 'List resources' },
  'custom-crud':{ name: 'CRUD',       method: 'POST', path: '/items',        description: 'Replace with your resource path' }
};

/** SQL editor presets (used in the project Database tab) */
export const sqlEditorPresets = [
  {
    key: 'create-table',
    label: 'Create table',
    sql: `CREATE TABLE IF NOT EXISTS \`example\` (\n  id    INT UNSIGNED NOT NULL AUTO_INCREMENT,\n  name  VARCHAR(120) NOT NULL,\n  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;`
  },
  { key: 'add-column',   label: 'Add column',  sql: 'ALTER TABLE `example`\n  ADD COLUMN `new_col` VARCHAR(255) NULL AFTER `name`;' },
  { key: 'add-index',    label: 'Add index',   sql: 'ALTER TABLE `example`\n  ADD INDEX idx_name (`name`);' },
  { key: 'select-all',   label: 'SELECT all',  sql: 'SELECT * FROM `example` LIMIT 100;' },
  { key: 'count-rows',   label: 'Count rows',  sql: 'SELECT COUNT(*) AS total FROM `example`;' },
  { key: 'seed-baseline',label: 'Seed data',   sql: "INSERT INTO `example` (name) VALUES\n  ('First record'),\n  ('Second record');" },
  { key: 'drop-table',   label: 'Drop table',  sql: 'DROP TABLE IF EXISTS `example`;' }
];
