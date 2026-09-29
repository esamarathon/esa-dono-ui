import axios, { type AxiosInstance } from 'axios';

// withCredentials sends the httpOnly donor session cookie (a MODERATOR/ADMIN
// donor authenticates that way). The operational moderator key is a separate
// operator secret sent as an Authorization Bearer credential (ADR 0004).
const moderatorClient: AxiosInstance = axios.create({
  baseURL: '/api/moderator',
  withCredentials: true,
});

moderatorClient.interceptors.request.use((config) => {
  const moderatorKey = localStorage.getItem('moderator_key');
  // When an operational moderator key is stored it is always sent as a Bearer
  // credential — the server checks the key before the donor path, so this never
  // conflicts with a donor session cookie (which rides along via withCredentials).
  if (moderatorKey) {
    config.headers.Authorization = `Bearer key_mod_${moderatorKey}`;
  }
  return config;
});

export default moderatorClient;
