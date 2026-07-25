import axios, { type AxiosInstance } from 'axios';

const client: AxiosInstance = axios.create({ baseURL: '/api' });

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('donor_token');
  if (token) {
    config.params = { ...config.params, token };
  }
  return config;
});

export default client;
