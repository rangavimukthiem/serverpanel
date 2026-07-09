/**
 * projectGit.js — Git operations tab: init, clone, pull, push, status.
 */

import { api } from '../shared/api.js';
import { escapeHtml } from '../shared/dom.js';
import { reportGlobalError } from '../shared/errors.js';

function writeOutput(text) {
  const el = document.getElementById('gitOutput');
  if (!el) return;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + text;
  el.scrollTop = el.scrollHeight;
}

function clearOutput() {
  const el = document.getElementById('gitOutput');
  if (el) el.textContent = '';
}

async function loadGitStatus(project) {
  const pre = document.getElementById('gitStatusOut');
  if (!pre) return;
  pre.textContent = 'Loading…';
  try {
    const data = await api(`/api/projects/${project.id}/git/status`);
    let text = '';
    if (data.branch) text += `Branch: ${data.branch}\n\n`;
    if (data.status) text += `--- Status ---\n${data.status}\n\n`;
    if (data.log)    text += `--- Log ---\n${data.log}`;
    pre.textContent = text || 'Repository is clean.';
  } catch (_) {
    pre.textContent = 'No git repository found at project path.';
  }
}

export function loadGitTab(project) {
  // Pre-fill form fields
  const urlInput    = document.getElementById('gitRepoUrl');
  const branchInput = document.getElementById('gitBranch');
  if (urlInput)    urlInput.value    = project.git_repo_url || '';
  if (branchInput) branchInput.value = project.git_branch   || 'main';

  loadGitStatus(project);
  bindGitActions(project);
}

function bindGitActions(project) {
  function freshBind(id, handler) {
    const el = document.getElementById(id);
    if (!el) return;
    const f = el.cloneNode(true);
    el.replaceWith(f);
    f.addEventListener('click', handler);
  }

  // Refresh status
  freshBind('refreshGitStatus', () => loadGitStatus(project));

  // Init
  freshBind('gitInit', async () => {
    const repoUrl = document.getElementById('gitRepoUrl')?.value.trim();
    const branch  = document.getElementById('gitBranch')?.value.trim() || 'main';
    clearOutput();
    writeOutput(`git init${repoUrl ? ` + remote ${repoUrl}` : ''}…`);
    try {
      const data = await api(`/api/projects/${project.id}/git/init`, {
        method: 'POST',
        body: JSON.stringify({ repoUrl, branch })
      });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git init');
    }
  });

  // Clone
  freshBind('gitClone', async () => {
    const repoUrl = document.getElementById('gitRepoUrl')?.value.trim();
    const branch  = document.getElementById('gitBranch')?.value.trim() || 'main';
    if (!repoUrl) { writeOutput('✗ Repo URL is required for clone'); return; }
    clearOutput();
    writeOutput(`git clone ${repoUrl} (${branch})…`);
    try {
      const data = await api(`/api/projects/${project.id}/git/clone`, {
        method: 'POST',
        body: JSON.stringify({ repoUrl, branch })
      });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
      window.dispatchEvent(new CustomEvent('projectRefreshNeeded'));
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git clone');
    }
  });

  // Pull
  freshBind('gitPull', async () => {
    clearOutput();
    writeOutput(`git pull origin ${project.git_branch || 'main'}…`);
    try {
      const data = await api(`/api/projects/${project.id}/git/pull`, { method: 'POST' });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git pull');
    }
  });

  // Push
  freshBind('gitPush', async () => {
    const msg = document.getElementById('commitMsg')?.value.trim();
    clearOutput();
    writeOutput(`git add -A && git commit && git push…`);
    try {
      const data = await api(`/api/projects/${project.id}/git/push`, {
        method: 'POST',
        body: JSON.stringify({ message: msg })
      });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git push');
    }
  });
}
