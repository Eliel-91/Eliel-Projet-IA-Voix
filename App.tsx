
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { ConnectionStatus, Transcription } from './types';
import { decode, encode, decodeAudioData } from './audioUtils';

// CV Data for context
const ELIEL_CV_CONTEXT = `
Name: Eliel Yolou
Profile: Candidate for MSC 2 Data Management and Finance at Inseec Business School. Highly motivated manager pricing at Carrefour France HQ.
Experience:
- Seal Gestion (Assistant Accountant): April 2025 - Aug 2025. Accounting entries, bank reconciliation, financial statements.
- Keola Consulting (Assistant Accountant): March 2024 - June 2024.
- Le Singulier (Communication & Digital Marketing): March 2023 - June 2023. Marketing strategy, content creation, web maintenance.
Education:
- Inseec Business School: MSC 2 Data Management & Finance (Apprenticeship).
- UPEC: Master 1 AEI Management (Digital transformation, blockchain, risk management).
- IUT Montpellier: B.U.T 3 Gestion des Entreprises et des Administrations.
- Licence 1 Administration and exchanges (UPEC).
- Baccalauréat (Lycée Jacques Prévert).
Languages: French (Native), English (B2), Spanish (B1).
Skills: SQL, Power BI, Trello, Quadra, Microsoft Office.
Interests: Football, Fitness, Digital Tools, Basketball.
`;

