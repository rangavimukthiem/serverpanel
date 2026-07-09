export const services = ['nginx', 'mysql', 'mariadb', 'apache2'];

export const databaseQueryPresets = [
  { key: 'create-database', label: 'Create DB' },
  { key: 'grant-access', label: 'Grant Access' },
  { key: 'create-schema', label: 'Schema' },
  { key: 'seed-baseline', label: 'Seed Data' }
];

export const apiEndpointPresets = [
  { key: 'health', label: 'Health' },
  { key: 'auth', label: 'Auth' },
  { key: 'resources', label: 'Resources' },
  { key: 'custom-crud', label: 'CRUD' }
];

export const apiEndpointPresetMap = {
  health: { name: 'Health', method: 'GET', path: '/health', description: 'Service health check' },
  auth: { name: 'Auth', method: 'POST', path: '/auth/login', description: 'Login or token exchange' },
  resources: { name: 'Resources', method: 'GET', path: '/resources', description: 'List resources' },
  'custom-crud': { name: 'CRUD', method: 'POST', path: '/items', description: 'Replace with your resource path' }
};
