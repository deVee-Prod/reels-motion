"use client";
import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

const HomeClient = dynamic(() => import('./home-client'), { ssr: false });

export default function ClientWrapper() {
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    import('./supabaseClient').then(({ supabase }) => {
      supabase.auth.getSession().then(({ data: { session } }: { data: { session: unknown } }) => {
        if (session) {
          setAuthenticated(true);
        } else {
          supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.href },
          });
        }
      });
    });
  }, []);

  if (!authenticated) {
    return (
      <div style={{
        position: 'fixed', inset: 0, backgroundColor: '#000',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <p style={{ color: '#fff', fontSize: '1.125rem', fontFamily: 'sans-serif' }}>
          Verifying Access to deVee Tools...
        </p>
      </div>
    );
  }

  return <HomeClient />;
}
