const fs = require('fs/promises');
const path = require('path');

const DEFAULT_STORE = {
  meta: {
    lastSequence: 0,
  },
  settings: {
    paymentCard: '',
    paymentOwner: '',
    paymentAmount: '',
  },
  users: {},
  applications: {},
  adminStates: {},
};

let storeFilePath = '';
let store = structuredClone(DEFAULT_STORE);
let writeQueue = Promise.resolve();

function cloneDefaultStore() {
  return structuredClone(DEFAULT_STORE);
}

async function initStorage(filePath) {
  storeFilePath = filePath;
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    store = {
      ...cloneDefaultStore(),
      ...parsed,
      meta: {
        ...cloneDefaultStore().meta,
        ...(parsed.meta || {}),
      },
      settings: {
        ...cloneDefaultStore().settings,
        ...(parsed.settings || {}),
      },
      users: parsed.users || {},
      applications: parsed.applications || {},
      adminStates: parsed.adminStates || {},
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    store = cloneDefaultStore();
    await persist();
  }
}

function getStore() {
  return store;
}

function persist() {
  const payload = JSON.stringify(store, null, 2);
  writeQueue = writeQueue.then(() => fs.writeFile(storeFilePath, payload, 'utf8'));
  return writeQueue;
}

async function updateStore(mutator) {
  const result = mutator(store);
  await persist();
  return result;
}

module.exports = {
  getStore,
  initStorage,
  updateStore,
};
