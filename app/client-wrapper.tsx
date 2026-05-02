"use client";
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const HomeClient = dynamic(() => import('./home-client'), { ssr: false });

export default function ClientWrapper() {
  const [authStatus, setAuthStatus] = useState<'checking' | 'ok' | 'no_access'>('checking');

  useEffect(() => {
    import('./supabaseClient').then(({ supabase }) => {
      supabase.auth.refreshSession().then(({ data, error }: { data: { session: any }, error: unknown }) => {
        if (data.session && !error) {
          supabase
            .from('user_access')
            .select('user_id')
            .eq('user_id', data.session.user.id)
            .single()
            .then(({ data: access }: { data: any }) => {
              setAuthStatus(access ? 'ok' : 'no_access');
            });
        } else {
          supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.href },
          });
        }
      });
    });
  }, []);

  if (authStatus === 'checking') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>
          Verifying Access to deVee Tools...
        </p>
        <a href="https://devee-music.com" style={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.75rem', fontFamily: 'sans-serif', textDecoration: 'none', letterSpacing: '0.05em' }}>
          ← Back to deVee Music
        </a>
      </div>
    );
  }

  if (authStatus === 'no_access') {
    return (
      <div style={{ position: 'fixed', inset: 0, backgroundColor: '#000', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '1.25rem' }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>
          Access requires signing in to deVee Music.
        </p>
        <a href="https://devee-music.com" style={{ backgroundColor: '#fff', color: '#000', borderRadius: '9999px', padding: '0.75rem 2rem', fontSize: '0.8rem', fontFamily: 'sans-serif', fontWeight: 700, letterSpacing: '0.1em', textDecoration: 'none', textTransform: 'uppercase' }}>
          Go to deVee Music
        </a>
      </div>
    );
  }

  return <HomeClient />;
}
