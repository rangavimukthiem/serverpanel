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
  const remotes = document.getElementById('gitRemotesOut');
  const summary = document.getElementById('gitSummary');
  const history = document.getElementById('gitHistory');
  if (!pre) return;
  pre.textContent = 'Loading…';
  if (remotes) remotes.textContent = 'Loading…';
  if (history) history.innerHTML = '';
  try {
    const data = await api(`/api/projects/${project.id}/git/status`);
    if (!data.hasRepo) throw new Error('No repository');

    const stagedCount = data.staged ? data.staged.split('\n').filter(Boolean).length : 0;
    const unstagedCount = data.unstaged ? data.unstaged.split('\n').filter(Boolean).length : 0;
    const untrackedCount = data.status
      ? data.status.split('\n').filter((line) => line.startsWith('??')).length
      : 0;
    const currentStage = stagedCount
      ? 'Ready to commit'
      : (unstagedCount || untrackedCount ? 'Working tree changes' : 'Clean / committed');

    if (summary) {
      summary.innerHTML = [
        `Branch: ${escapeHtml(data.branch || 'detached')}`,
        `Stage: ${currentStage}`,
        `Staged: ${stagedCount}`,
        `Modified: ${unstagedCount}`,
        `Untracked: ${untrackedCount}`,
        data.tracking ? `Tracking: ${escapeHtml(data.tracking)}` : ''
      ].filter(Boolean).map((item) => `<span>${item}</span>`).join('');
    }

    const statusSections = [];
    if (data.staged) statusSections.push(`STAGED\n${data.staged}`);
    if (data.unstaged) statusSections.push(`NOT STAGED\n${data.unstaged}`);
    const untracked = (data.status || '').split('\n').filter((line) => line.startsWith('??')).join('\n');
    if (untracked) statusSections.push(`UNTRACKED\n${untracked}`);
    pre.textContent = statusSections.join('\n\n') || 'Working tree is clean.';
    if (remotes) remotes.textContent = data.remotes || 'No remotes configured.';

    if (history) {
      history.innerHTML = data.history?.length
        ? data.history.map((entry) => `
          <article class="git-history-item">
            <span class="git-history-hash">${escapeHtml(entry.hash)}</span>
            <span class="git-history-subject">${escapeHtml(entry.subject)}</span>
            <span class="git-history-meta">${escapeHtml(entry.author)} · ${escapeHtml(entry.date)}</span>
          </article>
        `).join('')
        : '<p class="message">No commits yet.</p>';
    }
  } catch (_) {
    pre.textContent = 'No git repository found at project path.';
    if (remotes) remotes.textContent = 'No remotes available.';
    if (summary) summary.innerHTML = '<span>Not initialized</span>';
    if (history) history.innerHTML = '<p class="message">No version history available.</p>';
  }
}

export function loadGitTab(project) {
  // Pre-fill form fields
  const urlInput = document.getElementById('gitRepoUrl');
  const branchInput = document.getElementById('gitBranch');
  if (urlInput) urlInput.value = project.git_repo_url || '';
  if (branchInput) branchInput.value = project.git_branch || 'main';

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
    const branch = document.getElementById('gitBranch')?.value.trim() || 'main';
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
    const branch = document.getElementById('gitBranch')?.value.trim() || 'main';
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

  // Fetch all remote references without changing the working tree
  freshBind('gitFetch', async () => {
    clearOutput();
    writeOutput('git fetch --all --prune…');
    try {
      const data = await api(`/api/projects/${project.id}/git/fetch`, { method: 'POST' });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git fetch');
    }
  });

  // Forced pull
  freshBind('gitPullForce', async () => {
    clearOutput();
    writeOutput(`git pull --force origin ${project.git_branch || 'main'}…`);
    try {
      const data = await api(`/api/projects/${project.id}/git/pull/force`, { method: 'POST' });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git forced pull');
    }
  });

  // Stash tracked and untracked changes
  freshBind('gitStash', async () => {
    clearOutput();
    writeOutput('git stash push --include-untracked…');
    try {
      const data = await api(`/api/projects/${project.id}/git/stash`, { method: 'POST' });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git stash');
    }
  });

  // Remove remote
  freshBind('gitRemoveRemote', async () => {
    clearOutput();
    writeOutput('git remote remove origin…');
    try {
      const data = await api(`/api/projects/${project.id}/git/remove-remote`, {
        method: 'POST',
        body: JSON.stringify({ remoteName: 'origin' })
      });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git remove remote');
    }
  });

  // Push
  freshBind('gitStage', async () => {
    clearOutput();
    writeOutput('git add -A…');
    try {
      const data = await api(`/api/projects/${project.id}/git/stage`, { method: 'POST' });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git stage');
    }
  });

  freshBind('gitUnstage', async () => {
    clearOutput();
    writeOutput('git reset HEAD -- .…');
    try {
      const data = await api(`/api/projects/${project.id}/git/unstage`, { method: 'POST' });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git unstage');
    }
  });

  freshBind('gitCommit', async () => {
    const message = document.getElementById('commitMsg')?.value.trim();
    if (!message) { writeOutput('✗ Commit message is required'); return; }
    clearOutput();
    writeOutput('git commit…');
    try {
      const data = await api(`/api/projects/${project.id}/git/commit`, {
        method: 'POST',
        body: JSON.stringify({ message })
      });
      writeOutput(data.output || data.message);
      await loadGitStatus(project);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'Git commit');
    }
  });

  // Commit all changes and push in one deployment action
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

  // NPM Install
  freshBind('npmInstall', async () => {
    clearOutput();
    writeOutput(`npm install (this may take a while)…`);
    try {
      const data = await api(`/api/projects/${project.id}/npm/install`, { method: 'POST' });
      writeOutput(data.output || data.message);
    } catch (err) {
      writeOutput(`✗ ${err.message}`);
      reportGlobalError(err, 'NPM Install');
    }
  });
}
