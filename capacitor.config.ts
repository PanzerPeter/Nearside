import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.nearside',
  appName: 'Nearside',
  webDir: 'dist',
  plugins: {
    // The local mirror holds every message this device decrypted, so its file
    // is SQLCipher-encrypted; without these flags the plugin refuses to store a
    // passphrase at all (`lib/localdb.ts` `ensureSecret`).
    CapacitorSQLite: {
      androidIsEncryption: true,
      iosIsEncryption: true,
      iosKeychainPrefix: 'nearside',
    },
  },
};

export default config;
