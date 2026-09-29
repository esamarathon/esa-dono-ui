import axios, { type AxiosInstance } from 'axios';

// Donor auth rides an httpOnly session cookie (ADR 0004); withCredentials lets
// axios send it. No token is attached in JS — the credential is not readable by
// scripts. Operational admin/moderator keys use their own clients.
const client: AxiosInstance = axios.create({ baseURL: '/api', withCredentials: true });

export default client;
