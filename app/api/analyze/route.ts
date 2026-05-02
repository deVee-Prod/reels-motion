import { NextResponse } from 'next/server';
import OpenAI from 'openai';

export const maxDuration = 120;

const SILENT_SCALES = [1.1, 1.2, 1.15, 1.25, 1.1, 1.3];

function fillSilentRange(start: number, end: number, scaleOffset: number) {
  const INTERVAL = 2.5;
  const fills: { start: number; end: number; scale: number; text: string }[] = [];
  let t = start;
  let i = scaleOffset;
  while (t < end - 0.3) {
    const segEnd = Math.min(t + INTERVAL, end);
    fills.push({ start: parseFloat(t.toFixed(3)), end: parseFloat(segEnd.toFixed(3)), scale: SILENT_SCALES[i % SILENT_SCALES.length], text: '(instrumental)' });
    i++;
    t = segEnd;
  }
  return fills;
}

export async function POST(req: Request) {
  const cookie = req.headers.get('cookie') || '';
  if (!cookie.includes('devee_auth=1')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let step = 'init';
  try {
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'OPENAI_API_KEY is not set on the server' }, { status: 500 });
    }

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    step = 'formData';
    const formData = await req.formData();
    const audioBlob = formData.get('audio') as Blob;
    const videoDuration = parseFloat((formData.get('duration') as string) || '0');

    if (!audioBlob) {
      return NextResponse.json({ error: 'No audio provided' }, { status: 400 });
    }

    step = 'whisper';
    const audioFile = new File([audioBlob], 'audio.mp3', { type: 'audio/mp3' });
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'],
    });

    const words = transcription.words || [];

    // If no speech at all, fill entire video with silent zoom events
    if (words.length === 0) {
      const zoomEvents = fillSilentRange(0, videoDuration, 0);
      return NextResponse.json({ zoomEvents });
    }

    const wordList = words
      .map(w => `[${w.start.toFixed(2)}-${w.end.toFixed(2)}s] ${w.word}`)
      .join('\n');

    step = 'gpt4o';
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
- Never create a segment shorter than 0.8 seconds — group short words with adjacent phrases
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

    step = 'parse';
    const raw = completion.choices[0].message.content || '[]';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    let zoomEvents = JSON.parse(cleaned) as Array<{ start: number; end: number; scale: number; text?: string }>;

    zoomEvents = zoomEvents
      .filter(e => typeof e.start === 'number' && typeof e.end === 'number' && e.end > e.start)
      .sort((a, b) => a.start - b.start)
      .map(e => ({
        start: parseFloat(Math.max(0, e.start).toFixed(3)),
        end: parseFloat(Math.min(e.end, videoDuration || e.end).toFixed(3)),
        scale: parseFloat(Math.max(1.0, Math.min(e.scale ?? 1.0, 1.5)).toFixed(3)),
        text: e.text || '',
      }));

    // Merge segments shorter than 0.8s into their neighbor to avoid glitch-like rapid cuts
    const MIN_DURATION = 0.8;
    const merged: typeof zoomEvents = [];
    for (const event of zoomEvents) {
      if (merged.length > 0 && (event.end - event.start) < MIN_DURATION) {
        merged[merged.length - 1] = { ...merged[merged.length - 1], end: event.end };
      } else {
        merged.push({ ...event });
      }
    }
    zoomEvents = merged;

    // Fill silent sections (no speech) with gentle periodic zoom events
    const firstWord = words[0].start;
    const lastWord = words[words.length - 1].end;
    const firstEvent = zoomEvents[0];
    const lastEvent = zoomEvents[zoomEvents.length - 1];
    const extraEvents: typeof zoomEvents = [];

    if (firstEvent && firstWord > 1.0) {
      extraEvents.push(...fillSilentRange(0, firstWord, 0));
    }
    if (lastEvent && videoDuration - lastWord > 1.0) {
      extraEvents.push(...fillSilentRange(lastWord, videoDuration, 2));
    }

    if (extraEvents.length > 0) {
      zoomEvents = [...extraEvents, ...zoomEvents].sort((a, b) => a.start - b.start);
    }

    // Handle gaps between consecutive events
    const SILENT_GAP_THRESHOLD = 2.0; // gaps longer than this get animated zoom movement
    const gapFills: typeof zoomEvents = [];

    for (let i = 0; i < zoomEvents.length - 1; i++) {
      const gapStart = zoomEvents[i].end;
      const gapEnd = zoomEvents[i + 1].start;
      const gapDuration = gapEnd - gapStart;

      if (gapDuration > SILENT_GAP_THRESHOLD) {
        // Large gap (music/instrumental) → animated zoom movement
        gapFills.push(...fillSilentRange(gapStart, gapEnd, i));
      } else if (gapDuration > 0.01) {
        // Small gap → extend previous event to meet next
        zoomEvents[i] = { ...zoomEvents[i], end: gapEnd };
      }
    }

    if (gapFills.length > 0) {
      zoomEvents = [...zoomEvents, ...gapFills].sort((a, b) => a.start - b.start);
    }

    return NextResponse.json({ zoomEvents });
  } catch (error: any) {
    console.error(`Analyze error at step [${step}]:`, error);
    return NextResponse.json(
      { error: `[${step}] ${error.message ?? String(error)}` },
      { status: 500 }
    );
  }
}
