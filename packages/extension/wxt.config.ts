import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Page Capture — scroll to MP4',
    description: 'Record the current tab scrolling down the page into a smooth MP4.',
    permissions: ['tabCapture', 'offscreen', 'activeTab', 'scripting', 'downloads', 'storage', 'notifications'],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
});
