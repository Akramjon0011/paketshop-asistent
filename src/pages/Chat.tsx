import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { Send, User, Package, Loader2, Sparkles, Volume2, VolumeX, Mic, Square } from 'lucide-react';
import { generateSpeech } from '../services/geminiService';

type Message = {
  id: string;
  role: 'user' | 'model';
  content: string;
  isAudioPlaying?: boolean;
};

// Singleton audio context for consistent playback
let globalAudioCtx: AudioContext | null = null;
let currentAudioSource: AudioBufferSourceNode | null = null;

function getAudioContext() {
  if (!globalAudioCtx) {
    globalAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }
  return globalAudioCtx;
}

type BrandConfig = {
  shopName: string;
  assistantName: string;
  greeting: string;
  brandColor: string;
  currency: string;
};

type FeaturedProduct = {
  id: number;
  name: string;
  description: string | null;
  price: string | number;
  category: string | null;
  image_url: string | null;
};

const DEFAULT_BRAND: BrandConfig = {
  shopName: "Paketshop.uz",
  assistantName: "Malika",
  greeting: "Salom! Sizga qanday yordam bera olaman?",
  brandColor: "amber",
  currency: "so'm",
};

export default function Chat() {
  const [brand, setBrand] = useState<BrandConfig>(DEFAULT_BRAND);
  const [messages, setMessages] = useState<Message[]>([
    { id: '1', role: 'model', content: DEFAULT_BRAND.greeting }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [webSessionId, setWebSessionId] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [featured, setFeatured] = useState<{ latest: FeaturedProduct[]; popular: FeaturedProduct[] }>({ latest: [], popular: [] });
  const [carouselMode, setCarouselMode] = useState<'popular' | 'latest'>('popular');
  const [checkoutProduct, setCheckoutProduct] = useState<FeaturedProduct | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);

  useEffect(() => {
    fetch('/api/config')
      .then(r => r.ok ? r.json() : null)
      .then((cfg: BrandConfig | null) => {
        if (!cfg) return;
        setBrand(cfg);
        setMessages(prev => prev.length === 1 && prev[0].id === '1'
          ? [{ id: '1', role: 'model', content: cfg.greeting }]
          : prev);
      })
      .catch(() => { /* keep defaults */ });

    fetch('/api/products/featured')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setFeatured(data); })
      .catch(() => { /* ignore */ });
  }, []);

  const handleProductClick = (p: FeaturedProduct) => {
    setInput(`Mana shu mahsulot haqida ko'proq ma'lumot bering: "${p.name}" (ID: ${p.id})`);
  };
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    let id = localStorage.getItem('webSessionId');
    if (!id) {
      id = 'session_' + Math.random().toString(36).substring(2, 15) + '_' + Date.now();
      localStorage.setItem('webSessionId', id);
    }
    setWebSessionId(id);
  }, []);

  useEffect(() => {
    if (checkoutProduct && webSessionId) {
      fetch(`/api/customers/session/${webSessionId}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data) {
            if (data.name) setCustomerName(data.name);
            if (data.phone) setCustomerPhone(data.phone);
            if (data.address) setDeliveryAddress(data.address);
          }
        })
        .catch(() => {});
    }
  }, [checkoutProduct, webSessionId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const stopCurrentAudio = () => {
    if (currentAudioSource) {
      currentAudioSource.stop();
      currentAudioSource.disconnect();
      currentAudioSource = null;
    }
    setMessages(prev => prev.map(m => ({ ...m, isAudioPlaying: false })));
  };

  const playPCMBase64 = async (base64Data: string, messageId: string) => {
    try {
      const audioCtx = getAudioContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      stopCurrentAudio();

      const binaryString = window.atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const buffer = new Int16Array(bytes.buffer);
      const audioBuffer = audioCtx.createBuffer(1, buffer.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        channelData[i] = buffer[i] / 32768.0; // convert to float32
      }

      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      
      source.onended = () => {
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, isAudioPlaying: false } : m));
        if (currentAudioSource === source) currentAudioSource = null;
      };

      currentAudioSource = source;
      source.start();
      setMessages(prev => prev.map(m => m.id === messageId ? { ...m, isAudioPlaying: true } : m));

    } catch (err) {
      console.error("Failed to play audio", err);
    }
  };

  const sendMessageText = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage: Message = { id: Date.now().toString(), role: 'user', content: text.trim() };
    setMessages(prev => [...prev, userMessage]);
    setIsLoading(true);
    setError(null);
    stopCurrentAudio(); // Stop audio if user types a new message

    try {
      const chatHistory = messages.map(m => ({ role: m.role, content: m.content }));
      const modelMessageId = (Date.now() + 1).toString();

      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage.content,
          history: chatHistory,
          webSessionId: webSessionId
        })
      });

      if (!res.ok || !res.body) {
        throw new Error("Tizim bilan ulanib bo'lmadi.");
      }

      // Add empty bubble that will be appended to as chunks arrive
      let firstChunkReceived = false;
      let fullReply = '';
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Parse SSE events split by blank line
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const block of events) {
          const lines = block.split('\n');
          let eventName = 'message';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataStr += line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const payload = JSON.parse(dataStr);
            if (eventName === 'chunk') {
              if (!firstChunkReceived) {
                firstChunkReceived = true;
                setIsLoading(false); // hide typing dots once text starts
                setMessages(prev => [...prev, { id: modelMessageId, role: 'model', content: '' }]);
              }
              fullReply += payload.text;
              setMessages(prev => prev.map(m =>
                m.id === modelMessageId ? { ...m, content: fullReply } : m
              ));
            } else if (eventName === 'done') {
              if (payload.reply && payload.reply !== fullReply) {
                fullReply = payload.reply;
                setMessages(prev => prev.map(m =>
                  m.id === modelMessageId ? { ...m, content: fullReply } : m
                ));
              }
            } else if (eventName === 'error') {
              throw new Error(payload.error || "Stream xatosi");
            }
          } catch (parseErr) {
            console.warn("SSE parse error:", parseErr, dataStr);
          }
        }
      }

      // Generate and play TTS audio after streaming completes
      if (isAudioEnabled && fullReply) {
        try {
          const audioData = await generateSpeech(fullReply);
          if (audioData) playPCMBase64(audioData, modelMessageId);
        } catch (audioErr) {
          console.error("TTS generation failed: ", audioErr);
        }
      }

    } catch (err: any) {
      console.error(err);
      setError("Kechirasiz, javob olishda xatolik yuz berdi. Iltimos qaytadan urinib ko'ring.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    const textToSend = input.trim();
    setInput('');
    await sendMessageText(textToSend);
  };

  const autoOrderProduct = (p: FeaturedProduct) => {
    sendMessageText(`Menga 1 dona "${p.name}" (ID: ${p.id}) mahsulotidan buyurtma bering.`);
  };

  const handleOrderSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!checkoutProduct || isSubmittingOrder) return;
    
    if (!customerName.trim() || !customerPhone.trim() || !deliveryAddress.trim()) {
      setError("Iltimos, barcha maydonlarni to'ldiring.");
      return;
    }
    
    setIsSubmittingOrder(true);
    setError(null);
    
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: customerName.trim(),
          customer_phone: customerPhone.trim(),
          delivery_address: deliveryAddress.trim(),
          items: [{ 
            product_id: checkoutProduct.id, 
            name: checkoutProduct.name,
            price: Number(checkoutProduct.price),
            quantity: quantity 
          }],
          webSessionId: webSessionId
        })
      });
      
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || "Buyurtma berishda xatolik yuz berdi.");
      }
      
      // Close modal
      const orderedProduct = checkoutProduct;
      const orderQuantity = quantity;
      setCheckoutProduct(null);
      
      // Add user message mock
      const userMsgId = Date.now().toString();
      const userMsgText = `Menga ${orderQuantity} dona "${orderedProduct.name}" mahsulotidan buyurtma bering. (Ism: ${customerName.trim()}, Tel: ${customerPhone.trim()}, Manzil: ${deliveryAddress.trim()})`;
      const userMessage: Message = { id: userMsgId, role: 'user', content: userMsgText };
      
      // Add model message mock
      const modelMsgId = (Date.now() + 1).toString();
      const modelMsgText = `Rahmat! Buyurtmangiz qabul qilindi. Buyurtma raqami: #${data.order_id}. Jami: ${Number(data.total_price).toLocaleString()} so'm. Tez orada kuryerimiz siz bilan bog'lanadi.`;
      const modelMessage: Message = { id: modelMsgId, role: 'model', content: modelMsgText };
      
      setMessages(prev => [...prev, userMessage, modelMessage]);
      
      // Play audio if enabled
      if (isAudioEnabled && modelMsgText) {
        try {
          const audioData = await generateSpeech(modelMsgText);
          if (audioData) playPCMBase64(audioData, modelMsgId);
        } catch (audioErr) {
          console.error("TTS generation failed after order submission:", audioErr);
        }
      }
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Buyurtmani rasmiylashtirishda xatolik yuz berdi.");
    } finally {
      setIsSubmittingOrder(false);
    }
  };

  const startRecording = async () => {
    try {
      stopCurrentAudio();
      setError(null);
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        
        // Stop all audio tracks in stream
        stream.getTracks().forEach(track => track.stop());

        // Process audio upload
        await handleAudioUpload(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error("Mic access denied or error:", err);
      setError("Mikrofondan foydalanishga ruxsat berilmadi yoki xatolik yuz berdi.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleAudioUpload = async (audioBlob: Blob) => {
    setIsLoading(true);
    setError(null);
    stopCurrentAudio();

    // Map history
    const chatHistory = messages.map(m => ({
      role: m.role,
      content: m.content
    }));

    const formData = new FormData();
    formData.append('audio', audioBlob, 'voice.webm');
    formData.append('webSessionId', webSessionId);
    formData.append('history', JSON.stringify(chatHistory));

    try {
      const res = await fetch('/api/chat/voice', {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        throw new Error("Ovozli xabarni yuborib bo'lmadi.");
      }

      const data = await res.json();
      
      // Add transcription to chat history as user message
      const userMessageId = Date.now().toString();
      const userMessage: Message = {
        id: userMessageId,
        role: 'user',
        content: data.transcription || "[Ovozli xabar]"
      };

      // Add response to chat history
      const modelMessageId = (Date.now() + 1).toString();
      const replyText = data.reply || "Kechirasiz, men tushuna olmadim.";
      
      setMessages(prev => [
        ...prev,
        userMessage,
        { id: modelMessageId, role: 'model', content: replyText }
      ]);

      // Play returning TTS audio if enabled
      if (isAudioEnabled && data.audio) {
        playPCMBase64(data.audio, modelMessageId);
      }
    } catch (err: any) {
      console.error(err);
      setError("Ovozli xabarni qayta ishlashda xatolik yuz berdi.");
    } finally {
      setIsLoading(false);
    }
  };

  // Helper visually replace audio tags for better chat reading
  const renderMessageContent = (content: string) => {
    let processedHTML = content;
    processedHTML = processedHTML.replace(/\[laughing\]/gi, '😄 *[kulib]*');
    processedHTML = processedHTML.replace(/\[short pause\]/gi, '*...*');
    processedHTML = processedHTML.replace(/\[sigh\]/gi, '😌 *[chuqur nafas olib]*');
    
    // Convert custom tags to Markdown
    processedHTML = processedHTML.replace(/\[IMAGE:\s*(.*?)\]/g, '\n\n![Mahsulot rasmi]($1)\n\n');
    processedHTML = processedHTML.replace(/\[VIDEO:\s*(.*?)\]/g, '\n\n📺 **Batafsil video:** [YouTube orqali ko\'rish]($1)\n\n');
    
    return processedHTML;
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50 font-sans">
      {/* Header */}
      <header className="bg-amber-500 text-white shadow-md p-4 flex items-center justify-between z-10 shrink-0">
        <div className="flex items-center space-x-3 w-full max-w-4xl mx-auto px-4 sm:px-0 justify-between">
          <div className="flex items-center space-x-3">
             <div className="bg-white/20 p-2 rounded-full">
              <Package className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">{brand.shopName}</h1>
              <p className="text-amber-100 text-sm flex items-center">
                <Sparkles className="w-3 h-3 mr-1" /> {brand.assistantName} (Raqamli yordamchi)
              </p>
            </div>
          </div>
          <button 
             onClick={() => {
                 setIsAudioEnabled(!isAudioEnabled);
                 if (isAudioEnabled) stopCurrentAudio();
             }}
             className="bg-white/20 hover:bg-white/30 p-2 rounded-full transition-colors flex items-center justify-center shrink-0"
             title={isAudioEnabled ? "Ovozni o'chirish" : "Ovozni yoqish"}
          >
             {isAudioEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5 opacity-70" />}
          </button>
        </div>
      </header>

      {/* Chat Area */}
      <main className="flex-1 overflow-y-auto p-4 w-full max-w-4xl mx-auto w-full relative">
        <div className="space-y-6 pb-4">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`flex max-w-[85%] sm:max-w-[75%] ${message.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                
                {/* Avatar */}
                <div className={`flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full shadow-sm max-sm:w-8 max-sm:h-8 ${
                  message.role === 'user' ? 'bg-gray-200 text-gray-500 ml-3' : 'bg-amber-100 text-amber-600 mr-3'
                }`}>
                  {message.role === 'user' ? <User className="w-5 h-5 max-sm:w-4 max-sm:h-4" /> : <Package className="w-5 h-5 max-sm:w-4 max-sm:h-4" />}
                </div>

                {/* Message Bubble */}
                <div className={`group relative p-4 rounded-2xl shadow-sm ${
                  message.role === 'user'
                    ? 'bg-amber-500 text-white rounded-tr-sm'
                    : 'bg-white border border-gray-100 text-gray-800 rounded-tl-sm'
                }`}>
                  <div className={`prose max-w-none text-sm sm:text-base ${message.role === 'user' ? 'prose-invert' : ''}`}>
                    <ReactMarkdown>
                        {renderMessageContent(message.content)}
                    </ReactMarkdown>
                  </div>
                  {message.isAudioPlaying && (
                      <div className="absolute -bottom-2 -left-2 text-amber-500 animate-pulse bg-white rounded-full p-0.5 shadow">
                         <Volume2 className="w-4 h-4" />
                      </div>
                  )}
                </div>
              </div>
            </div>
          ))}
          
          {isLoading && (
            <div className="flex justify-start">
               <div className="flex flex-row max-w-[85%] sm:max-w-[75%]">
                <div className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-full shadow-sm bg-amber-100 text-amber-600 mr-3 max-sm:w-8 max-sm:h-8">
                    <Package className="w-5 h-5 max-sm:w-4 max-sm:h-4" />
                </div>
                <div className="bg-white border border-gray-100 p-4 rounded-2xl rounded-tl-sm shadow-sm flex items-center space-x-2">
                  <div className="w-2 h-2 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 rounded-full bg-amber-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </main>

      {/* Featured Products Carousel */}
      {(featured.popular.length > 0 || featured.latest.length > 0) && (
        <div className="bg-white border-t border-gray-100 px-4 pt-3 pb-2 shrink-0">
          <div className="w-full max-w-4xl mx-auto">
            <div className="flex items-center gap-3 mb-2">
              <button
                onClick={() => setCarouselMode('popular')}
                className={`text-xs font-bold px-3 py-1 rounded-full transition-all ${
                  carouselMode === 'popular' ? 'bg-amber-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                🔥 Mashhur
              </button>
              <button
                onClick={() => setCarouselMode('latest')}
                className={`text-xs font-bold px-3 py-1 rounded-full transition-all ${
                  carouselMode === 'latest' ? 'bg-amber-500 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                ✨ Yangi
              </button>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x">
              {(carouselMode === 'popular' ? featured.popular : featured.latest).map((p) => (
                <div
                  key={p.id}
                  className="snap-start shrink-0 w-32 sm:w-36 bg-white border border-gray-200 hover:border-amber-400 hover:shadow-md rounded-xl overflow-hidden transition-all text-left flex flex-col justify-between"
                >
                  <div 
                    onClick={() => handleProductClick(p)}
                    className="cursor-pointer"
                  >
                    {p.image_url ? (
                      <img src={p.image_url} alt={p.name} className="w-full h-20 object-cover" />
                    ) : (
                      <div className="w-full h-20 bg-gray-100 flex items-center justify-center">
                        <Package className="w-6 h-6 text-gray-300" />
                      </div>
                    )}
                    <div className="p-2 pb-1">
                      <p className="text-xs font-bold text-gray-900 line-clamp-1">{p.name}</p>
                      <p className="text-xs font-extrabold text-amber-600 mt-0.5">
                        {Number(p.price).toLocaleString()} {brand.currency}
                      </p>
                    </div>
                  </div>
                  <div className="p-2 pt-0">
                    <button
                      onClick={() => { setCheckoutProduct(p); setQuantity(1); }}
                      disabled={isLoading}
                      className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white text-[10px] sm:text-xs font-bold py-1 px-2 rounded-lg transition-all text-center flex items-center justify-center gap-1 shadow-sm cursor-pointer"
                    >
                      🛒 Buyurtma
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Input Area */}
      <footer className="bg-white border-t border-gray-200 p-4 shrink-0">
        <div className="w-full max-w-4xl mx-auto flex flex-col space-y-2">
           {error && (
            <div className="text-red-500 text-sm bg-red-50 p-2 rounded border border-red-100">
              {error}
            </div>
          )}
          <form onSubmit={handleSubmit} className="flex relative items-end space-x-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={isRecording ? "Ovoz yozilmoqda... To'xtatish uchun qizil tugmani bosing." : `${brand.assistantName}ga xabar yozing (ovoz bilan javob beradi)...`}
              disabled={isRecording}
              className="flex-1 max-h-32 min-h-[56px] resize-none bg-gray-50 border border-gray-300 rounded-xl px-4 py-3 sm:py-4 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 transition-all text-sm sm:text-base text-gray-900 placeholder:text-gray-400 m-0 disabled:bg-gray-100 disabled:text-gray-400"
              rows={1}
            />
            {isRecording ? (
              <button
                type="button"
                onClick={stopRecording}
                className="bg-red-500 hover:bg-red-600 text-white rounded-xl p-3 sm:p-4 transition-colors flex-shrink-0 flex items-center justify-center flex-col h-[56px] w-[56px] animate-pulse shadow-md"
                title="Yozishni to'xtatish va yuborish"
              >
                <Square className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                disabled={isLoading}
                className="bg-amber-100 hover:bg-amber-200 text-amber-600 rounded-xl p-3 sm:p-4 transition-colors flex-shrink-0 flex items-center justify-center flex-col h-[56px] w-[56px] disabled:opacity-50 shadow-sm"
                title="Ovozli xabar yuborish"
              >
                <Mic className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>
            )}
            <button
              type="submit"
              disabled={!input.trim() || isLoading || isRecording}
              className="bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:hover:bg-amber-500 text-white rounded-xl p-3 sm:p-4 transition-colors flex-shrink-0 flex items-center justify-center flex-col h-[56px] w-[56px] shadow-sm"
            >
              <Send className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
          </form>
          <div className="text-center text-xs text-gray-400 pt-2 flex flex-col sm:flex-row justify-center items-center gap-1">
            <span>{brand.shopName} sun'iy intellekt yordamchisi. Ayrim javoblarda noaniqliklar bo'lishi mumkin.</span>
          </div>
        </div>
      </footer>

      {/* Checkout Modal */}
      {checkoutProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto border border-gray-100 flex flex-col animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="p-5 border-b border-gray-100 flex justify-between items-center bg-amber-50 rounded-t-2xl">
              <div>
                <h3 className="text-lg font-bold text-gray-900">Buyurtma berish</h3>
                <p className="text-xs text-amber-700 font-medium">Tez va qulay rasmiylashtirish</p>
              </div>
              <button
                onClick={() => setCheckoutProduct(null)}
                className="text-gray-400 hover:text-gray-600 p-1.5 hover:bg-gray-100 rounded-full transition-colors cursor-pointer"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal Body */}
            <form onSubmit={handleOrderSubmit} className="p-6 space-y-5 flex-1">
              {/* Product Info Card */}
              <div className="flex items-center gap-4 bg-gray-50 p-4 rounded-xl border border-gray-150">
                {checkoutProduct.image_url ? (
                  <img src={checkoutProduct.image_url} alt={checkoutProduct.name} className="w-16 h-16 object-cover rounded-lg border border-gray-200" />
                ) : (
                  <div className="w-16 h-16 bg-gray-200 flex items-center justify-center rounded-lg border border-gray-200">
                    <Package className="w-8 h-8 text-gray-400" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h4 className="text-sm font-bold text-gray-950 truncate">{checkoutProduct.name}</h4>
                  <p className="text-sm font-black text-amber-600 mt-0.5">
                    {Number(checkoutProduct.price).toLocaleString()} {brand.currency}
                  </p>
                  {checkoutProduct.category && (
                    <span className="inline-block bg-amber-100 text-amber-800 text-[10px] font-bold px-2 py-0.5 rounded-full mt-1">
                      {checkoutProduct.category}
                    </span>
                  )}
                </div>
              </div>

              {/* Quantity Selector */}
              <div className="flex items-center justify-between bg-amber-50/50 p-3.5 rounded-xl border border-amber-100/50">
                <span className="text-sm font-semibold text-gray-700">Mahsulot soni:</span>
                <div className="flex items-center space-x-3.5">
                  <button
                    type="button"
                    onClick={() => setQuantity(q => Math.max(1, q - 1))}
                    disabled={quantity <= 1}
                    className="w-8 h-8 rounded-full bg-white border border-gray-300 hover:border-amber-500 hover:text-amber-600 disabled:opacity-40 disabled:hover:border-gray-300 disabled:hover:text-gray-800 transition-colors flex items-center justify-center font-extrabold text-lg cursor-pointer"
                  >
                    -
                  </button>
                  <span className="text-base font-bold text-gray-950 min-w-4 text-center">{quantity}</span>
                  <button
                    type="button"
                    onClick={() => setQuantity(q => q + 1)}
                    className="w-8 h-8 rounded-full bg-white border border-gray-300 hover:border-amber-500 hover:text-amber-600 transition-colors flex items-center justify-center font-extrabold text-lg cursor-pointer"
                  >
                    +
                  </button>
                </div>
              </div>

              {/* Customer Form Fields */}
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                    Ism va Familiyangiz <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Ismingizni kiriting"
                    className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 transition-all text-sm text-gray-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                    Telefon raqamingiz <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="tel"
                    required
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="+998901234567"
                    className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 transition-all text-sm text-gray-900"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-1.5">
                    Yetkazib berish manzili <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    required
                    rows={2}
                    value={deliveryAddress}
                    onChange={(e) => setDeliveryAddress(e.target.value)}
                    placeholder="Tashrif manzili (shahar, tuman, ko'cha, uy/kvartira)"
                    className="w-full bg-gray-50 border border-gray-300 rounded-xl px-3.5 py-2.5 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500 transition-all text-sm text-gray-900 resize-none"
                  />
                </div>
              </div>

              {/* Order total */}
              <div className="pt-2 flex justify-between items-center text-sm font-semibold border-t border-gray-100">
                <span className="text-gray-600">Umumiy summa:</span>
                <span className="text-lg font-black text-amber-600">
                  {(Number(checkoutProduct.price) * quantity).toLocaleString()} {brand.currency}
                </span>
              </div>

              {/* Action Buttons */}
              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setCheckoutProduct(null)}
                  className="flex-1 py-3 px-4 border border-gray-300 rounded-xl text-sm font-semibold text-gray-700 hover:bg-gray-50 active:bg-gray-100 transition-colors text-center cursor-pointer"
                >
                  Bekor qilish
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingOrder}
                  className="flex-1 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-white py-3 px-4 rounded-xl text-sm font-bold shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isSubmittingOrder ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Yuborilmoqda...
                    </>
                  ) : (
                    'Buyurtmani tasdiqlash'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
