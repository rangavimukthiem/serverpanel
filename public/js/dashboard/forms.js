import { api } from '../shared/api.js';
import { reportGlobalError } from '../shared/errors.js';
import { redirectOnAuthError } from '../shared/auth.js';
import { loadProjects } from './projects.js';
import { loadUsers } from './users.js';
import { resetProjectWizard, readProjectWizardConfig, renderWizardPreview } from './wizard.js';

export function bindAdminForms() {
  const userForm = document.getElementById('userForm');
  const projectForm = document.getElementById('projectForm');
  const memberForm = document.getElementById('memberForm');
  const message = document.getElementById('accessMessage');
  const usersTable = document.getElementById('usersTable');
  const wizardPreview = document.getElementById('projectWizardPreview');

  const setMessage = (value) => {
    if (message) {
      message.textContent = value;
    }
  };

  if (userForm) {
    userForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setMessage('Creating user...');

      try {
        await api('/api/users', {
          method: 'POST',
          body: JSON.stringify({
            username: userForm.username.value.trim(),
            password: userForm.password.value,
            role: userForm.role.value
          })
        });
        userForm.reset();
        setMessage('User created');
        await loadUsers();
      } catch (error) {
        if (redirectOnAuthError(error)) {
          return;
        }
        reportGlobalError(error, 'Creating user');
        setMessage(error.message);
      }
    });
  }

  if (projectForm) {
    projectForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setMessage('Creating project...');

      try {
        const config = readProjectWizardConfig();
        const data = await api('/api/projects', {
          method: 'POST',
          body: JSON.stringify({
            name: projectForm.name.value.trim(),
            slug: projectForm.slug.value.trim(),
            path: projectForm.path.value.trim(),
            config
          })
        });
        resetProjectWizard();
        if (wizardPreview) {
          renderWizardPreview(wizardPreview, data.wizard);
        }
        setMessage('Project created');
        await loadProjects();
      } catch (error) {
        if (redirectOnAuthError(error)) {
          return;
        }
        reportGlobalError(error, 'Creating project');
        setMessage(error.message);
      }
    });
  }

  if (memberForm) {
    memberForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      setMessage('Saving project member...');

      try {
        await api(`/api/projects/${memberForm.projectId.value}/members`, {
          method: 'PUT',
          body: JSON.stringify({
            userId: Number(memberForm.userId.value),
            role: memberForm.role.value
          })
        });
        memberForm.reset();
        setMessage('Project member saved');
        await Promise.all([loadProjects(), loadUsers()]);
      } catch (error) {
        if (redirectOnAuthError(error)) {
          return;
        }
        reportGlobalError(error, 'Saving project member');
        setMessage(error.message);
      }
    });
  }

  if (usersTable) {
    usersTable.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-user-delete]');
      if (!button) return;

      const userId = button.dataset.userDelete;
      const confirmed = window.confirm('Remove this user from EKAFY? This will delete their account and project access.');
      if (!confirmed) return;

      setMessage('Removing user...');

      try {
        await api(`/api/users/${userId}`, { method: 'DELETE' });
        setMessage('User removed');
        await loadUsers();
      } catch (error) {
        if (redirectOnAuthError(error)) {
          return;
        }
        reportGlobalError(error, 'Removing user');
        setMessage(error.message);
      }
    });
  }
}
