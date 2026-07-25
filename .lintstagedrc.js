/* eslint-disable no-undef */
/** @type {import('lint-staged').Config} */
export default {
  '*.{js,jsx,ts,tsx}': (filenames) => {
    const clientFiles = filenames.filter((f) => f.startsWith('client/'));
    const serverFiles = filenames.filter((f) => f.startsWith('server/'));
    const tasks = [];
    if (clientFiles.length)
      tasks.push(`eslint --fix --config client/eslint.config.js ${clientFiles.join(' ')}`);
    if (serverFiles.length)
      tasks.push(`eslint --fix --config server/eslint.config.js ${serverFiles.join(' ')}`);
    tasks.push(`prettier --write ${filenames.join(' ')}`);
    return tasks;
  },
  '*.{json,css,md,yml,yaml}': (filenames) => `prettier --write ${filenames.join(' ')}`,
};
