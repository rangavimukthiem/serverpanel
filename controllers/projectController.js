const {
  listProjectsForUser,
  findProjectById,
  createProject,
  getProjectMembership,
  upsertProjectMember,
  removeProjectMember
} = require('../models/projectModel');
const { findUserById } = require('../models/userModel');
const { createLog } = require('../models/logModel');

const PROJECT_ROLE_SET = new Set(['manager', 'user']);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

async function listProjects(req, res, next) {
  try {
    const projects = await listProjectsForUser(req.user);
    return res.json({ projects });
  } catch (error) {
    return next(error);
  }
}

async function createManagedProject(req, res, next) {
  try {
    const { name, slug, path, status = 'active' } = req.body;

    if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 120) {
      return res.status(400).json({ message: 'Project name must be 2-120 characters' });
    }

    if (!SLUG_PATTERN.test(slug || '')) {
      return res.status(400).json({ message: 'Slug must be lowercase letters, numbers, and dashes' });
    }

    if (typeof path !== 'string' || !path.startsWith('/srv/') || path.length > 255) {
      return res.status(400).json({ message: 'Project path must be an absolute /srv path' });
    }

    const project = await createProject({
      name: name.trim(),
      slug,
      path,
      status
    });

    await createLog({ userId: req.user.id, action: `created project ${project.name}` });

    return res.status(201).json({ project });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Project slug already exists' });
    }

    return next(error);
  }
}

async function setProjectMember(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    const { userId, role = 'user' } = req.body;
    const memberUserId = Number(userId);

    if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(memberUserId) || memberUserId <= 0) {
      return res.status(400).json({ message: 'Invalid project or user id' });
    }

    if (!PROJECT_ROLE_SET.has(role)) {
      return res.status(400).json({ message: 'Invalid project role' });
    }

    const project = await findProjectById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const targetUser = await findUserById(memberUserId);
    if (!targetUser) {
      return res.status(404).json({ message: 'User not found' });
    }

    const canManage = await canManageProjectMembers(req.user, projectId, role);
    if (!canManage) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    await upsertProjectMember({ projectId, userId: memberUserId, role });
    await createLog({
      userId: req.user.id,
      action: `set ${targetUser.username} as ${role} on project ${project.name}`
    });

    return res.json({ message: 'Project member saved' });
  } catch (error) {
    return next(error);
  }
}

async function deleteProjectMember(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    const memberUserId = Number(req.params.userId);

    if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(memberUserId) || memberUserId <= 0) {
      return res.status(400).json({ message: 'Invalid project or user id' });
    }

    const project = await findProjectById(projectId);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const canManage = await canManageProjectMembers(req.user, projectId, 'user');
    if (!canManage) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    await removeProjectMember({ projectId, userId: memberUserId });
    await createLog({ userId: req.user.id, action: `removed user ${memberUserId} from project ${project.name}` });

    return res.json({ message: 'Project member removed' });
  } catch (error) {
    return next(error);
  }
}

async function canManageProjectMembers(user, projectId, assignedRole) {
  if (user.role === 'admin') {
    return true;
  }

  const membership = await getProjectMembership(projectId, user.id);

  if (membership?.role !== 'manager') {
    return false;
  }

  return assignedRole === 'user';
}

module.exports = {
  listProjects,
  createManagedProject,
  setProjectMember,
  deleteProjectMember
};
