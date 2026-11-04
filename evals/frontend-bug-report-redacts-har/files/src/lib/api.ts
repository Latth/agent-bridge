const API = process.env.NEXT_PUBLIC_API_URL!;

export async function api(path: string, init: RequestInit = {}) {
  const auth = JSON.parse(localStorage.getItem('acme.auth') ?? '{}');
  console.debug('auth state', auth); // TODO remove: logs tokens
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'X-Request-Id': `req_${Math.random().toString(16).slice(2, 6)}`,
      ...(auth.accessToken ? { Authorization: `Bearer ${auth.accessToken}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json();
}
