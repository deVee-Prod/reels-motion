"use client";
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const HomeClient = dynamic(() => import('./home-client'), { ssr: false });

export default function ClientWrapper() {
  const [authStatus, setAuthStatus] = useState<'checking' | 'login' | 'ok'>('checking');

  useEffect(() => {
    import('./supabaseClient').then(({ supabase }) => {
      supabase.auth.getSession().then(({ data: { session } }: { data: { session: unknown } }) => {
        setAuthStatus(session ? 'ok' : 'login');
      });
    });
  }, []);

  const handleGoogleSignIn = () => {
    import('./supabaseClient').then(({ supabase }) => {
      supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.href },
      });
    });
  };

  if (authStatus === 'checking') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>
          Verifying Access to deVee Tools...
        </p>
      </div>
    );
  }

  if (authStatus === 'login') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif', marginBottom: '0.5rem' }}>
          Verifying Access to deVee Tools...
        </p>
        <button onClick={handleGoogleSignIn} style={{ backgroundColor: '#fff', color: '#000', border: 'none', borderRadius: '9999px', padding: '0.75rem 2rem', fontSize: '0.8rem', fontFamily: 'sans-serif', fontWeight: 700, letterSpacing: '0.1em', cursor: 'pointer', textTransform: 'uppercase' }}>
          Sign in with Google
        </button>
        <a href="https://devee-music.com" style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', fontFamily: 'sans-serif', textDecoration: 'none', letterSpacing: '0.05em' }}>
          ← Back to deVee Music
        </a>
      </div>
    );
  }

  return <HomeClient />;
}
