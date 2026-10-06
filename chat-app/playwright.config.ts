import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./tests',testMatch:'*.browser.spec.ts',fullyParallel:false,workers:1,
  use:{baseURL:'http://localhost:5189',browserName:'chromium'},
  webServer:{command:'corepack pnpm exec vite --host localhost --port 5189 --strictPort',url:'http://localhost:5189/tests/passkey-vault.html',reuseExistingServer:false},
});
