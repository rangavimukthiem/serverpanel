'use strict';

/**
 * projectGitController.js
 *
 * Git operations for a project's deployment path.
 * All commands use execFile (no shell interpolation).
 * SSH-based auth is expected; keys must be configured on the VPS for the
 * process user. For HTTPS, set a credential helper or use a .netrc file.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');

const { findProjectById, updateProjectFields, getProjectMembership } = require('../models/projectModel');
const { createLog } = require('../models/logModel');
const { AppError } = require('../errors/AppError');

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT = 30000; // 30 s — network ops (clone/pull/push) may need this
const GIT_HISTORY_LIMIT = 10;

// ─── Access ───────────────────────────────────────────────────────────────────

async function canManage(user, projectId) {
  if (user.role === 'admin') return true;
  const membership = await getProjectMembership(projectId, user.id);
  return membership?.role === 'manager';
}

function requireLinux(res) {
  if (process.platform === 'win32') {
    res.status(503).json({ message: 'Git shell operations are only available on Linux hosts.' });
    return false;
  }
  return true;
}

// ─── Shared git runner ────────────────────────────────────────────────────────

async function runGit(args, cwd) {
  try {
    const result = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), ok: true };
  } catch (error) {
    return {
      stdout: (error.stdout || '').trim(),
      stderr: (error.stderr || error.message || '').trim(),
      ok: false
    };
  }
}

// ─── Endpoints ────────────────────────────────────────────────────────────────

/**
 * GET /api/projects/:id/git/status
 *
 * Returns working-tree/staging status, remotes, current branch and recent history.
 */
async function status(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    const canView = req.user.role === 'admin' ||
      Boolean(await getProjectMembership(projectId, req.user.id));
    if (!canView) return res.status(403).json({ message: 'Project access required' });

    const [statusResult, logResult, branchResult, remoteResult, stagedResult, unstagedResult] = await Promise.all([
      runGit(['status', '--short', '--branch'], project.path),
      runGit(['log', `-${GIT_HISTORY_LIMIT}`, '--date=short', '--pretty=format:%h%x1f%ad%x1f%an%x1f%s'], project.path),
      runGit(['branch', '--show-current'], project.path),
      runGit(['remote', '-v'], project.path),
      runGit(['diff', '--cached', '--name-status'], project.path),
      runGit(['diff', '--name-status'], project.path)
    ]);

    const statusLines = statusResult.stdout.split('\n').filter(Boolean);
    const history = logResult.ok && logResult.stdout
      ? logResult.stdout.split('\n').map((line) => {
        const [hash, date, author, ...subject] = line.split('\x1f');
        return { hash, date, author, subject: subject.join('\x1f') };
      })
      : [];

    return res.json({
      status: statusLines.filter((line) => !line.startsWith('## ')).join('\n'),
      tracking: statusLines.find((line) => line.startsWith('## '))?.slice(3) || '',
      staged: stagedResult.stdout,
      unstaged: unstagedResult.stdout,
      log: history.map((entry) => `${entry.hash} ${entry.subject}`).join('\n'),
      history,
      branch: branchResult.stdout || project.git_branch,
      remotes: remoteResult.stdout,
      repoUrl: project.git_repo_url,
      hasRepo: statusResult.ok
    });
  } catch (error) {
    return next(error);
  }
}

async function runWorkingTreeOperation(req, res, next, operation) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const definitions = {
      stage: { args: ['add', '-A'], success: 'All changes staged', label: 'git add -A' },
      unstage: { args: ['reset', 'HEAD', '--', '.'], success: 'All changes unstaged', label: 'git reset HEAD' },
      fetch: { args: ['fetch', '--all', '--prune'], success: 'Remote references updated', label: 'git fetch --all --prune' }
    };
    const definition = definitions[operation];
    let args = definition.args;
    if (operation === 'unstage') {
      const hasHead = await runGit(['rev-parse', '--verify', 'HEAD'], project.path);
      if (!hasHead.ok) args = ['rm', '--cached', '-r', '--ignore-unmatch', '.'];
    }
    const result = await runGit(args, project.path);
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

    await createLog({ userId: req.user.id, action: `${definition.label} on project ${project.name}` });
    if (!result.ok) {
      return res.status(422).json({ message: output || `${definition.label} failed`, ok: false, output });
    }
    return res.json({ message: definition.success, ok: true, output });
  } catch (error) {
    return next(error);
  }
}

function stage(req, res, next) {
  return runWorkingTreeOperation(req, res, next, 'stage');
}

function unstage(req, res, next) {
  return runWorkingTreeOperation(req, res, next, 'unstage');
}

function fetchRemotes(req, res, next) {
  return runWorkingTreeOperation(req, res, next, 'fetch');
}

async function commit(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 500) {
      return res.status(400).json({ message: 'Commit message is required and must be at most 500 characters' });
    }

    const result = await runGit(['commit', '-m', message], project.path);
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    await createLog({ userId: req.user.id, action: `git commit on project ${project.name}: "${message}"` });
    if (!result.ok) {
      return res.status(422).json({ message: output || 'Git commit failed', ok: false, output });
    }
    return res.json({ message: 'Commit created', ok: true, output });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/git/init
 *
 * Body: { repoUrl?, branch? }
 *
 * Runs `git init` in the project path.
 * If repoUrl is provided, also adds it as the 'origin' remote.
 */
