const path = require('path');
require('dotenv').config();

const config = {
  botToken: process.env.BOT_TOKEN || '',
  adminId: Number(process.env.ADMIN_ID || 0),
  paymentCard: process.env.PAYMENT_CARD || '',
  paymentOwner: process.env.PAYMENT_OWNER || '',
  paymentAmount: process.env.PAYMENT_AMOUNT || '',
  paymentNote: process.env.PAYMENT_NOTE || '',
  reminderMinutes: Number(process.env.REMINDER_MINUTES || 5),
  dataFile: path.join(process.cwd(), 'data', 'store.json'),
  envFile: path.join(process.cwd(), '.env'),
};

function validateConfig() {
  const missing = [];

  if (!config.botToken) {
    missing.push('BOT_TOKEN');
  }

  if (!config.adminId) {
    missing.push('ADMIN_ID');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

module.exports = {
  config,
  validateConfig,
};
