// Which operations can run together, for the handlers that start them and the
// controls that offer them. A task marks the app busy, and a connection selects,
// finds or connects to a frame. They are tracked separately, since a frame can
// finish connecting while a task runs, and at most one of each runs at a time.
// Some entries, such as adjust, check actions that start no operation.

// What can hold an operation back, in the order a reason is reported.
const holds = {
  // A display job runs on the frame and outlives this app, which restores it when
  // it connects.
  job: state => Boolean(state.job),
  task: state => Boolean(state.busy),
  connection: state => Boolean(state.connecting),
  processing: state => Boolean(state.processing),
  // An import running, or chosen photos not yet added. Rebuilds resume after a
  // restart, so a pending one does not count.
  imports: state => Boolean(state.importing) || state.imports.some(item => !item.regenerate && item.status !== 'Saved'),
};

// Editing the draft goes on while a frame connects, or with none connected. So
// does work that needs a connected frame: connecting rebuilds stale photos as its
// last step.
const rules = {
  adjust: ['job', 'task'],
  choose: ['job', 'task'],
  connect: ['job', 'task', 'connection'],
  delete: ['job', 'task'],
  discover: ['job', 'task', 'connection'],
  forget: ['job', 'task', 'connection'],
  import: ['job', 'task'],
  lock: ['job', 'task'],
  open: ['job', 'task', 'connection'],
  orientation: ['job', 'task', 'connection'],
  'preview-profile': ['job', 'task', 'connection'],
  // Connecting again to the selected frame is how the app follows a display job.
  reconnect: ['task', 'connection'],
  refresh: ['job', 'task'],
  'select-frame': ['job', 'task', 'connection'],
  // Leaving for the website's Bluetooth setup page.
  setup: ['job', 'task'],
  store: ['job', 'task', 'connection', 'processing'],
  'test-card': ['job', 'task', 'connection'],
  // Reloading or installing replaces the app, so it waits for everything.
  update: ['job', 'task', 'connection', 'processing', 'imports'],
};

const connections = ['connect', 'discover', 'reconnect', 'select-frame'];

export function blocker(state, name) {
  return Object.keys(holds).find(hold => rules[name].includes(hold) && holds[hold](state));
}

export const allowed = (state, name) => !blocker(state, name);

export function begin(state, name) {
  if (connections.includes(name)) state.connection = name;
  else state.operation = name;
}

export function end(state, name) {
  if (connections.includes(name)) state.connection = null;
  else state.operation = null;
}
