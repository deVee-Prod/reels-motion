"use client";

import { useState, useEffect, useRef } from 'react';
import Image from 'next/image';

interface ZoomEvent {
  start: number;
  end: number;
  scale: number;
  text: string;
}

const formatTime = (t: number) => {
  if (isNaN(t)) return "00:00";
  return `${Math.floor(t/60).toString().padStart(2,'0')}:${Math.floor(t%60).toString().padStart(2,'0')}`;
};

// Effective scale: base zoom + AI variation modulated by intensity
function effectiveScale(aiScale: number, intensity: number, baseZoom: number): number {
  return Math.max(1.0, 1 + (aiScale - 1) * intensity + (baseZoom - 1));
}

// Build filter_complex: trim+scale+crop per segment, with optional zoompan transitions
function buildFilterComplex(
  events: ZoomEvent[],
  w: number, h: number,
  totalDuration: number,
  intensity: number,
  baseZoom: number,
  transitionDuration: number, // 0 = instant snap, >0 = smooth transition in seconds
  motion: string
): string {
  const sorted = [...events].sort((a, b) => a.start - b.start);

  // Build full timeline with gap-filling
  const segs: Array<{ start: number; end: number; scale: number }> = [];
  let cursor = 0;
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    if (e.start > cursor + 0.01) {
      const prevScale = i > 0 ? effectiveScale(sorted[i - 1].scale, intensity, baseZoom) : effectiveScale(e.scale, intensity, baseZoom);
      segs.push({ start: cursor, end: e.start, scale: prevScale });
    }
    segs.push({ start: e.start, end: e.end, scale: effectiveScale(e.scale, intensity, baseZoom) });
    cursor = e.end;
  }
  if (cursor < totalDuration - 0.01) {
    const lastScale = sorted.length > 0 ? effectiveScale(sorted[sorted.length - 1].scale, intensity, baseZoom) : effectiveScale(1.0, intensity, baseZoom);
    segs.push({ start: cursor, end: totalDuration, scale: lastScale });
  }

  // Expand into final segments (main + optional transition at each boundary)
  type Seg = { start: number; end: number; scale: number; transition?: { from: number; to: number } };
  const D = transitionDuration;
  const finalSegs: Seg[] = [];

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const next = segs[i + 1];
    const hasTrans = D > 0.02 && next !== undefined;
    const mainEnd = hasTrans ? seg.end - D / 2 : seg.end;
    const mainStart = i > 0 && D > 0.02 ? seg.start + D / 2 : seg.start;

    if (mainStart < mainEnd - 0.01) {
      finalSegs.push({ start: mainStart, end: mainEnd, scale: seg.scale });
    }
    if (hasTrans) {
      finalSegs.push({
        start: seg.end - D / 2,
        end: seg.end + D / 2,
        scale: seg.scale,
        transition: { from: seg.scale, to: next.scale },
      });
    }
  }

  const n = finalSegs.length;
  const splitPart = `[0:v]split=${n}${finalSegs.map((_, i) => `[v${i}]`).join('')}`;

  const segParts = finalSegs.map((seg, i) => {
    const trim = `trim=start=${seg.start.toFixed(3)}:end=${seg.end.toFixed(3)},setpts=PTS-STARTPTS`;
    const dur = (seg.end - seg.start).toFixed(3);
    if (seg.transition) {
      // Short zoompan transition from one scale to another
      const { from, to } = seg.transition;
      return `[v${i}]${trim},zoompan=z='${from.toFixed(4)}+(${(to - from).toFixed(4)})*t/${dur}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}[seg${i}]`;
    }
    if (motion === 'slow_zoom') {
      const from = seg.scale;
      const to = seg.scale + (i % 2 === 0 ? 0.08 : -0.05);
      return `[v${i}]${trim},zoompan=z='${from.toFixed(4)}+(${(to - from).toFixed(4)})*t/${dur}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}[seg${i}]`;
    }
    if (Math.abs(seg.scale - 1.0) < 0.005) {
      return `[v${i}]${trim}[seg${i}]`;
    }
    const sw = Math.ceil((w * seg.scale) / 2) * 2;
    const sh = Math.ceil((h * seg.scale) / 2) * 2;
    const cx = Math.floor((sw - w) / 2);
    const cy = Math.floor((sh - h) / 2);
    return `[v${i}]${trim},scale=${sw}:${sh},crop=${w}:${h}:${cx}:${cy}[seg${i}]`;
  });

  const concatPart = `${finalSegs.map((_, i) => `[seg${i}]`).join('')}concat=n=${n}:v=1:a=0[outv]`;
  return [splitPart, ...segParts, concatPart].join(';');
}

