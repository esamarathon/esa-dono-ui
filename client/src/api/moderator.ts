import axios, { type AxiosInstance } from 'axios';

const moderatorClient: AxiosInstance = axios.create({ baseURL: '/api/moderator' });

moderatorClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('donor_token');
  if (token) {
    config.params = { ...config.params, token };
  }
  // Operational fallback: grants moderator access independent of the
  // donor magic-link/role system (see server/middleware/moderatorAuth.ts).
  const moderatorKey = localStorage.getItem('moderator_key');
  if (moderatorKey) {
    config.headers['X-Moderator-Key'] = moderatorKey;
  }
  return config;
});

export default moderatorClient;
