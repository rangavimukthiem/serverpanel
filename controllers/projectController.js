const projects = [
  {
    id: 'sample-node-app',
    name: 'Sample Node App',
    path: '/srv/sample-node-app',
    status: 'placeholder'
  }
];

function listProjects(_req, res) {
  res.json({ projects });
}

module.exports = {
  listProjects
};
