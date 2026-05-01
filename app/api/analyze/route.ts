import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export const maxDuration = 120;

export async function POST(req: Request) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const cookie = req.headers.get('cookie') || '';
  if (!cookie.includes('session_access')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const audioBlob = formData.get('audio') as Blob;
    const videoDuration = parseFloat((formData.get('duration') as string) || '0');

    if (!audioBlob) {
      return NextResponse.json({ error: 'No audio provided' }, { status: 400 });
    }

    // Step 1: Whisper — get word-level timestamps
    const audioFile = new File([audioBlob], 'audio.mp3', { type: 'audio/mp3' });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    const words = transcription.words || [];
    if (words.length === 0) {
      return NextResponse.json({ error: 'No speech detected' }, { status: 400 });
    }

    // Build word list with timestamps for GPT-4o
    const wordList = words
      .map(w => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}s] ${w.word}`)
      .join('\n');

    // Step 2: GPT-4o groups words into sentences and assigns zoom per sentence
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a video editor. You receive a list of spoken words with timestamps.

Your job:
1. Group the words into natural sentences or short phrases (by meaning, pauses, punctuation)
2. Assign a zoom level to each sentence — each sentence gets ONE zoom level that holds for its entire duration

Return ONLY a valid JSON array, no markdown:
[{"start": <first_word_start_seconds>, "end": <last_word_end_seconds>, "scale": <zoom_level>, "text": "<sentence>"}, ...]

Zoom scale rules:
- Range: 1.0 to 1.35
- 1.0 = normal (no zoom)
- 1.1–1.2 = slight zoom in
- 1.25–1.35 = strong zoom in
- Vary meaningfully: give important/emotional sentences higher zoom
- Never assign the same scale twice in a row — always alternate
- Cover the full transcript from first word to last word`,
        },
        {
          role: 'user',
          content: `Video duration: ${videoDuration}s\n\nWords:\n${wordList}`,
        },
      ],
      temperature: 0.5,
      max_tokens: 3000,
    });

    const raw = completion.choices[0].message.content || '[]';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let zoomEvents = JSON.parse(cleaned);

    // Sanitize
    zoomEvents = (zoomEvents as Array<{ start: number; end: number; scale: number; text?: string }>)
      .filter(e => typeof e.start === 'number' && typeof e.end === 'number' && e.end > e.start)
      .sort((a, b) => a.start - b.start)
      .map(e => ({
        start: parseFloat(Math.max(0, e.start).toFixed(3)),
        end: parseFloat(Math.min(e.end, videoDuration || e.end).toFixed(3)),
        scale: parseFloat(Math.max(1.0, Math.min(e.scale ?? 1.0, 1.5)).toFixed(3)),
        text: e.text || '',
      }));

    return NextResponse.json({ zoomEvents });
  } catch (error: any) {
    console.error('Analyze error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
