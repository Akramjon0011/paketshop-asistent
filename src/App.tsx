import { Component, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Chat from './pages/Chat';
import Admin from './pages/Admin';

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(err: unknown) { console.error('App crashed:', err); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ padding: 24, textAlign: 'center', fontFamily: 'sans-serif' }}>
        <p>Kechirasiz, ilovada xatolik yuz berdi.</p>
        <button onClick={() => location.reload()} style={{ padding: '8px 16px', borderRadius: 8, border: 0, background: '#f59e0b', color: '#fff' }}>
          Qayta yuklash
        </button>
      </div>
    );
  }
}

export default function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Chat />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  );
}
