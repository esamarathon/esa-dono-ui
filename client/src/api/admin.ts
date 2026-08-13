import axios, { type AxiosInstance } from 'axios';

const adminClient: AxiosInstance = axios.create({ baseURL: '/api/admin' });

adminClient.interceptors.request.use((config) => {
  const key = localStorage.getItem('admin_key');
  if (key) config.headers['X-Admin-Key'] = key;
  return config;
});

export async function getDonors(q = '', offset = 0) {
  const { data } = await adminClient.get('/donors', { params: { q, offset } });
  return data;
}

export async function getDonorWallet(id: string) {
  const { data } = await adminClient.get(`/donors/${id}`);
  return data;
}

export async function revokeDonorToken(id: string) {
  const { data } = await adminClient.post(`/donors/${id}/revoke-token`);
  return data;
}

export async function regenerateDonorToken(id: string) {
  const { data } = await adminClient.post(`/donors/${id}/regenerate-token`);
  return data;
}

export async function toggleDonorFreeze(id: string, frozen: boolean) {
  const { data } = await adminClient.post(`/donors/${id}/freeze`, { frozen });
  return data;
}

export async function setDonorRole(id: string, role: 'USER' | 'MODERATOR' | 'ADMIN') {
  const { data } = await adminClient.patch(`/donors/${id}/role`, { role });
  return data;
}

export async function adjustDonorBalance(
  id: string,
  amount_cents: number,
  reason: string | null,
  type: string,
) {
  const { data } = await adminClient.post(`/donors/${id}/adjust-balance`, {
    amount_cents,
    reason,
    type,
  });
  return data;
}

export async function reverseDonorSpend(id: string, spend_type: string, spend_id: string) {
  const { data } = await adminClient.post(`/donors/${id}/reverse-spend`, { spend_type, spend_id });
  return data;
}

export async function getClaims() {
  const { data } = await adminClient.get('/claims');
  return data;
}

export async function updateClaimStatus(id: string, status: string) {
  const { data } = await adminClient.patch(`/claims/${id}`, { status });
  return data;
}

export default adminClient;
