export const dashboardState = {
  user: null,
  projects: [],
  users: []
};

let endpointRowCount = 0;

export function nextEndpointRowId() {
  endpointRowCount += 1;
  return endpointRowCount;
}

export function resetEndpointRowCount(value = 0) {
  endpointRowCount = Number(value) || 0;
}
