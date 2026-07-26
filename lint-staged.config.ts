import type { Configuration } from 'lint-staged';

const config: Configuration = {
  '*.{js,jsx,ts,tsx}': (filenames) => {
    const clientFiles = filenames.filter((f) => f.startsWith('client/'));
    const serverFiles = filenames.filter((f) => f.startsWith('server/'));
    const tasks: string[] = [];
    if (clientFiles.length)
      tasks.push(`eslint --fix --config client/eslint.config.ts ${clientFiles.join(' ')}`);
    if (serverFiles.length)
      tasks.push(`eslint --fix --config server/eslint.config.ts ${serverFiles.join(' ')}`);
    tasks.push(`prettier --write ${filenames.join(' ')}`);
    return tasks;
  },
  '*.{json,css,md,yml,yaml}': (filenames) => `prettier --write ${filenames.join(' ')}`,
};

export default config;
