const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('meihuaDesktop', {
  version: process.env.npm_package_version || '0.1.0',
  platform: process.platform,
  serviceRoot: process.env.MEIHUA_STUDIO_ROOT || '',
});