const fs = require('fs/promises');
const { config } = require('./config');
const { getStore, updateStore } = require('./storage');

function getPaymentSettings() {
  const settings = getStore().settings || {};

  return {
    paymentCard: settings.paymentCard || config.paymentCard || '',
    paymentOwner: settings.paymentOwner || config.paymentOwner || '',
    paymentAmount: settings.paymentAmount || config.paymentAmount || '',
    paymentNote: config.paymentNote || '',
  };
}

async function seedPaymentSettings() {
  await updateStore((store) => {
    store.settings = store.settings || {};

    if (!store.settings.paymentCard && config.paymentCard) {
      store.settings.paymentCard = config.paymentCard;
    }

    if (!store.settings.paymentOwner && config.paymentOwner) {
      store.settings.paymentOwner = config.paymentOwner;
    }

    if (!store.settings.paymentAmount && config.paymentAmount) {
      store.settings.paymentAmount = config.paymentAmount;
    }
  });
}

function serializeEnvValue(value) {
  if (value === '') {
    return '';
  }

  return /[\s#"'`]/.test(value) ? JSON.stringify(value) : value;
}

async function writeEnvValue(name, value) {
  let content = '';

  try {
    content = await fs.readFile(config.envFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const line = `${name}=${serializeEnvValue(value)}`;
  const matcher = new RegExp(`^${name}=.*$`, 'm');

  if (matcher.test(content)) {
    content = content.replace(matcher, line);
  } else {
    content = content.trimEnd();
    content = content ? `${content}\n${line}\n` : `${line}\n`;
  }

  await fs.writeFile(config.envFile, content, 'utf8');
  process.env[name] = value;
}

async function updatePaymentSetting(field, value) {
  const fieldToEnv = {
    paymentCard: 'PAYMENT_CARD',
    paymentOwner: 'PAYMENT_OWNER',
    paymentAmount: 'PAYMENT_AMOUNT',
  };

  const envName = fieldToEnv[field];
  if (!envName) {
    throw new Error(`Unsupported payment setting: ${field}`);
  }

  await updateStore((store) => {
    store.settings = store.settings || {};
    store.settings[field] = value;
  });

  await writeEnvValue(envName, value);
}

module.exports = {
  getPaymentSettings,
  seedPaymentSettings,
  updatePaymentSetting,
};
