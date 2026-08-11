'use strict';

const config = require('../backend/config');
const db = require('../backend/pgDatabase');
const storage = require('../backend/storage');

async function main() {
  if (!config.demoMode()) throw new Error('Demo cleanup requires APP_DEPLOYMENT_MODE=demo.');
  await db.initSchema();
  const provider = storage.createLocalStorageProvider({ root: config.storageRoot() });
  let removedGuests = 0;
  let removedFiles = 0;
  while (true) {
    const guests = await db.listExpiredDemoGuests(100);
    if (guests.length === 0) break;
    for (const guest of guests) {
      for (const key of guest.storageKeys) {
        if (!storage.isProjectStorageKey(key)) continue;
        try {
          if (provider.remove(key)) removedFiles += 1;
        } catch (error) {
          console.error(`[demo-cleanup] refusing unsafe or failed storage removal for guest ${guest.userId}: ${error.message}`);
          throw error;
        }
      }
      if (await db.deleteExpiredDemoGuest(guest.userId)) removedGuests += 1;
    }
  }
  console.log(`[demo-cleanup] removed ${removedGuests} expired guests and ${removedFiles} stored files`);
}

main().then(() => db.close()).catch(async (error) => {
  console.error(`[demo-cleanup] failed: ${error.message}`);
  try { await db.close(); } catch { /* best effort */ }
  process.exitCode = 1;
});