async function init(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const repoUrl = (req.body.repoUrl || '').trim();
    const branch = (req.body.branch || project.git_branch || 'main').trim();

    const initResult = await runGit(['init', '-b', branch], project.path);
    const lines = [initResult.stdout, initResult.stderr].filter(Boolean);

    if (repoUrl) {
      // Remove existing origin if any, then add the new one
      await runGit(['remote', 'remove', 'origin'], project.path);
      const remoteResult = await runGit(['remote', 'add', 'origin', repoUrl], project.path);
      lines.push(remoteResult.stdout, remoteResult.stderr);
      await updateProjectFields(projectId, { git_repo_url: repoUrl, git_branch: branch });
    }

    await createLog({ userId: req.user.id, action: `git init for project ${project.name}` });
    return res.json({ message: 'Repository initialised', output: lines.filter(Boolean).join('\n') });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/git/clone
 *
 * Body: { repoUrl, branch? }
 *
 * Clones a remote repository into the project path.
 * The project path must exist but be empty (or contain only the scaffold).
 */
async function clone(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const repoUrl = (req.body.repoUrl || '').trim();
    const branch = (req.body.branch || project.git_branch || 'main').trim();

    if (!repoUrl) {
      return res.status(400).json({ message: 'repoUrl is required' });
    }

    const args = ['clone', '--branch', branch, '--single-branch', repoUrl, '.'];
    const result = await runGit(args, project.path);

    await updateProjectFields(projectId, { git_repo_url: repoUrl, git_branch: branch });
    await createLog({ userId: req.user.id, action: `cloned ${repoUrl} into project ${project.name}` });

    return res.json({
      message: result.ok ? 'Repository cloned' : 'Clone encountered errors',
      ok: result.ok,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n')
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/git/pull
 *
 * Pulls the latest changes from origin for the configured branch.
 */
async function pull(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const branch = project.git_branch || 'main';
    const result = await runGit(['pull', 'origin', branch], project.path);

    await createLog({ userId: req.user.id, action: `git pull on project ${project.name}` });

    return res.json({
      message: result.ok ? 'Pull complete' : 'Pull encountered errors',
      ok: result.ok,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n')
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/git/pull/force
 *
 * Force-pulls the latest changes from origin for the configured branch.
 */
async function pullForced(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const branch = project.git_branch || 'main';
    const result = await runGit(['pull', '--force', 'origin', branch], project.path);

    await createLog({ userId: req.user.id, action: `git pull --force on project ${project.name}` });

    return res.json({
      message: result.ok ? 'Forced pull complete' : 'Forced pull encountered errors',
      ok: result.ok,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n')
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/git/stash
 *
 * Stashes tracked and untracked working-tree changes.
 */
async function stash(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const result = await runGit(['stash', 'push', '--include-untracked'], project.path);

    await createLog({ userId: req.user.id, action: `git stash on project ${project.name}` });

    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (!result.ok) {
      return res.status(422).json({
        message: output || 'Git stash failed',
        ok: false,
        output
      });
    }

    return res.json({
      message: 'Changes stashed',
      ok: true,
      output: output || 'No local changes to save'
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/git/remove-remote
 *
 * Removes the configured remote from the repository.
 */
async function removeRemote(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const remoteName = (req.body.remoteName || 'origin').trim() || 'origin';
    const result = await runGit(['remote', 'remove', remoteName], project.path);

    await createLog({ userId: req.user.id, action: `git remote remove ${remoteName} on project ${project.name}` });

    return res.json({
      message: result.ok ? 'Remote removed' : 'Remote removal encountered errors',
      ok: result.ok,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n')
    });
  } catch (error) {
    return next(error);
  }
}

/**
 * POST /api/projects/:id/git/push
 *
 * Body: { message? } — commit message (defaults to timestamp)
 *
 * Stages all changes, creates a commit, and pushes to origin.
 */
async function push(req, res, next) {
  try {
    const projectId = Number(req.params.id);
    if (!Number.isInteger(projectId) || projectId <= 0) {
      return res.status(400).json({ message: 'Invalid project id' });
    }
    if (!requireLinux(res)) return;

    const project = await findProjectById(projectId);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    if (!(await canManage(req.user, projectId))) {
      return res.status(403).json({ message: 'Project manager access required' });
    }

    const commitMessage = (req.body.message || '').trim() ||
      `deploy: ${new Date().toISOString()} [EKAFY]`;
    const branch = project.git_branch || 'main';

    const addResult = await runGit(['add', '-A'], project.path);
    const commitResult = await runGit(['commit', '-m', commitMessage], project.path);
    const pushResult = await runGit(['push', 'origin', branch], project.path);

    await createLog({ userId: req.user.id, action: `git push on project ${project.name}: "${commitMessage}"` });

    const output = [addResult.stdout, commitResult.stdout, commitResult.stderr, pushResult.stdout, pushResult.stderr]
      .filter(Boolean).join('\n');

    return res.json({
      message: pushResult.ok ? 'Push complete' : 'Push encountered errors',
      ok: pushResult.ok,
      output
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  status,
  init,
  clone,
  pull,
  pullForced,
  fetchRemotes,
  stage,
  unstage,
  commit,
  stash,
  removeRemote,
  push
};
