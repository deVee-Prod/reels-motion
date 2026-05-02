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
  transitionDuration: number  // 0 = instant snap, >0 = smooth transition in seconds
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
    if (seg.transition) {
      // Short zoompan transition from one scale to another
      const { from, to } = seg.transition;
      const dur = (seg.end - seg.start).toFixed(3);
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
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [intensityScale, setIntensityScale] = useState(1);
  const [baseZoom, setBaseZoom] = useState(1.0);
  const [snapSpeed, setSnapSpeed] = useState(1.0); // 1=instant, 0=0.4s transition

  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const ffmpegRef = useRef<any>(null);
  const requestRef = useRef<number | null>(null);
  const videoObjRef = useRef<HTMLVideoElement | null>(null);
  const zoomEventsRef = useRef<ZoomEvent[]>([]);
  const intensityRef = useRef(1);
  const baseZoomRef = useRef(1.0);
  const snapSpeedRef = useRef(1.0);

  useEffect(() => { zoomEventsRef.current = zoomEvents; }, [zoomEvents]);
  useEffect(() => { intensityRef.current = intensityScale; }, [intensityScale]);
  useEffect(() => { baseZoomRef.current = baseZoom; }, [baseZoom]);
  useEffect(() => { snapSpeedRef.current = snapSpeed; }, [snapSpeed]);

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

          const curSeg = events.find(z => t >= z.start && t < z.end);
          const prevSeg = [...events].reverse().find(z => z.end <= t);
          const nextSeg = events.find(z => z.start > t);

          const curScale = getEffective(curSeg?.scale ?? 1.0);
          const prevScale = getEffective(prevSeg?.scale ?? 1.0);
          const nextScale = getEffective(nextSeg?.scale ?? 1.0);

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
            if (prevSeg && nextSeg) {
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
      if (!audio.paused && !audio.ended) setCurrentTime(audio.currentTime);
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
    setFile(f); setZoomEvents([]); setIsPlaying(false); setCurrentTime(0);
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
      if (result.zoomEvents?.length > 0) setZoomEvents(result.zoomEvents);
      await ffmpeg.deleteFile(`input.${ext}`); await ffmpeg.deleteFile('audio.mp3');
    } catch(err: any) { alert(`שגיאה: ${err.message}`); } finally { setIsAnalyzing(false); }
  };

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
        const fc = buildFilterComplex(zoomEvents, safeW, safeH, duration, intensityScale, baseZoom, transitionDuration);
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
    } catch(err: any) { alert("הייצוא נכשל: " + err.message); }
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

  const activeEvent = zoomEvents.find(z => currentTime >= z.start && currentTime < z.end);

  const LabelFooter = () => (
    <footer className="w-full py-12 flex flex-col items-center space-y-4 mt-auto">
      <p className="text-[10px] tracking-[0.2em] font-medium text-white/60">Powered By deVee Boutique Label</p>
      <div className="w-12 h-12 rounded-full overflow-hidden">
        <Image src="/label_logo.jpg" alt="deVee Label" width={48} height={48} className="object-cover" />
      </div>
    </footer>
  );

  if (!authorized) {
    return (
      <div className="min-h-screen bg-[#050505] flex flex-col items-center text-center">
        <header className="space-y-2 pt-8 pb-6 relative">
          <div className="absolute top-6 left-1/2 -translate-x-1/2 w-56 h-20 bg-[#888888] blur-[55px] opacity-[0.25] pointer-events-none" />
          <Image src="/logo.png" alt="deVee" width={100} height={100} className="mx-auto relative rounded-full" />
          <p className="text-[9px] tracking-[0.3em] text-white/70 font-bold uppercase">REELS MOTION</p>
        </header>
        <main className="flex-1 flex flex-col justify-center w-full max-w-[340px] px-4">
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
        <LabelFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center overflow-y-auto overflow-x-hidden">
      <header className="text-center space-y-2 pt-8 pb-6 relative">
        <div className="absolute top-6 left-1/2 -translate-x-1/2 w-56 h-20 bg-[#888888] blur-[55px] opacity-[0.20] pointer-events-none" />
        <Image src="/logo.png" alt="deVee" width={72} height={72} className="opacity-85 mx-auto relative rounded-full" />
        <p className="text-[9px] tracking-[0.3em] text-white/70 font-bold uppercase">REELS MOTION</p>
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

          {/* Playback Controls */}
          {videoPreview && (
            <div className="flex flex-col gap-4 bg-[#0c0c0c] border border-white/[0.03] rounded-2xl p-4 shadow-inner">
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
              <div className="px-2">
                <div className="relative h-5 flex items-center">
                  {duration > 0 && zoomEvents.map((z, i) => (
                    <div key={i} className="absolute top-1/2 -translate-y-1/2 h-3 rounded-sm pointer-events-none"
                      style={{
                        left: `${(z.start / duration) * 100}%`,
                        width: `${Math.max(((z.end - z.start) / duration) * 100, 0.5)}%`,
                        background: `rgba(136,136,136,${0.2 + (z.scale - 1) * 1.5})`,
                      }}
                    />
                  ))}
                  <input type="range" min="0" max={duration || 100} step="0.01" value={currentTime} onChange={handleSeek}
                    className="relative z-10 w-full h-1.5 bg-white/5 rounded-full appearance-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-[#888888] [&::-webkit-slider-thumb]:rounded-full cursor-pointer" />
                </div>
              </div>
            </div>
          )}

          {/* Intensity */}
          {videoPreview && (
            <div className="flex items-center space-x-4 bg-white/[0.02] border border-white/5 rounded-2xl p-4">
              <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap">Intensity</span>
              <input type="range" min="0" max="2" step="0.05" value={intensityScale} onChange={(e) => setIntensityScale(parseFloat(e.target.value))} className="flex-1 accent-[#888888]" />
              <span className="text-[8px] font-mono text-[#888888] w-8 text-right">{intensityScale.toFixed(2)}x</span>
            </div>
          )}

          {/* Base Zoom */}
          {videoPreview && (
            <div className="flex items-center space-x-4 bg-white/[0.02] border border-white/5 rounded-2xl p-4">
              <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap">Base</span>
              <input type="range" min="1" max="1.3" step="0.01" value={baseZoom}
                onChange={(e) => setBaseZoom(parseFloat(e.target.value))} className="flex-1 accent-[#888888]" />
              <span className="text-[8px] font-mono text-[#888888] w-8 text-right">{baseZoom.toFixed(2)}x</span>
            </div>
          )}

          {/* Speed */}
          {videoPreview && (
            <div className="flex items-center space-x-4 bg-white/[0.02] border border-white/5 rounded-2xl p-4">
              <span className="text-[7px] uppercase tracking-[0.3em] text-white/30 font-bold whitespace-nowrap">Speed</span>
              <input type="range" min="0" max="1" step="0.05" value={snapSpeed}
                onChange={(e) => setSnapSpeed(parseFloat(e.target.value))} className="flex-1 accent-[#888888]" />
              <span className="text-[8px] font-mono text-[#888888] w-10 text-right">{snapSpeed >= 0.95 ? 'SNAP' : `${((1 - snapSpeed) * 400).toFixed(0)}ms`}</span>
            </div>
          )}

          {/* Zoom Events Strip */}
          {videoPreview && (
            <div className="h-24 bg-[#0c0c0c] border border-white/[0.03] rounded-2xl p-4 flex gap-3 items-center overflow-x-auto no-scrollbar">
              {zoomEvents.length > 0 ? zoomEvents.map((event, i) => (
                <div key={i}
                  onClick={() => { if(audioRef.current) audioRef.current.currentTime = event.start; if(videoObjRef.current) videoObjRef.current.currentTime = event.start; setCurrentTime(event.start); }}
                  className={`h-full min-w-[110px] max-w-[140px] rounded-xl flex flex-col items-center justify-center p-2 relative transition-all cursor-pointer border ${currentTime >= event.start && currentTime < event.end ? 'bg-[#888888]/30 border-[#888888]' : 'bg-white/[0.02] border-white/5'}`}
                >
                  <span className="text-[10px] font-black text-[#aaaaaa]">{event.scale.toFixed(2)}x</span>
                  <span className="text-[7px] text-white/30 font-mono mt-0.5">{formatTime(event.start)} → {formatTime(event.end)}</span>
                  <span className="text-[6px] text-white/20 font-mono mt-0.5 truncate w-full text-center px-1">{event.text}</span>
                  <button onClick={(e) => { e.stopPropagation(); setZoomEvents(prev => prev.filter((_,idx) => idx !== i)); }}
                    className="absolute -top-1 -right-1 w-4 h-4 bg-red-500/50 rounded-full text-[8px] flex items-center justify-center hover:bg-red-500 transition-colors">✕</button>
                </div>
              )) : (
                <div className="w-full text-center text-[8px] uppercase tracking-[0.3em] text-white/10 font-bold">Waiting for Analysis...</div>
              )}
            </div>
          )}

          {/* Buttons */}
          <div className="flex flex-col gap-3 md:gap-4 pb-8">
            <button onClick={handleAnalyze} disabled={!file || isAnalyzing || isExporting}
              className={`w-full py-4 rounded-full uppercase tracking-[0.4em] text-[9px] font-black transition-all ${file && !isAnalyzing && !isExporting ? 'bg-[#888888] shadow-[0_0_30px_rgba(136,136,136,0.3)]' : 'bg-white/5 text-white/20'}`}>
              {isAnalyzing ? 'Analyzing...' : '1. ANALYZE'}
            </button>
            {zoomEvents.length > 0 && (
              <button onClick={exportVideo} disabled={isExporting || isAnalyzing}
                className={`w-full py-5 rounded-full uppercase tracking-[0.5em] text-[10px] font-black transition-all active:scale-95 ${!isExporting && !isAnalyzing ? 'bg-white text-black shadow-[0_0_40px_rgba(255,255,255,0.2)]' : 'bg-white/5 text-white/20'}`}>
                {isExporting ? `Rendering ${exportProgress}%` : '2. DOWNLOAD'}
              </button>
            )}
          </div>

        </div>
      </main>
      <LabelFooter />
    </div>
  );
}
