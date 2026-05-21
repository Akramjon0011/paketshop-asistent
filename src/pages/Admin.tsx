import { useState, useEffect } from 'react';
import { Shield, Key, Plus, Trash2, Database, AlertCircle, Loader2, Package, ShoppingBag, Eye, CheckCircle, Clock, Truck, XCircle } from 'lucide-react';

type Tab = 'knowledge' | 'products' | 'orders';

export default function Admin() {
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('knowledge');

  // --- Knowledge Base State ---
  const [knowledgeBase, setKnowledgeBase] = useState<any[]>([]);
  const [newQuestion, setNewQuestion] = useState('');
  const [newAnswer, setNewAnswer] = useState('');
  const [newVideoUrl, setNewVideoUrl] = useState('');

  // --- Products State ---
  const [products, setProducts] = useState<any[]>([]);
  const [prodName, setProdName] = useState('');
  const [prodDesc, setProdDesc] = useState('');
  const [prodPrice, setProdPrice] = useState('');
  const [prodCategory, setProdCategory] = useState('');
  const [prodStock, setProdStock] = useState('10');

  // --- Orders State ---
  const [orders, setOrders] = useState<any[]>([]);

  // --- Global Loading/Error State ---
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  // Auto-login check
  useEffect(() => {
    const savedToken = sessionStorage.getItem('admin_token');
    if (savedToken) {
      setToken(savedToken);
      setIsAuthenticated(true);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated && token) {
      fetchData();
    }
  }, [isAuthenticated, token, activeTab]);

  const fetchData = async () => {
    setIsLoading(true);
    setError('');
    try {
      if (activeTab === 'knowledge') {
        const res = await fetch('/api/knowledge');
        if (res.ok) {
          const data = await res.json();
          setKnowledgeBase(data);
        } else {
          setError('Bilimlar bazasini yuklab bo\'lmadi');
        }
      } else if (activeTab === 'products') {
        const res = await fetch('/api/admin/products', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setProducts(data);
        } else {
          setError('Mahsulotlar ro\'yxatini yuklab bo\'lmadi');
        }
      } else if (activeTab === 'orders') {
        const res = await fetch('/api/admin/orders', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setOrders(data);
        } else {
          setError('Buyurtmalar ro\'yxatini yuklab bo\'lmadi');
        }
      }
    } catch (err) {
      setError('Tarmoq xatosi yuz berdi');
    } finally {
      setIsLoading(false);
    }
  };

  const checkLogin = async (pass: string) => {
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pass })
      });
      if (res.ok) {
        const data = await res.json();
        const jwtToken = data.token;
        setToken(jwtToken);
        setIsAuthenticated(true);
        sessionStorage.setItem('admin_token', jwtToken);
      } else {
        setLoginError('Noto\'g\'ri parol');
        sessionStorage.removeItem('admin_token');
        setIsAuthenticated(false);
      }
    } catch (err) {
      setLoginError('Tizim bilan ulanishda xatolik');
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    checkLogin(password);
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    setPassword('');
    setToken('');
    sessionStorage.removeItem('admin_token');
  };

  // --- Knowledge Actions ---
  const handleAddKnowledge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuestion.trim() || !newAnswer.trim()) return;
    
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append('question', newQuestion);
      formData.append('answer', newAnswer);
      if (newVideoUrl.trim()) {
         formData.append('video_url', newVideoUrl.trim());
      }
      
      const fileInput = (e.target as HTMLFormElement).elements.namedItem('imageFile') as HTMLInputElement;
      if (fileInput && fileInput.files && fileInput.files[0]) {
         formData.append('image', fileInput.files[0]);
      }

      const res = await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });
      
      if (res.ok) {
        setNewQuestion('');
        setNewAnswer('');
        setNewVideoUrl('');
        if (fileInput) fileInput.value = '';
        fetchData();
      } else {
        setError('Saqlashda xatolik yuz berdi');
      }
    } catch (err) {
      setError('Tarmoq xatosi');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteKnowledge = async (id: number) => {
    if (!window.confirm('Rostdan ham o\'chirmoqchimisiz?')) return;
    try {
      const res = await fetch(`/api/knowledge/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        fetchData();
      } else {
        setError('O\'chirishda xatolik yuz berdi');
      }
    } catch (err) {
      setError('Tarmoq xatosi');
    }
  };

  // --- Product Actions ---
  const handleAddProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prodName.trim() || !prodPrice.trim()) return;

    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append('name', prodName.trim());
      formData.append('description', prodDesc.trim());
      formData.append('price', prodPrice.trim());
      formData.append('category', prodCategory.trim());
      formData.append('stock', prodStock.trim());

      const fileInput = (e.target as HTMLFormElement).elements.namedItem('imageFile') as HTMLInputElement;
      if (fileInput && fileInput.files && fileInput.files[0]) {
         formData.append('image', fileInput.files[0]);
      }

      const res = await fetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });

      if (res.ok) {
        setProdName('');
        setProdDesc('');
        setProdPrice('');
        setProdCategory('');
        setProdStock('10');
        if (fileInput) fileInput.value = '';
        fetchData();
      } else {
        setError('Mahsulotni qo\'shishda xatolik yuz berdi');
      }
    } catch (err) {
      setError('Tarmoq xatosi');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteProduct = async (id: number) => {
    if (!window.confirm('Mahsulotni o\'chirmoqchimisiz?')) return;
    try {
      const res = await fetch(`/api/admin/products/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        fetchData();
      } else {
        setError('O\'chirishda xatolik yuz berdi');
      }
    } catch (err) {
      setError('Tarmoq xatosi');
    }
  };

  // --- Order Actions ---
  const handleUpdateOrderStatus = async (id: number, newStatus: string) => {
    try {
      const res = await fetch(`/api/admin/orders/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ status: newStatus })
      });
      if (res.ok) {
        fetchData();
      } else {
        setError('Statusni yangilashda xatolik yuz berdi');
      }
    } catch (err) {
      setError('Tarmoq xatosi');
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return (
          <span className="flex items-center gap-1 bg-blue-50 text-blue-700 text-xs font-semibold px-2.5 py-1 rounded-full border border-blue-100">
            <Clock className="w-3.5 h-3.5" /> Kutilmoqda
          </span>
        );
      case 'processing':
        return (
          <span className="flex items-center gap-1 bg-amber-50 text-amber-700 text-xs font-semibold px-2.5 py-1 rounded-full border border-amber-100">
            <Truck className="w-3.5 h-3.5" /> Jo'natilmoqda
          </span>
        );
      case 'delivered':
        return (
          <span className="flex items-center gap-1 bg-green-50 text-green-700 text-xs font-semibold px-2.5 py-1 rounded-full border border-green-100">
            <CheckCircle className="w-3.5 h-3.5" /> Yetkazildi
          </span>
        );
      case 'cancelled':
        return (
          <span className="flex items-center gap-1 bg-red-50 text-red-700 text-xs font-semibold px-2.5 py-1 rounded-full border border-red-100">
            <XCircle className="w-3.5 h-3.5" /> Bekor qilindi
          </span>
        );
      default:
        return <span className="bg-gray-100 text-gray-800 text-xs font-semibold px-2.5 py-1 rounded-full">{status}</span>;
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl w-full max-w-md border border-gray-100">
          <div className="flex flex-col items-center mb-8">
            <div className="bg-amber-100 p-3 rounded-full mb-4 text-amber-600">
              <Shield className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">Admin Panel</h1>
            <p className="text-gray-500 text-sm mt-2">Do'kon va AI yordamchini boshqarish</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Maxfiy parol</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-gray-400">
                  <Key className="w-5 h-5" />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-xl focus:ring-amber-500 focus:border-amber-500 text-gray-900 placeholder-gray-400 bg-gray-50 transition-colors"
                  placeholder="Parolni kiriting..."
                  required
                />
              </div>
              {loginError && (
                <p className="mt-2 text-sm text-red-600 flex items-center">
                  <AlertCircle className="w-4 h-4 mr-1" />
                  {loginError}
                </p>
              )}
            </div>

            <button
              type="submit"
              className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-amber-500 transition-all"
            >
              Kirish
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-8 font-sans">
      <div className="max-w-6xl mx-auto space-y-8">
        
        {/* Header */}
        <div className="bg-white rounded-2xl shadow-sm p-6 border border-gray-100 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center space-x-4 text-gray-900">
            <div className="bg-amber-100 p-3 rounded-2xl text-amber-600 shadow-inner">
              <Shield className="w-7 h-7" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-gray-800">Paketshop.uz Admin</h1>
              <p className="text-sm text-gray-500 font-medium">Boshqaruv markazi va Konversatsion Savdo tizimi</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="px-5 py-2.5 text-sm font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all cursor-pointer"
          >
            Chiqish
          </button>
        </div>

        {/* Tabs Bar */}
        <div className="bg-white p-2 rounded-2xl border border-gray-100 shadow-sm flex space-x-2">
          <button
            onClick={() => setActiveTab('knowledge')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all ${
              activeTab === 'knowledge' ? 'bg-amber-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Database className="w-4 h-4" /> Bilimlar Bazasi (RAG)
          </button>
          <button
            onClick={() => setActiveTab('products')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all ${
              activeTab === 'products' ? 'bg-amber-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Package className="w-4 h-4" /> Mahsulotlar boshqaruvi
          </button>
          <button
            onClick={() => setActiveTab('orders')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all relative ${
              activeTab === 'orders' ? 'bg-amber-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            <ShoppingBag className="w-4 h-4" /> Kelgan Buyurtmalar
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl flex items-center">
            <AlertCircle className="w-5 h-5 mr-2" />
            {error}
          </div>
        )}

        {/* --- TAB 1: KNOWLEDGE BASE --- */}
        {activeTab === 'knowledge' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-fadeIn">
            <div className="lg:col-span-1 flex flex-col gap-6">
              {/* Form 1: Add RAG entry */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-6 bg-gray-50 border-b border-gray-100">
                  <h2 className="text-lg font-bold text-gray-900 flex items-center">
                    <Plus className="w-5 h-5 mr-2 text-amber-500" />
                    Qo'lda kiritish
                  </h2>
                </div>
                <form onSubmit={handleAddKnowledge} className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">Mijoz savoli (yoki mavzu)</label>
                    <textarea
                      value={newQuestion}
                      onChange={(e) => setNewQuestion(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white"
                      rows={2}
                      placeholder="Masalan: Yetkazib berish narxi qancha?"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">Malika javobi (ma'lumot)</label>
                    <textarea
                      value={newAnswer}
                      onChange={(e) => setNewAnswer(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white"
                      rows={4}
                      placeholder="Toshkent shahri ichida yetkazib berish 25,000 so'm..."
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">Rasm yuklash (ixtiyoriy)</label>
                    <input
                      type="file"
                      name="imageFile"
                      accept="image/*"
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-amber-55 file:text-amber-700 hover:file:bg-amber-100 cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">YouTube Video Link (ixtiyoriy)</label>
                    <input
                      type="url"
                      value={newVideoUrl}
                      onChange={(e) => setNewVideoUrl(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white"
                      placeholder="https://youtube.com/watch?v=..."
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-amber-500 hover:bg-amber-600 focus:outline-none transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Qo\'shish'}
                  </button>
                </form>
              </div>

              {/* Form 2: Parse PDF/Image */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-6 bg-amber-50 border-b border-amber-100">
                  <h2 className="text-lg font-bold text-amber-900 flex items-center">
                    <Database className="w-5 h-5 mr-2 text-amber-600" />
                    Fayldan (PDF/Rasm) o'qish
                  </h2>
                  <p className="text-xs text-amber-700 mt-1">PDF narxnomalar yoki rasmli flayerlarni yuklang, AI o'zi matnni ajratib bazaga saqlaydi.</p>
                </div>
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  const fileInput = (e.target as HTMLFormElement).elements.namedItem('file') as HTMLInputElement;
                  const file = fileInput.files?.[0];
                  if (!file) return;

                  setIsLoading(true);
                  setError('');
                  const formData = new FormData();
                  formData.append('file', file);

                  try {
                    const res = await fetch('/api/knowledge/upload', {
                      method: 'POST',
                      headers: { 'Authorization': `Bearer ${token}` },
                      body: formData
                    });
                    
                    if (res.ok) {
                      fileInput.value = '';
                      fetchData();
                    } else {
                      const data = await res.json();
                      setError(data.error || "Faylni o'qishda xatolik");
                    }
                  } catch (err) {
                    setError('Tarmoq xatosi');
                  } finally {
                    setIsLoading(false);
                  }
                }} className="p-6 space-y-4">
                  <div>
                    <input
                      type="file"
                      name="file"
                      accept=".pdf,image/png,image/jpeg,image/jpg"
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-amber-50 file:text-amber-700 hover:file:bg-amber-100 cursor-pointer"
                      required
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-amber-700 bg-amber-100 hover:bg-amber-200 focus:outline-none transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Faylni o\'qish va saqlash'}
                  </button>
                </form>
              </div>
            </div>

            {/* Knowledge List */}
            <div className="lg:col-span-2">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                  <h2 className="text-lg font-bold text-gray-900">Mavjud ma'lumotlar ro'yxati</h2>
                  <span className="bg-amber-100 text-amber-800 text-xs font-semibold px-2.5 py-0.5 rounded-full">
                    {knowledgeBase.length} ta
                  </span>
                </div>
                
                <div className="divide-y divide-gray-100 max-h-[650px] overflow-y-auto">
                  {isLoading && knowledgeBase.length === 0 ? (
                    <div className="p-12 flex justify-center text-amber-500">
                      <Loader2 className="w-8 h-8 animate-spin" />
                    </div>
                  ) : knowledgeBase.length === 0 ? (
                    <div className="p-12 text-center text-gray-500 flex flex-col items-center">
                      <Database className="w-12 h-12 text-gray-300 mb-3" />
                      <p className="font-bold">Hozircha ma'lumot yo'q.</p>
                      <p className="text-sm text-gray-400">Chap tomondagi forma orqali AI bilimlarini kiriting.</p>
                    </div>
                  ) : (
                    knowledgeBase.map((item) => (
                      <div key={item.id} className="p-6 hover:bg-gray-50 transition-colors group">
                        <div className="flex justify-between items-start gap-4">
                          <div className="space-y-3 flex-1">
                            <div>
                              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Savol / Mavzu</span>
                              <p className="text-gray-900 font-bold mt-0.5">{item.question}</p>
                            </div>
                            <div className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">Malika Javobi</span>
                              <p className="text-gray-700 text-sm mt-0.5 whitespace-pre-wrap font-medium">{item.answer}</p>
                            </div>
                            <div className="flex gap-4 text-xs font-semibold text-gray-400">
                              {item.image_url && <span className="text-amber-600">🖼️ Rasm yuklangan</span>}
                              {item.video_url && <span className="text-blue-600">📺 Video havola: {item.video_url}</span>}
                              <span>Sana: {new Date(item.created_at).toLocaleDateString()}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => handleDeleteKnowledge(item.id)}
                            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"
                            title="O'chirish"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- TAB 2: PRODUCTS --- */}
        {activeTab === 'products' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 animate-fadeIn">
            {/* Add Product Form */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-6 bg-gray-50 border-b border-gray-100">
                  <h2 className="text-lg font-bold text-gray-900 flex items-center">
                    <Plus className="w-5 h-5 mr-2 text-amber-500" />
                    Yangi mahsulot qo'shish
                  </h2>
                </div>
                <form onSubmit={handleAddProduct} className="p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">Mahsulot nomi</label>
                    <input
                      type="text"
                      value={prodName}
                      onChange={(e) => setProdName(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white"
                      placeholder="Masalan: Samarqand noni"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">Narxi (so'mda)</label>
                    <input
                      type="number"
                      value={prodPrice}
                      onChange={(e) => setProdPrice(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white"
                      placeholder="Masalan: 15000"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">Tavsifi</label>
                    <textarea
                      value={prodDesc}
                      onChange={(e) => setProdDesc(e.target.value)}
                      className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white"
                      rows={3}
                      placeholder="Mahsulot haqida batafsil..."
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-1">Kategoriya</label>
                      <input
                        type="text"
                        value={prodCategory}
                        onChange={(e) => setProdCategory(e.target.value)}
                        className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white"
                        placeholder="Masalan: Non"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-bold text-gray-700 mb-1">Soni (ombor)</label>
                      <input
                        type="number"
                        value={prodStock}
                        onChange={(e) => setProdStock(e.target.value)}
                        className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white"
                        placeholder="10"
                        min="0"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-bold text-gray-700 mb-1">Rasm yuklash</label>
                    <input
                      type="file"
                      name="imageFile"
                      accept="image/*"
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-amber-50 file:text-amber-700 hover:file:bg-amber-100 cursor-pointer"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="w-full flex justify-center items-center py-3 px-4 border border-transparent rounded-xl shadow-sm text-sm font-bold text-white bg-amber-500 hover:bg-amber-600 focus:outline-none transition-all disabled:opacity-50"
                  >
                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Qo\'shish'}
                  </button>
                </form>
              </div>
            </div>

            {/* Products List */}
            <div className="lg:col-span-2">
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div className="p-6 border-b border-gray-100 flex justify-between items-center">
                  <h2 className="text-lg font-bold text-gray-900">Do'kondagi mahsulotlar</h2>
                  <span className="bg-amber-100 text-amber-800 text-xs font-semibold px-2.5 py-0.5 rounded-full">
                    {products.length} ta
                  </span>
                </div>
                
                <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6 max-h-[650px] overflow-y-auto">
                  {isLoading && products.length === 0 ? (
                    <div className="col-span-full flex justify-center p-12 text-amber-500">
                      <Loader2 className="w-8 h-8 animate-spin" />
                    </div>
                  ) : products.length === 0 ? (
                    <div className="col-span-full p-12 text-center text-gray-500 flex flex-col items-center justify-center">
                      <Package className="w-12 h-12 text-gray-300 mb-3" />
                      <p className="font-bold">Mahsulotlar topilmadi.</p>
                      <p className="text-sm text-gray-400">Do'koningizni to'ldirish uchun yangi mahsulot qo'shing.</p>
                    </div>
                  ) : (
                    products.map((item) => (
                      <div key={item.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden flex flex-col justify-between group hover:shadow-md transition-all">
                        <div>
                          {item.image_url ? (
                            <img src={item.image_url} alt={item.name} className="w-full h-40 object-cover" />
                          ) : (
                            <div className="w-full h-40 bg-gray-100 flex items-center justify-center text-gray-400">
                              <Package className="w-10 h-10" />
                            </div>
                          )}
                          <div className="p-4 space-y-2">
                            <span className="bg-gray-100 text-gray-600 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded">
                              {item.category || "Umumiy"}
                            </span>
                            <h3 className="font-bold text-gray-900 text-base">{item.name}</h3>
                            <p className="text-gray-500 text-xs line-clamp-2">{item.description || "Tavsif yo'q."}</p>
                          </div>
                        </div>
                        <div className="p-4 bg-gray-50 border-t border-gray-100 flex items-center justify-between">
                          <div>
                            <span className="text-[10px] font-bold text-gray-400 block">NARXI</span>
                            <span className="font-extrabold text-amber-600 text-sm">{Number(item.price).toLocaleString()} so'm</span>
                          </div>
                          <div>
                            <span className="text-[10px] font-bold text-gray-400 block text-right">ZAXIRA</span>
                            <span className={`text-xs font-bold ${item.stock > 0 ? 'text-gray-700' : 'text-red-500'}`}>
                              {item.stock > 0 ? `${item.stock} ta` : "Qolmagan"}
                            </span>
                          </div>
                          <button
                            onClick={() => handleDeleteProduct(item.id)}
                            className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                            title="O'chirish"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- TAB 3: ORDERS --- */}
        {activeTab === 'orders' && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden animate-fadeIn">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
              <div>
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <ShoppingBag className="w-5 h-5 text-amber-500" />
                  Mijozlar buyurtmalari
                </h2>
                <p className="text-xs text-gray-500 font-medium">AIning suhbati orqali to'g'ridan-to'g'ri qabul qilingan buyurtmalar ro'yxati</p>
              </div>
              <span className="bg-amber-100 text-amber-800 text-xs font-bold px-3 py-1 rounded-full border border-amber-200 shadow-sm">
                Jami: {orders.length} ta
              </span>
            </div>

            <div className="divide-y divide-gray-100 max-h-[700px] overflow-y-auto">
              {isLoading && orders.length === 0 ? (
                <div className="p-12 flex justify-center text-amber-500">
                  <Loader2 className="w-8 h-8 animate-spin" />
                </div>
              ) : orders.length === 0 ? (
                <div className="p-16 text-center text-gray-500 flex flex-col items-center justify-center">
                  <ShoppingBag className="w-16 h-16 text-gray-300 mb-4" />
                  <h3 className="text-lg font-bold text-gray-800">Buyurtmalar hozircha yo'q.</h3>
                  <p className="text-sm text-gray-400 max-w-sm mt-1">Telegram bot yoki veb-chat orqali Malika bilan muloqot qilganda mijozlar buyurtma bersa, bu yerda aks etadi.</p>
                </div>
              ) : (
                orders.map((order) => (
                  <div key={order.id} className="p-6 hover:bg-gray-50 transition-colors">
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                      
                      {/* Customer & Order details */}
                      <div className="space-y-3 flex-1">
                        <div className="flex items-center gap-3">
                          <span className="bg-amber-100 text-amber-800 font-black text-sm px-3 py-1 rounded-lg">
                            Order #{order.id}
                          </span>
                          {getStatusBadge(order.status)}
                          <span className="text-xs text-gray-400 font-medium">
                            {new Date(order.created_at).toLocaleString('uz-UZ')}
                          </span>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-gray-50 p-4 rounded-xl border border-gray-100 text-sm">
                          <div>
                            <span className="text-[10px] font-bold text-gray-400 block uppercase">Mijoz ismi</span>
                            <span className="font-bold text-gray-800">{order.customer_name}</span>
                          </div>
                          <div>
                            <span className="text-[10px] font-bold text-gray-400 block uppercase">Telefon raqami</span>
                            <a href={`tel:${order.customer_phone}`} className="font-bold text-amber-600 hover:underline">{order.customer_phone}</a>
                          </div>
                          <div>
                            <span className="text-[10px] font-bold text-gray-400 block uppercase">Manzili</span>
                            <span className="font-medium text-gray-700">{order.delivery_address}</span>
                          </div>
                        </div>
                      </div>

                      {/* Items table */}
                      <div className="w-full lg:w-96 bg-white border border-gray-100 rounded-xl p-4 space-y-3">
                        <span className="text-xs font-bold text-gray-400 block border-b pb-1.5 uppercase">Sotib olingan narsalar</span>
                        <div className="space-y-2 max-h-32 overflow-y-auto">
                          {order.items.map((item: any, idx: number) => (
                            <div key={idx} className="flex justify-between items-center text-xs">
                              <span className="text-gray-700 font-medium">{item.name} <span className="text-gray-400 font-semibold">x {item.quantity}</span></span>
                              <span className="font-bold text-gray-900">{(Number(item.price) * item.quantity).toLocaleString()} so'm</span>
                            </div>
                          ))}
                        </div>
                        <div className="border-t pt-2 flex justify-between items-center text-sm">
                          <span className="font-extrabold text-gray-800">JAMI SUMMA:</span>
                          <span className="font-extrabold text-amber-600 text-base">{Number(order.total_price).toLocaleString()} so'm</span>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-row lg:flex-col gap-2 shrink-0 justify-end">
                        {order.status === 'pending' && (
                          <button
                            onClick={() => handleUpdateOrderStatus(order.id, 'processing')}
                            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-xl shadow transition-all cursor-pointer"
                          >
                            <Truck className="w-3.5 h-3.5" /> Jo'natish
                          </button>
                        )}
                        {order.status === 'processing' && (
                          <button
                            onClick={() => handleUpdateOrderStatus(order.id, 'delivered')}
                            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-green-500 hover:bg-green-600 rounded-xl shadow transition-all cursor-pointer"
                          >
                            <CheckCircle className="w-3.5 h-3.5" /> Topshirildi
                          </button>
                        )}
                        {order.status !== 'delivered' && order.status !== 'cancelled' && (
                          <button
                            onClick={() => handleUpdateOrderStatus(order.id, 'cancelled')}
                            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all cursor-pointer"
                          >
                            <XCircle className="w-3.5 h-3.5" /> Bekor qilish
                          </button>
                        )}
                      </div>

                    </div>
                  </div>
                ))
              )}
            </div>

          </div>
        )}

      </div>
    </div>
  );
}
