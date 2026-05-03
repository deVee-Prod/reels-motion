import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const { cookies } = await import('next/headers');
  const store = await cookies();
  const ok = store.get('session_access')?.value === 'granted';
  return NextResponse.json({ ok });
}
