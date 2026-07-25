import { vi } from 'vitest';

// Reset localStorage before each test
beforeEach(() => {
  localStorage.clear();
});

// Silence console.error in tests unless DEBUG is set
if (!process.env.DEBUG) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