const PRESETS = [
  { id: 'dynamic_snap', name: 'Dynamic Snap', intensity: 1.0, base: 1.0, speed: 1.0, density: 'normal', motion: 'static' },
  { id: 'smooth_cinematic', name: 'Smooth Cinematic', intensity: 0.8, base: 1.05, speed: 0.0, density: 'low', motion: 'slow_zoom' },
  { id: 'aggressive_cuts', name: 'Aggressive Cuts', intensity: 1.5, base: 1.0, speed: 1.0, density: 'high', motion: 'static' },
  { id: 'subtle_motion', name: 'Subtle Motion', intensity: 0.5, base: 1.0, speed: 0.2, density: 'normal', motion: 'slow_zoom' },
  { id: 'vlog_style', name: 'Vlog Style', intensity: 1.2, base: 1.02, speed: 0.8, density: 'high', motion: 'static' },
  { id: 'high_energy', name: 'High Energy', intensity: 1.8, base: 1.05, speed: 1.0, density: 'very_high', motion: 'static' },
  { id: 'documentary', name: 'Documentary', intensity: 0.6, base: 1.1, speed: 0.0, density: 'low', motion: 'slow_zoom' },
];

export default function Home() {
  const [authorized, setAuthorized] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [videoPreview, setVideoPreview] = useState<string | null>(null);
  const [zoomEvents, setZoomEvents] = useState<ZoomEvent[]>([]);
  const [originalEvents, setOriginalEvents] = useState<ZoomEvent[]>([]);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activePreset, setActivePreset] = useState('dynamic_snap');
  const [intensityScale, setIntensityScale] = useState(1);
  const [baseZoom, setBaseZoom] = useState(1.0);
  const [snapSpeed, setSnapSpeed] = useState(1.0); // 1=instant, 0=0.4s transition
  const [density, setDensity] = useState('normal');
  const [motion, setMotion] = useState('static');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const ffmpegRef = useRef<any>(null);
  const requestRef = useRef<number | null>(null);
  const videoObjRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const zoomEventsRef = useRef<ZoomEvent[]>([]);
  const intensityRef = useRef(1);
  const baseZoomRef = useRef(1.0);
  const snapSpeedRef = useRef(1.0);
  const motionRef = useRef('static');
  const hasAutoAnalyzed = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const durationRef = useRef(0);

  useEffect(() => { durationRef.current = duration; }, [duration]);

  useEffect(() => { zoomEventsRef.current = zoomEvents; }, [zoomEvents]);
  useEffect(() => { intensityRef.current = intensityScale; }, [intensityScale]);
  useEffect(() => { baseZoomRef.current = baseZoom; }, [baseZoom]);
  useEffect(() => { snapSpeedRef.current = snapSpeed; }, [snapSpeed]);
  useEffect(() => { motionRef.current = motion; }, [motion]);

  useEffect(() => {
    if (originalEvents.length === 0) {
      setZoomEvents([]);
      return;
    }
    let processed = [...originalEvents];
    if (density === 'high' || density === 'very_high') {
      const maxDur = density === 'very_high' ? 0.6 : 1.2;
      const splitEvents: ZoomEvent[] = [];
      processed.forEach(ev => {
        const dur = ev.end - ev.start;
        if (dur > maxDur) {
          const chunks = Math.ceil(dur / maxDur);
          const chunkDur = dur / chunks;
          for (let i = 0; i < chunks; i++) {
            splitEvents.push({
              start: ev.start + i * chunkDur,
              end: ev.start + (i + 1) * chunkDur,
              scale: ev.scale * (i % 2 === 1 ? 1.1 : 1.0),
              text: ev.text
            });
          }
        } else {
          splitEvents.push(ev);
        }
      });
      processed = splitEvents;
    } else if (density === 'low') {
      const mergedEvents: ZoomEvent[] = [];
      let current: ZoomEvent | null = null;
      processed.forEach(ev => {
        if (!current) {
          current = { ...ev };
        } else {
          if (current.end - current.start < 2.5) {
            current.end = ev.end;
            current.text += ' ' + ev.text;
          } else {
            mergedEvents.push(current);
            current = { ...ev };
          }
        }
      });
      if (current) mergedEvents.push(current);
      processed = mergedEvents;
    }
    setZoomEvents(processed);
  }, [density, originalEvents]);

  const syncAndDraw = () => {
    const video = videoObjRef.current;
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (video && audio && canvas) {
      if (!video.paused && !video.ended) {
        const ctx = canvas.getContext('2d');
        if (ctx && video.videoWidth > 0) {
          if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          const t = audio.currentTime;
          const events = zoomEventsRef.current;
          const intensity = intensityRef.current;
          const base = baseZoomRef.current;
          const transD = (1 - snapSpeedRef.current) * 0.4; // 0=snap, 0.4s=smooth

          const getEffective = (aiScale: number) => Math.max(1.0, 1 + (aiScale - 1) * intensity + (base - 1));

          const curSegIndex = events.findIndex(z => t >= z.start && t < z.end);
          const curSeg = curSegIndex >= 0 ? events[curSegIndex] : undefined;
          const prevSeg = [...events].reverse().find(z => z.end <= t);
          const nextSeg = events.find(z => z.start > t);

          let curScale = getEffective(curSeg?.scale ?? 1.0);
          const prevScale = getEffective(prevSeg?.scale ?? 1.0);
          const nextScale = getEffective(nextSeg?.scale ?? 1.0);

          if (curSeg && motionRef.current === 'slow_zoom') {
             const progress = (t - curSeg.start) / (curSeg.end - curSeg.start);
             const toScale = curScale + (curSegIndex % 2 === 0 ? 0.08 : -0.05);
             curScale = curScale + (toScale - curScale) * progress;
          }

          let zoom = curScale;
          if (transD > 0.01 && curSeg) {
            const intoSeg = t - curSeg.start;
            const toEnd = curSeg.end - t;
            if (intoSeg < transD / 2 && prevSeg) {
              zoom = prevScale + (curScale - prevScale) * (intoSeg / (transD / 2));
            } else if (toEnd < transD / 2 && nextSeg) {
              zoom = curScale + (nextScale - curScale) * ((transD / 2 - toEnd) / (transD / 2));
            }
          } else if (!curSeg) {
            if (prevSeg && nextSeg && transD > 0.01) {
              const progress = (t - prevSeg.end) / (nextSeg.start - prevSeg.end);
              zoom = prevScale + (nextScale - prevScale) * Math.max(0, Math.min(1, progress));
            } else if (prevSeg) {
              zoom = prevScale;
            } else if (nextSeg) {
              zoom = nextScale;
            }
          }

          if (zoom > 1.001) {
            const sw = video.videoWidth / zoom;
            const sh = video.videoHeight / zoom;
            ctx.drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
          } else {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          }
          if (Math.abs(video.currentTime - audio.currentTime) > 0.2) video.currentTime = audio.currentTime;
        }
      }
      if (!audio.paused && !audio.ended) {
        setCurrentTime(audio.currentTime);
        if (scrollContainerRef.current && timelineRef.current && !isDraggingRef.current && durationRef.current > 0) {
          const container = scrollContainerRef.current;
          const playheadX = (audio.currentTime / durationRef.current) * timelineRef.current.offsetWidth;
          container.scrollLeft = playheadX - container.offsetWidth / 2;
        }
      }
    }
    requestRef.current = requestAnimationFrame(syncAndDraw);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(syncAndDraw);
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, []);

  useEffect(() => {
    if (document.cookie.includes('session_access')) { setAuthorized(true); loadFFmpeg(); }
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    if (videoPreview) URL.revokeObjectURL(videoPreview);
    hasAutoAnalyzed.current = false;
    setFile(f); setZoomEvents([]); setOriginalEvents([]); setIsPlaying(false); setCurrentTime(0);
    const url = URL.createObjectURL(new Blob([await f.arrayBuffer()], { type: f.type }));
    setVideoPreview(url);
    const video = document.createElement('video');
    video.src = url; video.muted = true; video.playsInline = true;
    video.addEventListener('loadeddata', () => {
      const ctx = canvasRef.current?.getContext('2d');
      if (ctx && canvasRef.current && video.videoWidth > 0) {
        canvasRef.current.width = video.videoWidth; canvasRef.current.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvasRef.current.width, canvasRef.current.height);
      }
    });
    video.load(); videoObjRef.current = video;
  };

  const togglePlay = async () => {
    const video = videoObjRef.current, audio = audioRef.current;
    if (!video || !audio) return;
    if (audio.paused) {
      video.muted = true;
      try { await video.play(); await audio.play(); setIsPlaying(true); } catch(e) { console.error(e); }
    } else { video.pause(); audio.pause(); setIsPlaying(false); }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const t = parseFloat(e.target.value); setCurrentTime(t);
    if (videoObjRef.current) videoObjRef.current.currentTime = t;
    if (audioRef.current) audioRef.current.currentTime = t;
  };

  const loadFFmpeg = async () => {
    if (ffmpegRef.current) return ffmpegRef.current;
    try {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      const { toBlobURL } = await import('@ffmpeg/util');
      const ffmpeg = new FFmpeg();
      ffmpeg.on('progress', ({ progress }: { progress: number }) => setExportProgress(Math.round(progress * 100)));
      const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      ffmpegRef.current = ffmpeg; return ffmpeg;
    } catch(err) { console.error("FFmpeg Load Error:", err); return null; }
  };

  const handleAnalyze = async () => {
    if (!file) return;
    setIsAnalyzing(true);
    let ffmpeg = ffmpegRef.current;
    if (!ffmpeg) ffmpeg = await loadFFmpeg();
    if (!ffmpeg) { setIsAnalyzing(false); return; }
    const { fetchFile } = await import('@ffmpeg/util');
    const ext = file.name.split('.').pop()?.toLowerCase() || 'mp4';
    try {
      await ffmpeg.writeFile(`input.${ext}`, await fetchFile(file));
      await ffmpeg.exec(['-i', `input.${ext}`, '-vn', '-ar', '16000', '-ac', '1', '-ab', '48k', 'audio.mp3']);
      const data = await ffmpeg.readFile('audio.mp3');
      const formData = new FormData();
      formData.append('audio', new Blob([data as any], { type: 'audio/mp3' }));
      formData.append('duration', String(duration));
      const res = await fetch('/api/analyze', { method: 'POST', body: formData });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Server ${res.status}: ${errText}`);
      }
      const result = await res.json();
      if (result.error) { alert(result.error); return; }
      if (result.zoomEvents?.length > 0) setOriginalEvents(result.zoomEvents);
      await ffmpeg.deleteFile(`input.${ext}`); await ffmpeg.deleteFile('audio.mp3');
    } catch(err: any) { alert(`Error: ${err.message}`); } finally { setIsAnalyzing(false); }
  };

  useEffect(() => {
    if (file && duration > 0 && !hasAutoAnalyzed.current && !isAnalyzing) {
      hasAutoAnalyzed.current = true;
      handleAnalyze();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, duration]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Allow inputs like password to work normally
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'button') return;
      if (e.code === 'Space') {
        e.preventDefault();
        const video = videoObjRef.current, audio = audioRef.current;
        if (!video || !audio) return;
        if (audio.paused) {
          video.muted = true;
          video.play().then(() => audio.play()).then(() => setIsPlaying(true)).catch(console.error);
        } else {
          video.pause(); audio.pause(); setIsPlaying(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const exportVideo = async () => {
    if (!file) return;
    setIsExporting(true); setExportProgress(0);
    let ffmpeg = ffmpegRef.current;
    if (!ffmpeg) ffmpeg = await loadFFmpeg();
    if (!ffmpeg) { setIsExporting(false); return; }
    const { fetchFile } = await import('@ffmpeg/util');
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'mp4';
      const inp = `input_${Date.now()}.${ext}`, out = `output_${Date.now()}.mp4`;
      const w = videoObjRef.current?.videoWidth || 1080;
      const h = videoObjRef.current?.videoHeight || 1920;
      // ensure even dimensions (libx264 requirement)
      const safeW = Math.floor(w / 2) * 2;
      const safeH = Math.floor(h / 2) * 2;

      await ffmpeg.writeFile(inp, await fetchFile(file));

      const transitionDuration = (1 - snapSpeed) * 0.4;
      let args: string[];
      if (zoomEvents.length > 0) {
        const fc = buildFilterComplex(zoomEvents, safeW, safeH, duration, intensityScale, baseZoom, transitionDuration, motion);
        args = ['-i', inp, '-filter_complex', fc, '-map', '[outv]', '-map', '0:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'copy', out];
      } else {
        args = ['-i', inp, '-vf', `scale=${safeW}:${safeH},format=yuv420p`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'copy', out];
      }

      const result = await ffmpeg.exec(args);
      if (result !== 0) throw new Error("Encoding failed");

      const outData = await ffmpeg.readFile(out);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([outData as any], { type: 'video/mp4' }));
      a.download = `reels_motion_${Date.now()}.mp4`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      await ffmpeg.deleteFile(inp); await ffmpeg.deleteFile(out);
    } catch(err: any) { alert("Export failed: " + err.message); }
    finally { setIsExporting(false); setExportProgress(0); }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault(); setLoginLoading(true);
    try {
      const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (res.ok) { setAuthorized(true); loadFFmpeg(); }
      else { setLoginError(true); setPassword(''); setTimeout(() => setLoginError(false), 2000); }
    } catch(err) { console.error(err); } finally { setLoginLoading(false); }
  };

  const handleDragStart = (index: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActivePreset('custom');
    isDraggingRef.current = true;
    
    const startX = e.clientX;
    const initialEnd = zoomEvents[index].end;
    const minTime = zoomEvents[index].start + 0.2;
    const maxTime = index < zoomEvents.length - 1 ? zoomEvents[index + 1].end - 0.2 : duration;

    const trackWidth = timelineRef.current?.clientWidth || 800;
    const secondsPerPixel = duration / trackWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      let newTime = initialEnd + (deltaX * secondsPerPixel);
      newTime = Math.max(minTime, Math.min(newTime, maxTime));
      
      setZoomEvents(prev => {
        const next = [...prev];
        next[index] = { ...next[index], end: newTime };
        if (index < next.length - 1) {
          next[index + 1] = { ...next[index + 1], start: newTime };
        }
        return next;
      });
    };

    const handlePointerUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleScrubStart = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    isDraggingRef.current = true;
    
    const wasPlaying = isPlaying;
    if (wasPlaying) {
      videoObjRef.current?.pause();
      audioRef.current?.pause();
    }

    const trackElement = timelineRef.current;
    if (!trackElement) return;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const rect = trackElement.getBoundingClientRect();
      const clickX = moveEvent.clientX - rect.left;
      let targetTime = (clickX / rect.width) * duration;
      targetTime = Math.max(0, Math.min(targetTime, duration));
      
      setCurrentTime(targetTime);
      if (videoObjRef.current) videoObjRef.current.currentTime = targetTime;
      if (audioRef.current) audioRef.current.currentTime = targetTime;
    };

    const handlePointerUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      if (wasPlaying) {
        videoObjRef.current?.play().catch(() => {});
        audioRef.current?.play().catch(() => {});
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const activeEvent = zoomEvents.find(z => currentTime >= z.start && currentTime < z.end);



  if (!authorized) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center text-center">
        <header className="w-full relative z-20 flex flex-col items-center shrink-0 mt-8 mb-6">
        <img src="/logo.png" alt="deVee" className="w-[100px] h-[100px] mb-2 object-contain" />
        <h1 className="text-[10px] font-bold tracking-[0.5em] uppercase text-white/60">REELS MOTION</h1>
      </header>
        <main className="flex-1 flex flex-col justify-center w-full max-w-[340px] px-4">
          <div className="mb-8 flex flex-col items-center gap-3 text-center">
            <div className="flex items-center gap-2">
              <div className="h-px w-8 bg-[#888888]/30" />
              <span className="text-[#888888] text-[9px] tracking-[0.35em] uppercase font-semibold">Audio Visualizer</span>
              <div className="h-px w-8 bg-[#888888]/30" />
            </div>
            <p className="text-white text-[11px] tracking-[0.05em] font-light uppercase">Dynamic Motion Graphics</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4 bg-[#0c0c0c]/40 p-8 rounded-[24px] border border-white/5 backdrop-blur-xl w-full">
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className={`w-full bg-white/[0.02] border rounded-xl py-3 px-4 text-white text-center tracking-[0.4em] text-[9px] focus:outline-none placeholder:text-[9px] transition-colors ${loginError ? 'border-red-500/50' : 'border-white/5'}`}
              placeholder="ACCESS KEY"
            />
            <button type="submit" disabled={loginLoading} className="w-full py-3 bg-[#888888] text-white rounded-xl uppercase tracking-[0.3em] text-[8px] font-black shadow-[0_0_30px_rgba(136,136,136,0.3)]">
              {loginLoading ? '...' : 'Enter'}
            </button>
          </form>
        </main>

      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] text-white flex flex-col items-center overflow-y-auto overflow-x-hidden">
      <header className="w-full relative z-20 flex flex-col items-center shrink-0 mt-8 mb-6">
        <img src="/logo.png" alt="deVee" className="w-[100px] h-[100px] mb-2 object-contain" />
        <h1 className="text-[10px] font-bold tracking-[0.5em] uppercase text-white/60">REELS MOTION</h1>
      </header>

      <main className="w-full max-w-2xl mx-auto flex flex-col items-center flex-1 justify-center px-4 md:px-6 space-y-4 md:space-y-6 py-6">
        <div className="w-full space-y-4 md:space-y-6">

          {/* Video Preview */}
          <div className="relative w-full h-[40vh] md:h-auto md:aspect-video bg-[#0c0c0c] border border-white/[0.03] rounded-[24px] md:rounded-[32px] overflow-hidden shadow-2xl flex items-center justify-center">
            {videoPreview ? (
              <div className="relative w-full h-full cursor-pointer" onClick={togglePlay}>
                <audio ref={audioRef} src={videoPreview} preload="auto" className="hidden" playsInline onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} />
                <canvas ref={canvasRef} className="w-full h-full object-contain" />

                {isExporting && (
                  <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-md">
                    <div className="w-48 h-1 bg-white/10 rounded-full overflow-hidden mb-4">
                      <div className="h-full bg-[#888888] transition-all duration-300" style={{ width: `${exportProgress}%` }} />
                    </div>
                    <p className="text-[10px] font-black tracking-[0.5em] text-white uppercase animate-pulse">Rendering {exportProgress}%</p>
                  </div>
                )}

                {isAnalyzing && (
                  <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/70 backdrop-blur-sm">
                    <div className="w-8 h-8 border-2 border-white/10 border-t-[#888888] rounded-full mb-4 animate-spin" />
                    <p className="text-[10px] font-black tracking-[0.5em] text-white uppercase">Analyzing...</p>
                  </div>
                )}

                {!isPlaying && !isExporting && !isAnalyzing && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                    <div className="w-16 h-16 md:w-20 md:h-20 bg-white/10 backdrop-blur-md rounded-full flex items-center justify-center border border-white/20 shadow-2xl">
                      <div className="w-0 h-0 border-t-[10px] border-t-transparent border-l-[18px] border-l-white border-b-[10px] border-b-transparent ml-2" />
                    </div>
                  </div>
                )}

                {activeEvent && (
                  <div className="absolute top-3 right-3 px-2 py-1 rounded-lg bg-[#888888]/20 border border-[#888888]/40 text-[8px] font-black tracking-widest uppercase text-[#aaaaaa]">
                    {(1 + (activeEvent.scale - 1) * intensityScale).toFixed(2)}x
                  </div>
                )}
              </div>
            ) : (
              <div onClick={() => fileInputRef.current?.click()} className="h-48 md:h-64 w-full flex flex-col items-center justify-center cursor-pointer space-y-4">
                <div className="w-12 h-12 rounded-full border border-white/10 flex items-center justify-center mx-auto text-white/20 text-xl">+</div>
                <p className="text-[8px] uppercase tracking-[0.4em] text-white/20 font-bold">Upload Media</p>
                <input type="file" ref={fileInputRef} onChange={handleFileUpload} className="hidden" accept="video/*" />
              </div>
            )}
          </div>

          {/* Unified Advanced Timeline & Playback Controls */}
          {videoPreview && (
            <div className="flex flex-col bg-[#0c0c0c] border border-white/[0.03] rounded-2xl p-4 shadow-inner gap-4">
              <div className="flex items-center justify-between px-2">
                <button onClick={togglePlay} className="w-10 h-10 rounded-full bg-[#888888]/10 border border-[#888888]/20 flex items-center justify-center active:scale-95">
                  {isPlaying
                    ? <div className="flex gap-1"><div className="w-1 h-3 bg-[#888888] rounded-full" /><div className="w-1 h-3 bg-[#888888] rounded-full" /></div>
                    : <div className="w-0 h-0 border-t-[6px] border-t-transparent border-l-[10px] border-l-[#888888] border-b-[6px] border-b-transparent ml-1" />}
                </button>
                <div className="flex gap-2 text-[9px] font-mono text-white/40 uppercase tracking-widest">
                  <span className="text-white bg-white/5 px-2 py-1 rounded-md">{formatTime(currentTime)}</span>
                  <span className="py-1">/</span>
                  <span className="py-1">{formatTime(duration)}</span>
                </div>
              </div>

              {/* Scrollable Track */}
              <div 
                className="overflow-x-auto no-scrollbar pb-4 pt-8 select-none"
                ref={scrollContainerRef}
                style={{ WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}
              >
                <div className="relative h-24" style={{ minWidth: `${Math.max(duration * 60, 800)}px` }} ref={timelineRef}>
                  
                  {/* Timeline Background Track for scrubbing */}
                  <div className="absolute -top-8 -bottom-4 left-0 right-0 cursor-pointer" onClick={(e) => {
                     const rect = e.currentTarget.getBoundingClientRect();
                     const clickX = e.clientX - rect.left;
                     const targetTime = (clickX / rect.width) * duration;
                     setCurrentTime(targetTime);
                     if (videoObjRef.current) videoObjRef.current.currentTime = targetTime;
                     if (audioRef.current) audioRef.current.currentTime = targetTime;
                  }} />

                  {/* Playhead */}
                  {duration > 0 && (
                    <div 
                      className="absolute -top-6 -bottom-4 w-[2px] bg-red-500 z-50 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
                      style={{ left: `${(currentTime / duration) * 100}%` }}
                    >
                      {/* Invisible wider grab area for the line */}
                      <div className="absolute top-0 bottom-0 -left-6 w-12 cursor-ew-resize touch-none" onPointerDown={handleScrubStart} />
                      
                      {/* Top Handle */}
                      <div 
                        className="absolute -top-2 left-1/2 -translate-x-1/2 w-16 h-14 flex items-start justify-center cursor-ew-resize touch-none"
                        onPointerDown={handleScrubStart}
                      >
                        <div className="w-6 h-6 rotate-45 bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.8)] border border-white/30 mt-2" />
                      </div>
                    </div>
                  )}

                  {/* Zoom Events */}
                  {duration > 0 && zoomEvents.length > 0 ? zoomEvents.map((event, i) => {
                     const left = (event.start / duration) * 100;
                     const width = ((event.end - event.start) / duration) * 100;
                     const isActive = currentTime >= event.start && currentTime < event.end;
                     return (
                       <div key={i} className="absolute top-0 bottom-0 group" style={{ left: `${left}%`, width: `${width}%` }}>
                         <div 
                           onClick={(e) => {
                             e.stopPropagation();
                             const rect = e.currentTarget.getBoundingClientRect();
                             const clickX = e.clientX - rect.left;
                             const percentage = clickX / rect.width;
                             const targetTime = event.start + (event.end - event.start) * Math.max(0, Math.min(1, percentage));
                             setCurrentTime(targetTime); 
                             if(videoObjRef.current) videoObjRef.current.currentTime = targetTime; 
                             if(audioRef.current) audioRef.current.currentTime = targetTime; 
                           }}
                           className={`absolute inset-y-1 left-[1px] right-[1px] rounded-xl flex flex-col items-center justify-center p-1 border transition-colors cursor-pointer overflow-hidden ${isActive ? 'bg-[#888888]/30 border-[#888888]' : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05]'}`}
                         >
                           <span className="text-[12px] font-black text-[#aaaaaa] z-10 pointer-events-none">{event.scale.toFixed(2)}x</span>
                           <span className="text-[8px] text-white/40 font-mono mt-1 z-10 pointer-events-none">{formatTime(event.start)} - {formatTime(event.end)}</span>
                           <span className="text-[7px] text-white/30 font-mono mt-0.5 z-10 truncate w-full text-center px-1 pointer-events-none">{event.text}</span>
                           <div className="absolute inset-0 bg-[#888888] opacity-10 pointer-events-none" style={{ opacity: 0.1 + (event.scale - 1) * 0.5 }} />
                         </div>
                         {i < zoomEvents.length - 1 && (
                           <div 
                             className="absolute top-0 bottom-0 -right-4 w-8 z-20 flex items-center justify-center cursor-col-resize touch-none"
                             onPointerDown={(e) => handleDragStart(i, e)}
                           >
                             <div className="w-1.5 h-10 bg-[#888888] rounded-full shadow-[0_0_10px_rgba(0,0,0,0.5)] opacity-50 group-hover:opacity-100 transition-opacity" />
                           </div>
                         )}
                       </div>
                     );
                  }) : (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-[8px] uppercase tracking-[0.3em] text-white/10 font-bold">Waiting for Analysis...</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Presets */}
          <div className="flex items-center space-x-4 bg-white/[0.02] border border-white/5 rounded-2xl p-4">
            <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap">Style Preset</span>
            <div className="relative flex-1">
              <select 
                value={activePreset}
                onChange={(e) => {
                  const val = e.target.value;
                  setActivePreset(val);
                  if (val !== 'custom') {
                    const p = PRESETS.find(p => p.id === val);
                    if (p) {
                      setIntensityScale(p.intensity);
                      setBaseZoom(p.base);
                      setSnapSpeed(p.speed);
                      setDensity(p.density);
                      setMotion(p.motion);
                    }
                  }
                }}
                className="w-full bg-transparent text-[#888888] text-[9px] font-bold uppercase tracking-widest outline-none cursor-pointer appearance-none pr-6"
              >
                <option className="bg-[#0c0c0c]" value="custom">Custom</option>
                {PRESETS.map(p => (
                  <option key={p.id} className="bg-[#0c0c0c]" value={p.id}>{p.name}</option>
                ))}
              </select>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none">
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1 1L5 5L9 1" stroke="#888888" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            </div>
          </div>

          {/* Density */}
          <div className="flex items-center space-x-4 bg-white/[0.02] border border-white/5 rounded-2xl p-4">
            <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap">Cut Density</span>
            <div className="relative flex-1">
              <select value={density} onChange={(e) => { setDensity(e.target.value); setActivePreset('custom'); }} className="w-full bg-transparent text-[#888888] text-[9px] font-bold uppercase tracking-widest outline-none cursor-pointer appearance-none pr-6">
                <option className="bg-[#0c0c0c]" value="low">Low (Fewer Cuts)</option>
                <option className="bg-[#0c0c0c]" value="normal">Normal</option>
                <option className="bg-[#0c0c0c]" value="high">High (More Cuts)</option>
                <option className="bg-[#0c0c0c]" value="very_high">Very High</option>
              </select>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none">
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1 1L5 5L9 1" stroke="#888888" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            </div>
          </div>

          {/* Motion */}
          <div className="flex items-center space-x-4 bg-white/[0.02] border border-white/5 rounded-2xl p-4">
            <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap">Motion</span>
            <div className="relative flex-1">
              <select value={motion} onChange={(e) => { setMotion(e.target.value); setActivePreset('custom'); }} className="w-full bg-transparent text-[#888888] text-[9px] font-bold uppercase tracking-widest outline-none cursor-pointer appearance-none pr-6">
                <option className="bg-[#0c0c0c]" value="static">Static (Hold)</option>
                <option className="bg-[#0c0c0c]" value="slow_zoom">Slow Zoom</option>
              </select>
              <div className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none">
                <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M1 1L5 5L9 1" stroke="#888888" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            </div>
          </div>

          {/* Advanced Settings Dropdown */}
          <details className="group bg-white/[0.02] border border-white/5 rounded-2xl overflow-hidden">
            <summary className="flex items-center justify-between p-4 cursor-pointer outline-none list-none [&::-webkit-details-marker]:hidden">
              <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap">Advanced Settings (Intensity, Base, Speed)</span>
              <svg className="w-3 h-3 text-white/30 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </summary>
            <div className="p-4 pt-0 space-y-4 border-t border-white/5 mt-2">
              {/* Intensity */}
              <div className="flex items-center space-x-4">
                <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap w-16">Intensity</span>
                <input type="range" min="0" max="2" step="0.05" value={intensityScale} onChange={(e) => { setIntensityScale(parseFloat(e.target.value)); setActivePreset('custom'); }} className="flex-1 accent-[#888888]" />
                <span className="text-[8px] font-mono text-[#888888] w-8 text-right">{intensityScale.toFixed(2)}x</span>
              </div>

              {/* Base Zoom */}
              <div className="flex items-center space-x-4">
                <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap w-16">Base</span>
                <input type="range" min="1" max="1.3" step="0.01" value={baseZoom}
                  onChange={(e) => { setBaseZoom(parseFloat(e.target.value)); setActivePreset('custom'); }} className="flex-1 accent-[#888888]" />
                <span className="text-[8px] font-mono text-[#888888] w-8 text-right">{baseZoom.toFixed(2)}x</span>
              </div>

              {/* Speed */}
              <div className="flex items-center space-x-4">
                <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap w-16">Speed</span>
                <input type="range" min="0" max="1" step="0.05" value={snapSpeed}
                  onChange={(e) => { setSnapSpeed(parseFloat(e.target.value)); setActivePreset('custom'); }} className="flex-1 accent-[#888888]" />
                <span className="text-[8px] font-mono text-[#888888] w-10 text-right">{snapSpeed >= 0.95 ? 'SNAP' : `${((1 - snapSpeed) * 400).toFixed(0)}ms`}</span>
              </div>
            </div>
          </details>

          {/* Advanced Timeline moved up */}

          {/* Buttons */}
          <div className="flex flex-col gap-3 md:gap-4 pb-8">
            {zoomEvents.length > 0 && (
              <button onClick={exportVideo} disabled={isExporting || isAnalyzing}
                className={`w-full py-5 rounded-full uppercase tracking-[0.5em] text-[10px] font-black transition-all active:scale-95 ${!isExporting && !isAnalyzing ? 'bg-white text-black shadow-[0_0_40px_rgba(255,255,255,0.2)]' : 'bg-white/5 text-white/20'}`}>
                {isExporting ? `Rendering ${exportProgress}%` : 'DOWNLOAD'}
              </button>
            )}
          </div>

        </div>
      </main>
      

    </div>
  );
}
