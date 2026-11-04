'use client';
import { useState } from 'react';
import { api } from '@/lib/api';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  async function submit(form: FormData) {
    try {
      await api('/v2/auth/chip-login', { method: 'POST', body: JSON.stringify({ chipNumber: form.get('chip'), pin: form.get('pin') }) });
      location.href = '/';
    } catch (e: any) {
      if (e.status === 401) setError('PIN hatalı');
      else if (e.status === 423) setError('Çok fazla deneme. Kartınız geçici olarak kilitlendi.');
      else setError('Bir hata oluştu');
    }
  }
  return (
    <form action={submit}>
      <label>Chip number <input name="chip" /></label>
      <label>PIN <input name="pin" type="password" /></label>
      <button>Log in</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
