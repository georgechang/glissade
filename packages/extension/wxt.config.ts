import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Page Capture — scroll to MP4',
    description: 'Record the current tab scrolling into a smooth MP4 for slide decks.',
    permissions: ['tabCapture', 'offscreen', 'activeTab', 'scripting', 'downloads'],
    host_permissions: ['http://*/*', 'https://*/*'],
  },
});
