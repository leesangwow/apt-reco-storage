import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const sido = req.nextUrl.searchParams.get('sido');

  if (!sido) {
    const { data, error } = await supabase.rpc('get_sido_list');
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json((data ?? []).map((r: { sido: string }) => r.sido));
  }

  const { data, error } = await supabase.rpc('get_gu_list', { p_sido: sido });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}
