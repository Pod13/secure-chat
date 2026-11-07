import { defineConfig, devices } from '@playwright/test';

// Browser matrix for FR-060: Chrome, Safari (WebKit), Firefox and Edge.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:4173' },
  webServer: {
    command: 'npm run build && vite preview --port 4173',
    port: 4173,
    reuseExistingServer: false,
  },
  projects: [
    { name: 'chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
    { name: 'android', use: { ...devices['Pixel 7'] } },
    { name: 'iphone', use: { ...devices['iPhone 14'] } },
  ],
});
