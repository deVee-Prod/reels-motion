"use client";
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const HomeClient = dynamic(() => import('./home-client'), { ssr: false });

function hasDeVeeAuth() {
  return document.cookie.split(';').some(c => c.trim() === 'devee_auth=1');
}

export default function ClientWrapper() {
  const [authStatus, setAuthStatus] = useState<'checking' | 'ok' | 'no_access'>('checking');

  useEffect(() => {
    if (hasDeVeeAuth()) {
      setAuthStatus('ok');
    } else {
      setAuthStatus('no_access');
    }
  }, []);

  if (authStatus === 'checking') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>Verifying Access...</p>
      </div>
    );
  }

  if (authStatus === 'no_access') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.5rem', padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: 'rgba(255,255,255,0.3)', fontSize: '2rem' }}>🔒</p>
        <p style={{ color: '#fff', fontSize: '1.1rem', fontFamily: 'sans-serif', fontWeight: 600, lineHeight: 1.5, maxWidth: 340 }}>
          This is a Premium Tool.<br />Sign in with Google at deVee Music to get access.
        </p>
        <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.9rem', fontFamily: 'sans-serif', lineHeight: 1.6, maxWidth: 320 }}>
          זהו כלי פרימיום.<br />התחבר עם חשבון Google שלך באתר deVee Music כדי לקבל גישה.
        </p>
        <a href="https://devee-music.com" style={{ marginTop: '0.5rem', padding: '0.65rem 2rem', border: '1px solid rgba(255,255,255,0.25)', color: '#fff', fontSize: '0.85rem', fontFamily: 'sans-serif', fontWeight: 600, textDecoration: 'none', letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Sign in at deVee Music
        </a>
        <a href="https://devee-music.com" style={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.7rem', fontFamily: 'sans-serif', textDecoration: 'none', letterSpacing: '0.05em' }}>
          ← Back to deVee Music
        </a>
      </div>
    );
  }

  return <HomeClient />;
}
