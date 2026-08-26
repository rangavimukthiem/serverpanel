/**
 * state.js — Shared mutable dashboard state.
 */

export const dashboardState = {
  user: null,
  users: [],
  projects: [],
  selectedProject: null  // project object currently shown in the detail drawer
};

let endpointRowCount = 0;

export function nextEndpointRowId() {
  endpointRowCount += 1;
  return endpointRowCount;
}

export function resetEndpointRowCount(count = 0) {
  endpointRowCount = count;
}
