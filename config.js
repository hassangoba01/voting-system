// Settings. On Railway these come from the "Variables" tab; locally the defaults below are used.
const path = require('path');

const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH; // set automatically when a Volume is attached

if (onRailway) {
  if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
    throw new Error('Set ADMIN_PASSWORD and SESSION_SECRET in the Railway Variables tab, then redeploy.');
  }
  if (!volume && !process.env.DATA_DIR) {
    console.warn('WARNING: no Volume attached. Votes and photos will be LOST on every redeploy or restart.');
  }
}

module.exports = {
  PORT: process.env.PORT || 3000,
  ELECTION_NAME: process.env.ELECTION_NAME || 'MEI LUANAR Chapter Elections',
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'admin1234', // hashed in memory at startup
  SESSION_SECRET: process.env.SESSION_SECRET || 'local-dev-secret-change-me',
  DATA_DIR: process.env.DATA_DIR || (volume ? path.join(volume, 'db') : path.join(__dirname, 'data')),
  UPLOADS_DIR: process.env.UPLOADS_DIR || (volume ? path.join(volume, 'uploads') : path.join(__dirname, 'uploads'))
};
