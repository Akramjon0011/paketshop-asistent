import { useState, useEffect } from 'react';
import { Shield, Key, Plus, Trash2, Database, AlertCircle, Loader2, Package, ShoppingBag, Eye, CheckCircle, Clock, Truck, XCircle, Pencil, X, Users, BarChart3, TrendingUp, DollarSign, Upload } from 'lucide-react';

type Tab = 'analytics' | 'knowledge' | 'products' | 'orders' | 'customers';

type Analytics = {
  totals: { total_orders: number; total_revenue: number; unique_customers: number };
  statusCounts: Array<{ status: string; count: number }>;
  dailyRevenue: Array<{ day: string; revenue: number; orders: number }>;
  topProducts: Array<{ product_id: number; name: string; units_sold: number; revenue: number }>;
  today: { today_revenue: number; today_orders: number; week_orders: number };
  conversion: { chatUsers: number; buyingCustomers: number; rate: number };
} | null;

function StatCard({ icon, label, value, sub, color }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; color: 'amber' | 'blue' | 'green' | 'purple';
}) {
  const colorMap = {
    amber: 'bg-amber-100 text-amber-600',
    blue: 'bg-blue-100 text-blue-600',
    green: 'bg-green-100 text-green-600',
    purple: 'bg-purple-100 text-purple-600',
  };
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center justify-between mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${colorMap[color]}`}>
          <div className="w-5 h-5">{icon}</div>
        </div>
      </div>
      <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">{label}</p>
      <p className="text-2xl font-black text-gray-900 mt-1 break-all">{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
    </div>
  );
}

function StatusRow({ status, count }: { status: string; count: number }) {
  const map: Record<string, { label: string; color: string }> = {
    pending: { label: 'Kutilmoqda', color: 'bg-blue-500' },
    processing: { label: "Jo'natilmoqda", color: 'bg-amber-500' },
    delivered: { label: 'Yetkazildi', color: 'bg-green-500' },
    cancelled: { label: 'Bekor qilindi', color: 'bg-red-500' },
  };
  const info = map[status] || { label: status, color: 'bg-gray-500' };
  return (
    <div className="flex items-center gap-3">
      <span className={`w-3 h-3 rounded-full ${info.color}`} />
      <span className="font-bold text-gray-800 flex-1">{info.label}</span>
      <span className="text-lg font-black text-gray-900">{count}</span>
    </div>
  );
}

function DailyRevenueChart({ data }: { data: Array<{ day: string; revenue: number; orders: number }> }) {
  if (data.length === 0) {
    return <p className="text-gray-400 text-sm text-center py-8">Hozircha sotuvlar bo'lmagan.</p>;
  }
  const max = Math.max(...data.map(d => Number(d.revenue))) || 1;
  const width = 800;
  const height = 200;
  const barW = Math.max(8, (width - 40) / data.length - 4);
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height + 40}`} className="w-full min-w-[400px]">
        {data.map((d, i) => {
          const h = (Number(d.revenue) / max) * height;
          const x = 20 + i * (barW + 4);
          const y = height - h + 10;
          return (
            <g key={d.day}>
              <rect x={x} y={y} width={barW} height={h} rx={3} className="fill-amber-400 hover:fill-amber-500" />
              <title>{`${d.day}: ${Number(d.revenue).toLocaleString()} so'm (${d.orders} buyurtma)`}</title>
              {i === data.length - 1 || i === 0 || i === Math.floor(data.length / 2) ? (
                <text x={x + barW / 2} y={height + 30} textAnchor="middle" className="text-[10px] fill-gray-500">
                  {new Date(d.day).toLocaleDateString('uz-UZ', { month: 'short', day: 'numeric' })}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="text-xs text-gray-400 mt-2">Eng yuqori kun: <span className="font-bold text-gray-700">{Number(max).toLocaleString()} so'm</span></p>
    </div>
  );
}

type EditingProduct = {
  id: number;
  name: string;
  description: string;
  price: string;
  category: string;
  stock: string;
  image_url: string | null;
} | null;

type EditingKnowledge = {
  id: number;
  question: string;
  answer: string;
  video_url: string;
  image_url: string | null;
} | null;

export default function Admin() {
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('analytics');

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

  // --- Customers State ---
  const [customers, setCustomers] = useState<any[]>([]);

  // --- Analytics State ---
  const [analytics, setAnalytics] = useState<Analytics>(null);

  // --- Edit Modal State ---
  const [editingProduct, setEditingProduct] = useState<EditingProduct>(null);
  const [editingKnowledge, setEditingKnowledge] = useState<EditingKnowledge>(null);

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
      } else if (activeTab === 'customers') {
        const res = await fetch('/api/admin/customers', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setCustomers(data);
        } else {
          setError('Mijozlar ro\'yxatini yuklab bo\'lmadi');
        }
      } else if (activeTab === 'analytics') {
        const res = await fetch('/api/admin/analytics', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setAnalytics(data);
        } else {
          setError('Analitika ma\'lumotlarini yuklab bo\'lmadi');
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

  const handleSaveProductEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProduct) return;
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append('name', editingProduct.name);
      formData.append('description', editingProduct.description);
      formData.append('price', editingProduct.price);
      formData.append('category', editingProduct.category);
      formData.append('stock', editingProduct.stock);
      const fileInput = (e.target as HTMLFormElement).elements.namedItem('imageFile') as HTMLInputElement;
      if (fileInput?.files?.[0]) formData.append('image', fileInput.files[0]);

      const res = await fetch(`/api/admin/products/${editingProduct.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      if (res.ok) {
        setEditingProduct(null);
        fetchData();
      } else {
        setError('Saqlashda xatolik');
      }
    } catch (err) {
      setError('Tarmoq xatosi');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveKnowledgeEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingKnowledge) return;
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.append('question', editingKnowledge.question);
      formData.append('answer', editingKnowledge.answer);
      formData.append('video_url', editingKnowledge.video_url || '');
      const fileInput = (e.target as HTMLFormElement).elements.namedItem('imageFile') as HTMLInputElement;
      if (fileInput?.files?.[0]) formData.append('image', fileInput.files[0]);

      const res = await fetch(`/api/knowledge/${editingKnowledge.id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      if (res.ok) {
        setEditingKnowledge(null);
        fetchData();
      } else {
        setError('Saqlashda xatolik');
      }
    } catch (err) {
      setError('Tarmoq xatosi');
    } finally {
      setIsLoading(false);
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
        <div className="bg-white p-2 rounded-2xl border border-gray-100 shadow-sm flex flex-wrap gap-2">
          <button
            onClick={() => setActiveTab('analytics')}
            className={`flex-1 min-w-[120px] flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all ${
              activeTab === 'analytics' ? 'bg-amber-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            <BarChart3 className="w-4 h-4" /> Analitika
          </button>
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
          <button
            onClick={() => setActiveTab('customers')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold transition-all relative ${
              activeTab === 'customers' ? 'bg-amber-500 text-white shadow-sm' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Users className="w-4 h-4" /> Mijozlar
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-xl flex items-center">
            <AlertCircle className="w-5 h-5 mr-2" />
            {error}
          </div>
        )}

        {/* --- TAB 0: ANALYTICS DASHBOARD --- */}
        {activeTab === 'analytics' && (
          <div className="space-y-6 animate-fadeIn">
            {isLoading && !analytics ? (
              <div className="p-12 flex justify-center text-amber-500">
                <Loader2 className="w-8 h-8 animate-spin" />
              </div>
            ) : !analytics ? (
              <div className="p-12 text-center text-gray-500">Ma'lumot yuklanmadi</div>
            ) : (
              <>
                {/* Top Summary Cards */}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  <StatCard icon={<DollarSign />} label="Bugungi daromad" value={`${Number(analytics.today.today_revenue).toLocaleString()} so'm`} color="amber" />
                  <StatCard icon={<ShoppingBag />} label="Bugungi buyurtmalar" value={String(analytics.today.today_orders)} color="blue" />
                  <StatCard icon={<TrendingUp />} label="Haftalik buyurtmalar" value={String(analytics.today.week_orders)} color="green" />
                  <StatCard icon={<Users />} label="Konversiya" value={`${analytics.conversion.rate}%`} sub={`${analytics.conversion.buyingCustomers} / ${analytics.conversion.chatUsers}`} color="purple" />
                </div>

                {/* All-Time Totals */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                  <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">Umumiy ko'rsatkichlar</h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div>
                      <p className="text-xs text-gray-500 font-bold uppercase">Jami buyurtmalar</p>
                      <p className="text-3xl font-black text-gray-900 mt-1">{analytics.totals.total_orders}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 font-bold uppercase">Jami daromad</p>
                      <p className="text-3xl font-black text-amber-600 mt-1">{Number(analytics.totals.total_revenue).toLocaleString()} so'm</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 font-bold uppercase">Faol mijozlar</p>
                      <p className="text-3xl font-black text-gray-900 mt-1">{analytics.totals.unique_customers}</p>
                    </div>
                  </div>
                </div>

                {/* Daily Revenue Chart */}
                <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                  <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">So'nggi 30 kun daromadi</h3>
                  <DailyRevenueChart data={analytics.dailyRevenue} />
                </div>

                {/* Top Products + Status Breakdown */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">Eng ko'p sotilgan mahsulotlar</h3>
                    {analytics.topProducts.length === 0 ? (
                      <p className="text-gray-400 text-sm">Hozircha ma'lumot yo'q</p>
                    ) : (
                      <div className="space-y-3">
                        {analytics.topProducts.map((p, idx) => (
                          <div key={p.product_id} className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm ${
                              idx === 0 ? 'bg-amber-500 text-white' : 'bg-amber-100 text-amber-700'
                            }`}>
                              {idx + 1}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="font-bold text-gray-900 truncate">{p.name}</p>
                              <p className="text-xs text-gray-500">{p.units_sold} ta sotildi</p>
                            </div>
                            <span className="font-extrabold text-amber-600 text-sm">{Number(p.revenue).toLocaleString()} so'm</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                    <h3 className="text-sm font-bold text-gray-500 uppercase tracking-wider mb-4">Buyurtma holatlari</h3>
                    {analytics.statusCounts.length === 0 ? (
                      <p className="text-gray-400 text-sm">Hozircha buyurtmalar yo'q</p>
                    ) : (
                      <div className="space-y-3">
                        {analytics.statusCounts.map((s) => (
                          <StatusRow key={s.status} status={s.status} count={s.count} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
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
                          <div className="flex flex-col gap-1">
                            <button
                              onClick={() => setEditingKnowledge({
                                id: item.id,
                                question: item.question,
                                answer: item.answer,
                                video_url: item.video_url || '',
                                image_url: item.image_url
                              })}
                              className="p-2 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-xl transition-all"
                              title="Tahrirlash"
                            >
                              <Pencil className="w-5 h-5" />
                            </button>
                            <button
                              onClick={() => handleDeleteKnowledge(item.id)}
                              className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"
                              title="O'chirish"
                            >
                              <Trash2 className="w-5 h-5" />
                            </button>
                          </div>
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

              {/* CSV Bulk Import */}
              <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden mt-6">
                <div className="p-6 bg-amber-50 border-b border-amber-100">
                  <h2 className="text-lg font-bold text-amber-900 flex items-center">
                    <Upload className="w-5 h-5 mr-2 text-amber-600" />
                    CSV import (ko'p mahsulot)
                  </h2>
                  <p className="text-xs text-amber-700 mt-1">
                    Ustunlar: <code className="bg-white px-1 rounded">name,price,description,category,stock,image_url</code> (birinchi qator — sarlavhalar)
                  </p>
                </div>
                <form onSubmit={async (e) => {
                  e.preventDefault();
                  const fileInput = (e.target as HTMLFormElement).elements.namedItem('csvFile') as HTMLInputElement;
                  const file = fileInput.files?.[0];
                  if (!file) return;
                  setIsLoading(true);
                  setError('');
                  const formData = new FormData();
                  formData.append('file', file);
                  try {
                    const res = await fetch('/api/admin/products/bulk', {
                      method: 'POST',
                      headers: { 'Authorization': `Bearer ${token}` },
                      body: formData
                    });
                    const data = await res.json();
                    if (res.ok) {
                      fileInput.value = '';
                      fetchData();
                      const msg = `${data.inserted}/${data.total} qator qo'shildi.` +
                        (data.errors?.length ? ` Xatolar: ${data.errors.slice(0, 3).join('; ')}${data.errors.length > 3 ? '...' : ''}` : '');
                      window.alert(msg);
                    } else {
                      setError(data.error || 'Import xatosi');
                    }
                  } catch {
                    setError('Tarmoq xatosi');
                  } finally {
                    setIsLoading(false);
                  }
                }} className="p-6 space-y-4">
                  <input type="file" name="csvFile" accept=".csv,text/csv" required
                    className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-amber-50 file:text-amber-700 hover:file:bg-amber-100 cursor-pointer" />
                  <button type="submit" disabled={isLoading}
                    className="w-full flex justify-center items-center py-3 px-4 rounded-xl text-sm font-bold text-amber-700 bg-amber-100 hover:bg-amber-200 disabled:opacity-50">
                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : "CSV yuklash va import qilish"}
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
                            onClick={() => setEditingProduct({
                              id: item.id,
                              name: item.name,
                              description: item.description || '',
                              price: String(item.price),
                              category: item.category || '',
                              stock: String(item.stock || 0),
                              image_url: item.image_url
                            })}
                            className="p-2 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-all"
                            title="Tahrirlash"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
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

        {/* --- TAB 4: CUSTOMERS --- */}
        {activeTab === 'customers' && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden animate-fadeIn">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
              <div>
                <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                  <Users className="w-5 h-5 text-amber-500" /> Mijozlar bazasi
                </h2>
                <p className="text-xs text-gray-500 font-medium">AI bilan suhbat qilgan va buyurtma bergan mijozlar ro'yxati</p>
              </div>
              <span className="bg-amber-100 text-amber-800 text-xs font-bold px-3 py-1 rounded-full border border-amber-200">
                Jami: {customers.length} ta
              </span>
            </div>
            <div className="divide-y divide-gray-100 max-h-[700px] overflow-y-auto">
              {isLoading && customers.length === 0 ? (
                <div className="p-12 flex justify-center text-amber-500">
                  <Loader2 className="w-8 h-8 animate-spin" />
                </div>
              ) : customers.length === 0 ? (
                <div className="p-16 text-center text-gray-500 flex flex-col items-center justify-center">
                  <Users className="w-16 h-16 text-gray-300 mb-4" />
                  <h3 className="text-lg font-bold text-gray-800">Hozircha mijozlar yo'q.</h3>
                  <p className="text-sm text-gray-400 max-w-sm mt-1">Buyurtma bergan mijozlar avtomatik ravishda shu yerda paydo bo'ladi.</p>
                </div>
              ) : (
                customers.map((cust) => (
                  <div key={cust.id} className="p-6 hover:bg-gray-50 transition-colors">
                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                      <div className="flex-1 grid grid-cols-1 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <span className="text-[10px] font-bold text-gray-400 block uppercase">Ism</span>
                          <span className="font-bold text-gray-800">{cust.name || '—'}</span>
                        </div>
                        <div>
                          <span className="text-[10px] font-bold text-gray-400 block uppercase">Telefon</span>
                          {cust.phone ? (
                            <a href={`tel:${cust.phone}`} className="font-bold text-amber-600 hover:underline">{cust.phone}</a>
                          ) : <span className="text-gray-400">—</span>}
                        </div>
                        <div>
                          <span className="text-[10px] font-bold text-gray-400 block uppercase">Manzil</span>
                          <span className="font-medium text-gray-700 line-clamp-1">{cust.address || '—'}</span>
                        </div>
                        <div>
                          <span className="text-[10px] font-bold text-gray-400 block uppercase">Manba</span>
                          <span className="font-medium text-gray-700">
                            {cust.telegram_id ? `Telegram (${cust.telegram_id})` : 'Web'}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <div className="text-center">
                          <span className="text-[10px] font-bold text-gray-400 block uppercase">Buyurtmalar</span>
                          <span className="text-lg font-extrabold text-gray-900">{cust.order_count}</span>
                        </div>
                        <div className="text-center">
                          <span className="text-[10px] font-bold text-gray-400 block uppercase">Jami xarid</span>
                          <span className="text-base font-extrabold text-amber-600">{Number(cust.total_spent).toLocaleString()} so'm</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

      </div>

      {/* --- EDIT PRODUCT MODAL --- */}
      {editingProduct && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Pencil className="w-5 h-5 text-amber-500" /> Mahsulotni tahrirlash
              </h2>
              <button onClick={() => setEditingProduct(null)} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveProductEdit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Nomi</label>
                <input type="text" value={editingProduct.name}
                  onChange={(e) => setEditingProduct({ ...editingProduct, name: e.target.value })}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2.5 focus:ring-amber-500 focus:border-amber-500 text-gray-900 bg-white" required />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Narxi</label>
                <input type="number" value={editingProduct.price}
                  onChange={(e) => setEditingProduct({ ...editingProduct, price: e.target.value })}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-gray-900 bg-white" required />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Tavsifi</label>
                <textarea value={editingProduct.description}
                  onChange={(e) => setEditingProduct({ ...editingProduct, description: e.target.value })}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-gray-900 bg-white" rows={3} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Kategoriya</label>
                  <input type="text" value={editingProduct.category}
                    onChange={(e) => setEditingProduct({ ...editingProduct, category: e.target.value })}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-gray-900 bg-white" />
                </div>
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Soni</label>
                  <input type="number" value={editingProduct.stock}
                    onChange={(e) => setEditingProduct({ ...editingProduct, stock: e.target.value })}
                    className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-gray-900 bg-white" min="0" />
                </div>
              </div>
              {editingProduct.image_url && (
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Joriy rasm</label>
                  <img src={editingProduct.image_url} alt="" className="h-24 rounded-lg" />
                </div>
              )}
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Yangi rasm (ixtiyoriy)</label>
                <input type="file" name="imageFile" accept="image/*"
                  className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-amber-50 file:text-amber-700" />
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setEditingProduct(null)}
                  className="flex-1 py-3 text-sm font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl">
                  Bekor qilish
                </button>
                <button type="submit" disabled={isLoading}
                  className="flex-1 py-3 text-sm font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-xl disabled:opacity-50 flex items-center justify-center">
                  {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Saqlash'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- EDIT KNOWLEDGE MODAL --- */}
      {editingKnowledge && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50 animate-fadeIn">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center">
              <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
                <Pencil className="w-5 h-5 text-amber-500" /> Ma'lumotni tahrirlash
              </h2>
              <button onClick={() => setEditingKnowledge(null)} className="p-2 text-gray-400 hover:text-gray-600 rounded-lg">
                <X className="w-5 h-5" />
              </button>
            </div>
            <form onSubmit={handleSaveKnowledgeEdit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Savol / Mavzu</label>
                <textarea value={editingKnowledge.question}
                  onChange={(e) => setEditingKnowledge({ ...editingKnowledge, question: e.target.value })}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-gray-900 bg-white" rows={2} required />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Javob</label>
                <textarea value={editingKnowledge.answer}
                  onChange={(e) => setEditingKnowledge({ ...editingKnowledge, answer: e.target.value })}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-gray-900 bg-white" rows={5} required />
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Video URL</label>
                <input type="url" value={editingKnowledge.video_url}
                  onChange={(e) => setEditingKnowledge({ ...editingKnowledge, video_url: e.target.value })}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-gray-900 bg-white" />
              </div>
              {editingKnowledge.image_url && (
                <div>
                  <label className="block text-sm font-bold text-gray-700 mb-1">Joriy rasm</label>
                  <img src={editingKnowledge.image_url} alt="" className="h-24 rounded-lg" />
                </div>
              )}
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">Yangi rasm (ixtiyoriy)</label>
                <input type="file" name="imageFile" accept="image/*"
                  className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-amber-50 file:text-amber-700" />
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={() => setEditingKnowledge(null)}
                  className="flex-1 py-3 text-sm font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl">
                  Bekor qilish
                </button>
                <button type="submit" disabled={isLoading}
                  className="flex-1 py-3 text-sm font-bold text-white bg-amber-500 hover:bg-amber-600 rounded-xl disabled:opacity-50 flex items-center justify-center">
                  {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Saqlash'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
