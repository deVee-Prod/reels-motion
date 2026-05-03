"use client";
import { useEffect, useState } from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';

const HomeClient = dynamic(() => import('./home-client'), { ssr: false });

export default function ClientWrapper() {
  const [status, setStatus] = useState<'checking' | 'authorized' | 'denied'>('checking');

  useEffect(() => {
    const authorized = document.cookie.split(';').some(c => c.trim() === 'devee_auth=1');
    setStatus(authorized ? 'authorized' : 'denied');
  }, []);

  if (status === 'checking') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>Verifying Access...</p>
      </div>
    );
  }

  if (status === 'denied') {
    return (
      <div className="min-h-[100dvh] bg-[#050505] flex flex-col items-center justify-center text-center px-4">
        <header className="space-y-2 mb-10 relative">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-56 h-20 bg-white blur-[55px] opacity-[0.07] pointer-events-none" />
          <Image src="/logo.png" alt="Logo" width={100} height={32} className="mx-auto opacity-90 relative" />
          <p className="text-[9px] tracking-[0.3em] text-white/70 font-bold uppercase">REELS MOTION</p>
        </header>
        <p className="text-white/40 text-[10px] tracking-widest uppercase mb-6">Members Only</p>
        <a
          href="https://devee-music.com"
          className="px-6 py-3 bg-white text-black rounded-xl uppercase tracking-[0.3em] text-[8px] font-black"
        >
          Sign In
        </a>
      </div>
    );
  }

  return <HomeClient />;
}
