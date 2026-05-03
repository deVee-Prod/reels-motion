"use client";
import { useEffect, useState } from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';

const HomeClient = dynamic(() => import('./home-client'), { ssr: false });

export default function ClientWrapper() {
  const [status, setStatus] = useState<'checking' | 'authorized' | 'login'>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch('/api/auth/check')
      .then(r => r.json())
      .then(d => setStatus(d.ok ? 'authorized' : 'login'))
      .catch(() => setStatus('login'));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    setLoading(false);
    if (res.ok) {
      setStatus('authorized');
    } else {
      setError('Wrong password');
    }
  };

  if (status === 'checking') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>Verifying Access...</p>
      </div>
    );
  }

  if (status === 'login') {
    return (
      <div className="min-h-[100dvh] bg-[#050505] flex flex-col items-center text-center">
        <header className="space-y-2 pt-8 pb-6 relative">
          <div className="absolute top-6 left-1/2 -translate-x-1/2 w-56 h-20 bg-white blur-[55px] opacity-[0.07] pointer-events-none" />
          <Image src="/logo.png" alt="Logo" width={100} height={32} className="mx-auto opacity-90 relative" />
          <p className="text-[9px] tracking-[0.3em] text-white/70 font-bold uppercase">REELS MOTION</p>
        </header>
        <main className="flex-1 flex flex-col justify-center w-full max-w-[340px] px-4">
          <form onSubmit={handleLogin} className="space-y-4 bg-[#0c0c0c]/40 p-8 rounded-[24px] border border-white/5 backdrop-blur-xl w-full">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-white/[0.02] border border-white/5 rounded-xl py-3 px-4 text-white text-center tracking-[0.4em] text-[9px] focus:outline-none"
              placeholder="ACCESS KEY"
            />
            {error && <p className="text-red-400 text-[9px] tracking-widest">{error}</p>}
            <button type="submit" disabled={loading} className="w-full py-3 bg-white text-black rounded-xl uppercase tracking-[0.3em] text-[8px] font-black">
              {loading ? '...' : 'Enter'}
            </button>
          </form>
        </main>
      </div>
    );
  }

  return <HomeClient />;
}