const SYSTEM_INSTRUCTION = `
Vous êtes Eliel, l'assistant vocal de Eliel Yolou. 
Votre ton est mature, réfléchi et professionnel. 
Vous parlez français et anglais couramment, avec un léger accent coréen charmant.
Votre rôle est d'aider les recruteurs ou partenaires à découvrir le parcours de Eliel Yolou.
Référez-vous aux informations suivantes sur Eliel : ${ELIEL_CV_CONTEXT}
Règle CRITIQUE : Entamez TOUJOURS la conversation par : « Bonjour, je suis l'assistant de Eliel. Que souhaitez-vous savoir à son sujet ? »
Si on vous pose des questions en dehors du cadre professionnel de Eliel, ramenez poliment la conversation vers ses compétences.
Répondez de manière concise et fluide.
`;

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [isListening, setIsListening] = useState(false);
  
  // Audio Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);

  // Transcription Refs
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    // We keep output audio context for pending playback but clear sources
    audioSourcesRef.current.forEach(source => {
      try { source.stop(); } catch(e) {}
    });
    audioSourcesRef.current.clear();
    
    setStatus(ConnectionStatus.DISCONNECTED);
    setIsListening(false);
  }, []);

  const startSession = async () => {
    try {
      setStatus(ConnectionStatus.CONNECTING);
      
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // Setup contexts
      const inCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioContextRef.current = inCtx;
      outputAudioContextRef.current = outCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          systemInstruction: SYSTEM_INSTRUCTION,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            setIsListening(true);
            
            // Microphone streaming
            const source = inCtx.createMediaStreamSource(stream);
            const processor = inCtx.createScriptProcessor(4096, 1, 1);
            
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const l = inputData.length;
              const int16 = new Int16Array(l);
              for (let i = 0; i < l; i++) {
                int16[i] = inputData[i] * 32768;
              }
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              
              sessionPromise.then(session => {
                if (session && status === ConnectionStatus.CONNECTED) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              });
            };

            source.connect(processor);
            processor.connect(inCtx.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Playback
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              
              source.addEventListener('ended', () => {
                audioSourcesRef.current.delete(source);
              });
              
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              audioSourcesRef.current.add(source);
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              audioSourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              audioSourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Handle Transcription
            if (message.serverContent?.inputTranscription) {
              currentInputTranscription.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputTranscription.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const userText = currentInputTranscription.current.trim();
              const assistantText = currentOutputTranscription.current.trim();
              
              if (userText || assistantText) {
                setTranscriptions(prev => [
                  ...prev,
                  ...(userText ? [{ text: userText, role: 'user', timestamp: Date.now() } as Transcription] : []),
                  ...(assistantText ? [{ text: assistantText, role: 'assistant', timestamp: Date.now() } as Transcription] : [])
                ].slice(-10)); // Keep last 10
              }

              currentInputTranscription.current = '';
              currentOutputTranscription.current = '';
            }
          },
          onerror: (e) => {
            console.error("Gemini Error:", e);
            setStatus(ConnectionStatus.ERROR);
            stopSession();
          },
          onclose: () => {
            setStatus(ConnectionStatus.DISCONNECTED);
            setIsListening(false);
          }
        }
      });

      sessionRef.current = await sessionPromise;
      
    } catch (err) {
      console.error("Failed to start session:", err);
      setStatus(ConnectionStatus.ERROR);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-between p-6 md:p-12 max-w-5xl mx-auto">
      {/* Header */}
      <header className="w-full flex justify-between items-center mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-indigo-500/50">
            <img src="https://picsum.photos/id/1012/100/100" alt="Eliel Profile" className="w-full h-full object-cover" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">Eliel <span className="text-indigo-400">Yolou</span></h1>
            <p className="text-sm text-slate-400">Assistant Vocal Intelligent</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-3 h-3 rounded-full ${
            status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 
            status === ConnectionStatus.CONNECTING ? 'bg-yellow-500' : 'bg-red-500'
          }`} />
          <span className="text-xs font-medium uppercase tracking-widest text-slate-400">{status}</span>
        </div>
      </header>

      {/* Main Content: Avatar & Interaction */}
      <main className="flex-1 flex flex-col items-center justify-center w-full gap-12">
        <div className="relative flex items-center justify-center">
          {/* Animated Rings */}
          {isListening && (
            <>
              <div className="absolute w-48 h-48 rounded-full border border-indigo-500/30 animate-pulse-ring" />
              <div className="absolute w-64 h-64 rounded-full border border-indigo-400/20 animate-pulse-ring" style={{ animationDelay: '0.5s' }} />
            </>
          )}
          
          <div className={`relative w-40 h-40 rounded-full glass flex items-center justify-center overflow-hidden transition-all duration-500 ${isListening ? 'scale-110 shadow-2xl shadow-indigo-500/20' : 'scale-100'}`}>
            {isListening ? (
              <div className="flex items-center gap-1.5 h-12">
                {[...Array(5)].map((_, i) => (
                  <div 
                    key={i} 
                    className="w-1.5 bg-indigo-400 rounded-full animate-bounce" 
                    style={{ animationDelay: `${i * 0.15}s`, height: `${Math.random() * 100 + 40}%` }} 
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center">
                 <svg className="w-16 h-16 text-slate-500 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                <p className="text-xs text-slate-500 font-semibold tracking-widest uppercase">Prêt</p>
              </div>
            )}
          </div>
        </div>

        {/* Captions / Live Feedback */}
        <div className="w-full max-w-2xl min-h-[120px] flex flex-col gap-4 text-center">
          {transcriptions.length > 0 ? (
            <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2 scrollbar-thin">
              {transcriptions.map((t, i) => (
                <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`px-4 py-2 rounded-2xl max-w-[85%] text-sm ${
                    t.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-none' 
                      : 'bg-slate-800 text-slate-200 rounded-tl-none border border-slate-700'
                  }`}>
                    {t.text}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-8">
              <p className="text-slate-400 text-lg font-light italic">
                {status === ConnectionStatus.DISCONNECTED ? "Cliquez sur 'Parler à Eliel' pour commencer" : "Écoute en cours..."}
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Footer: Controls */}
      <footer className="w-full flex flex-col items-center gap-6 mt-8">
        <div className="flex gap-4">
          {status === ConnectionStatus.DISCONNECTED ? (
            <button
              onClick={startSession}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-8 py-4 rounded-full font-semibold transition-all flex items-center gap-3 shadow-lg shadow-indigo-500/20 active:scale-95"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 005.93 6.93V17H7a1 1 0 100 2h6a1 1 0 100-2h-2v-2.07z" />
              </svg>
              Parler à Eliel
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="bg-red-500/10 border border-red-500/50 hover:bg-red-500/20 text-red-400 px-8 py-4 rounded-full font-semibold transition-all flex items-center gap-3 active:scale-95"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
              </svg>
              Terminer la session
            </button>
          )}
        </div>
        
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-indigo-500" />
            <span>Anglais / Français</span>
          </div>
          <span>•</span>
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-slate-500" />
            <span>Powered by Gemini 2.5 Flash</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
