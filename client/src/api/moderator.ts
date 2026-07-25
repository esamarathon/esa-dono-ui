import axios, { type AxiosInstance } from 'axios';

const moderatorClient: AxiosInstance = axios.create({ baseURL: '/api/moderator' });

moderatorClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('donor_token');
  if (token) {
    config.params = { ...config.params, token };
  }
  return config;
});

export default moderatorClient;
