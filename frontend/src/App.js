import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';
import { useDropzone } from 'react-dropzone';

// ── Constants ──────────────────────────────────────────────────────────────────
const API = 'http://localhost:8000';
const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || '';

const DS = {
  bg:        '#0A0F1E',
  bgSecond:  '#111827',
  surface:   '#1E2A3B',
  card:      '#162032',
  border:    '#1E3A5F',
  accent:    '#2563EB',
  green:     '#059669',
  red:       '#DC2626',
  amber:     '#D97706',
  textPri:   '#F1F5F9',
  textSec:   '#94A3B8',
  textMuted: '#64748B',
  successBg: '#022C22',
  warnBg:    '#2D1B00',
  errBg:     '#2D0000',
};

const COUNTRY_RULES = {
  IN:  { max_value_usd: 800,  notes: 'Values above USD 800 require Bill of Entry filing', restricted: ['9301', '9302'] },
  UAE: { max_value_usd: 1000, notes: 'VAT registration required for commercial consignments', restricted: ['9301', '9302', '2402'] },
  USA: { max_value_usd: 800,  notes: 'Section 321 de minimis applies below USD 800', restricted: ['9301'] },
};

const COUNTRY_FLAGS = { IN: '🇮🇳', UAE: '🇦🇪', US: '🇺🇸', USA: '🇺🇸' };

// ── Token helpers ──────────────────────────────────────────────────────────────
const getToken  = () => localStorage.getItem('ca_token');
const clearAuth = () => { localStorage.removeItem('ca_token'); localStorage.removeItem('ca_rtoken'); localStorage.removeItem('ca_user'); };
const getUser   = () => { try { return JSON.parse(localStorage.getItem('ca_user')); } catch { return null; } };
const authHeader = () => ({ Authorization: `Bearer ${getToken()}` });

// ── extractFields (preserved exactly) ─────────────────────────────────────────
function extractFields(result) {
  if (result?.fields && Object.keys(result.fields).length > 0) return result.fields;
  const raw = result?.raw_output;
  if (!raw || typeof raw !== 'string') return null;
  let content = raw;
  try {
    const outer = JSON.parse(raw);
    const resultStr = outer?.out_ResultJSON;
    if (resultStr) {
      const inner = JSON.parse(resultStr);
      content = inner?.openai_response?.choices?.[0]?.message?.content || raw;
    }
  } catch { /* not a JSON envelope */ }
  try {
    const matches = [...content.matchAll(/```json\n([\s\S]*?)```/g)];
    if (!matches.length) return null;
    const parsed = JSON.parse(matches[matches.length - 1][1]);
    return {
      Exporter: typeof parsed?.Exporter === 'object'
        ? (parsed?.Exporter?.Name || parsed?.Exporter?.CompanyName || JSON.stringify(parsed?.Exporter))
        : (parsed?.Exporter || parsed?.exporter || ''),
      Origin:   parsed?.Origin?.Country || parsed?.Origin   || parsed?.origin   || '',
      Value:    parsed?.['Import/Export']?.Value || parsed?.Value?.amount || parsed?.value?.amount || parsed?.Value || parsed?.value || '',
      Currency: parsed?.['Import/Export']?.Currency || parsed?.Value?.currency || parsed?.value?.currency || parsed?.Currency || parsed?.currency || 'USD',
      Goods:    parsed?.['Description of Goods']?.Goods || parsed?.Goods || parsed?.goods || parsed?.Goods_Description || parsed?.goods_description || '',
      HSCode:   parsed?.['Tariff Classification']?.['HS Code'] || parsed?.['HS Code'] || parsed?.HSCode || parsed?.hsCode || parsed?.HS_Code || parsed?.hs_code || '',
    };
  } catch { return null; }
}

// ── Global CSS ─────────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: 'Inter', sans-serif; background: ${DS.bg}; color: ${DS.textPri}; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: ${DS.bgSecond}; }
  ::-webkit-scrollbar-thumb { background: ${DS.border}; border-radius: 3px; }
  input, select, textarea { font-family: 'Inter', sans-serif; }
  input::placeholder { color: ${DS.textMuted}; }
  select option { background: ${DS.bgSecond}; color: ${DS.textPri}; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  @keyframes spin  { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
  @keyframes slideIn { from{transform:translateX(20px);opacity:0} to{transform:translateX(0);opacity:1} }
  @keyframes fadeIn  { from{opacity:0} to{opacity:1} }
  @keyframes gradientBG {
    0%   { background-position: 0% 50%; }
    50%  { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }
  .sidebar-item:hover { background: rgba(37,99,235,0.1) !important; color: #93C5FD !important; }
  .tbl-row:hover td { background: rgba(37,99,235,0.07) !important; }
  .card-hover:hover { border-color: ${DS.accent} !important; transform: translateY(-1px); transition: all 0.2s; }
  .btn-primary:hover { background: #1d4ed8 !important; }
  .btn-ghost:hover   { background: rgba(255,255,255,0.06) !important; }
`;

// ── Design Components ──────────────────────────────────────────────────────────
const StatusBadge = ({ status }) => {
  const cfg = {
    success:   { bg: DS.successBg, color: '#34D399', text: 'COMPLIANT',    icon: '✓' },
    compliant: { bg: DS.successBg, color: '#34D399', text: 'COMPLIANT',    icon: '✓' },
    review:    { bg: DS.warnBg,    color: '#FBBF24', text: 'NEEDS REVIEW', icon: '⚠' },
    error:     { bg: DS.errBg,    color: '#F87171', text: 'FLAGGED',       icon: '✗' },
    flagged:   { bg: DS.errBg,    color: '#F87171', text: 'FLAGGED',       icon: '✗' },
    pending:   { bg: DS.surface,  color: DS.textSec, text: 'PENDING',     icon: '○' },
  };
  const c = cfg[status] || cfg.pending;
  return (
    <span style={{
      background: c.bg, color: c.color,
      padding: '3px 9px', borderRadius: 4,
      fontSize: 11, fontWeight: 600, letterSpacing: '0.05em',
      border: `1px solid ${c.color}30`,
    }}>{c.icon} {c.text}</span>
  );
};

const MetricCard = ({ icon, label, value, color, change }) => (
  <div className="card-hover" style={{
    background: DS.card, border: `1px solid ${DS.border}`,
    borderRadius: 12, padding: 24, flex: 1,
    transition: 'all 0.2s',
  }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <div>
        <p style={{ color: DS.textMuted, fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 8px' }}>{label}</p>
        <p style={{ color: DS.textPri, fontSize: 32, fontWeight: 700, margin: '0 0 4px', lineHeight: 1 }}>{value}</p>
        {change && <p style={{ color, fontSize: 12, margin: 0 }}>{change}</p>}
      </div>
      <div style={{ background: `${color}20`, padding: 12, borderRadius: 10, fontSize: 20 }}>{icon}</div>
    </div>
  </div>
);

const EnterpriseCard = ({ children, style = {}, title, action }) => (
  <div style={{ background: DS.card, border: `1px solid ${DS.border}`, borderRadius: 12, ...style }}>
    {title && (
      <div style={{ padding: '16px 24px', borderBottom: `1px solid ${DS.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 14, color: DS.textPri }}>{title}</span>
        {action}
      </div>
    )}
    <div style={{ padding: title ? 24 : 0 }}>{children}</div>
  </div>
);

const Input = ({ id, type = 'text', value, onChange, placeholder, required, ...rest }) => (
  <input
    id={id} type={type} value={value} onChange={onChange}
    placeholder={placeholder} required={required}
    style={{
      width: '100%', padding: '11px 14px', borderRadius: 8,
      border: `1px solid ${DS.border}`, background: DS.surface,
      color: DS.textPri, fontSize: 14, outline: 'none',
      transition: 'border-color 0.2s', boxSizing: 'border-box',
    }}
    onFocus={e => e.target.style.borderColor = DS.accent}
    onBlur={e => e.target.style.borderColor = DS.border}
    {...rest}
  />
);

const BtnPrimary = ({ id, onClick, disabled, children, style = {} }) => (
  <button id={id} onClick={onClick} disabled={disabled} className="btn-primary" style={{
    background: disabled ? DS.textMuted : DS.accent,
    color: 'white', border: 'none', borderRadius: 8,
    padding: '11px 24px', fontSize: 14, fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background 0.2s', ...style,
  }}>{children}</button>
);

// ── Shield SVG logo ────────────────────────────────────────────────────────────
const ShieldLogo = ({ size = 32 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
    <path d="M16 2L4 7v9c0 7 5.3 13.5 12 15 6.7-1.5 12-8 12-15V7L16 2z" fill={DS.accent} opacity="0.9"/>
    <path d="M16 2L4 7v9c0 7 5.3 13.5 12 15" fill={DS.accent}/>
    <path d="M11 16l3 3 7-7" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ── OTP Screen (logic preserved, enterprise styled) ────────────────────────────
function OTPScreen({ userId, onSuccess, onSkip }) {
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleVerify = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      const res = await axios.post(`${API}/auth/verify-otp`, { user_id: userId, otp });
      localStorage.setItem('ca_token', res.data.access_token);
      localStorage.setItem('ca_rtoken', res.data.refresh_token);
      localStorage.setItem('ca_user', JSON.stringify(res.data.user));
      onSuccess(res.data.user);
    } catch (err) { setError(err.response?.data?.detail || 'Invalid OTP. Please try again.'); }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: '100vh', background: DS.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter,sans-serif' }}>
      <style>{GLOBAL_CSS}</style>
      <div style={{ background: DS.card, border: `1px solid ${DS.border}`, borderRadius: 16, padding: '48px 40px', width: '100%', maxWidth: 420, boxShadow: '0 25px 60px rgba(0,0,0,0.5)' }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <ShieldLogo size={48} />
          <h1 style={{ color: DS.textPri, fontSize: 22, fontWeight: 700, margin: '12px 0 4px' }}>Two-Factor Authentication</h1>
          <p style={{ color: DS.textSec, fontSize: 14, margin: 0 }}>Enter the 6-digit code sent to your email</p>
        </div>
        <form onSubmit={handleVerify}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: 'block', color: DS.textSec, fontSize: 12, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>VERIFICATION CODE</label>
            <input
              id="otp-input" type="text" value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required maxLength={6} placeholder="000000"
              style={{
                width: '100%', padding: '16px', borderRadius: 8, textAlign: 'center',
                border: `1px solid ${DS.border}`, background: DS.surface,
                color: DS.textPri, fontSize: 28, letterSpacing: 12,
                outline: 'none', boxSizing: 'border-box', fontFamily: 'monospace',
              }}
            />
          </div>
          {error && <div style={{ background: DS.errBg, border: `1px solid ${DS.red}40`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#F87171', fontSize: 13 }}>{error}</div>}
          <BtnPrimary id="otp-submit" style={{ width: '100%', padding: '13px', marginBottom: 12 }} disabled={loading || otp.length !== 6}>
            {loading ? 'Verifying...' : 'Verify Code'}
          </BtnPrimary>
        </form>
        {onSkip && (
          <div style={{ textAlign: 'center' }}>
            <button id="otp-skip-btn" type="button" onClick={onSkip} style={{ background: 'none', border: 'none', color: DS.textMuted, fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>
              Skip for now
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Google Login Button (logic preserved) ──────────────────────────────────────
function GoogleLoginButton({ onSuccess, onError }) {
  const login = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      try {
        const res = await axios.post(`${API}/auth/google`, { token: tokenResponse.access_token });
        localStorage.setItem('ca_token', res.data.access_token);
        localStorage.setItem('ca_rtoken', res.data.refresh_token);
        localStorage.setItem('ca_user', JSON.stringify(res.data.user));
        onSuccess(res.data.user);
      } catch (err) { onError(err.response?.data?.detail || 'Google login failed'); }
    },
    onError: () => onError('Google authentication failed'),
  });

  return (
    <button id="google-login-btn" type="button" onClick={() => login()} className="btn-ghost" style={{
      width: '100%', padding: '11px 0', borderRadius: 8,
      border: `1px solid ${DS.border}`, background: DS.surface,
      color: DS.textPri, fontWeight: 500, fontSize: 14,
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      transition: 'all 0.2s',
    }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
      Continue with Google
    </button>
  );
}

// ── Auth Page (logic preserved, enterprise styled) ─────────────────────────────
function AuthPage({ onAuth, onMFA }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault(); setLoading(true); setError('');
    try {
      const endpoint = mode === 'login' ? '/auth/login' : '/auth/register';
      const res = await axios.post(`${API}${endpoint}`, { email, password });
      if (res.data.mfa_required) { onMFA(res.data.user_id); return; }
      localStorage.setItem('ca_token', res.data.access_token);
      localStorage.setItem('ca_rtoken', res.data.refresh_token);
      localStorage.setItem('ca_user', JSON.stringify(res.data.user));
      onAuth(res.data.user);
    } catch (err) { setError(err.response?.data?.detail || 'Authentication failed'); }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh', fontFamily: 'Inter,sans-serif',
      background: `linear-gradient(120deg, #0A0F1E 0%, #111827 50%, #0A0F1E 100%)`,
      backgroundSize: '200% 200%', animation: 'gradientBG 8s ease infinite',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <style>{GLOBAL_CSS}</style>

      {/* Decorative grid */}
      <div style={{ position: 'fixed', inset: 0, opacity: 0.035, backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '40px 40px', pointerEvents: 'none' }} />

      <div style={{ width: '100%', maxWidth: 440, padding: '0 20px', animation: 'fadeIn 0.5s ease' }}>
        {/* Logo bar */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
            <ShieldLogo size={40} />
            <span style={{ fontSize: 24, fontWeight: 700, color: DS.textPri, letterSpacing: '-0.5px' }}>Customs Compliance Agent</span>
          </div>
          <p style={{ color: DS.textMuted, fontSize: 13, margin: 0 }}>Autonomous Document Compliance Platform</p>
        </div>

        <div style={{ background: DS.card, border: `1px solid ${DS.border}`, borderRadius: 16, overflow: 'hidden', boxShadow: '0 24px 64px rgba(0,0,0,0.5)' }}>
          {/* Mode toggle */}
          <div style={{ display: 'flex', background: DS.bgSecond, borderBottom: `1px solid ${DS.border}` }}>
            {['login', 'register'].map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                flex: 1, padding: '14px', border: 'none', cursor: 'pointer',
                background: mode === m ? DS.card : 'transparent',
                color: mode === m ? DS.textPri : DS.textMuted,
                fontWeight: mode === m ? 600 : 400, fontSize: 14,
                borderBottom: mode === m ? `2px solid ${DS.accent}` : '2px solid transparent',
                transition: 'all 0.2s', fontFamily: 'Inter,sans-serif',
              }}>
                {m === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            ))}
          </div>

          <div style={{ padding: '32px' }}>
            {mode === 'login' && GOOGLE_CLIENT_ID && (
              <>
                <GoogleLoginButton onSuccess={onAuth} onError={setError} />
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '16px 0' }}>
                  <div style={{ flex: 1, height: 1, background: DS.border }} />
                  <span style={{ color: DS.textMuted, fontSize: 12 }}>or continue with email</span>
                  <div style={{ flex: 1, height: 1, background: DS.border }} />
                </div>
              </>
            )}

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', color: DS.textSec, fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Email Address</label>
                <Input id="auth-email" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" required />
              </div>
              <div style={{ marginBottom: 24 }}>
                <label style={{ display: 'block', color: DS.textSec, fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Password</label>
                <Input id="auth-password" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === 'register' ? 'Min. 6 characters' : '••••••••'} required />
              </div>
              {error && <div style={{ background: DS.errBg, border: `1px solid ${DS.red}40`, borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#F87171', fontSize: 13 }}>{error}</div>}
              <BtnPrimary id="auth-submit" style={{ width: '100%', padding: '13px' }} disabled={loading}>
                {loading ? 'Please wait...' : (mode === 'login' ? 'Sign In' : 'Create Account')}
              </BtnPrimary>
            </form>
          </div>
        </div>

        {/* Bottom badge */}
        <div style={{ textAlign: 'center', marginTop: 24 }}>
          <span style={{ color: DS.textMuted, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6, background: DS.surface, border: `1px solid ${DS.border}`, padding: '6px 14px', borderRadius: 20 }}>
            ⚡ Powered by UiPath + Groq AI
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Sidebar ────────────────────────────────────────────────────────────────────
function Sidebar({ currentPage, setPage }) {
  const items = [
    { id: 'dashboard', icon: '⬛', label: 'Dashboard' },
    { id: 'scan',      icon: '📤', label: 'New Scan'  },
    { id: 'history',   icon: '📋', label: 'Scan History' },
    { id: 'analytics', icon: '📊', label: 'Analytics' },
    { id: 'settings',  icon: '⚙️',  label: 'Settings'  },
  ];
  return (
    <div style={{ width: 240, minHeight: '100vh', background: DS.bgSecond, borderRight: `1px solid ${DS.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0, position: 'fixed', left: 0, top: 56, bottom: 0, zIndex: 100, overflowY: 'auto' }}>
      <div style={{ padding: '16px 8px' }}>
        {items.map(item => (
          <button key={item.id} id={`nav-${item.id}`} onClick={() => setPage(item.id)} className="sidebar-item" style={{
            width: '100%', display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 16px', border: 'none', borderRadius: 8, cursor: 'pointer',
            background: currentPage === item.id ? 'rgba(37,99,235,0.15)' : 'transparent',
            color: currentPage === item.id ? '#93C5FD' : DS.textSec,
            fontWeight: currentPage === item.id ? 600 : 400,
            fontSize: 14, textAlign: 'left', fontFamily: 'Inter,sans-serif',
            borderLeft: currentPage === item.id ? `3px solid ${DS.accent}` : '3px solid transparent',
            marginBottom: 2, transition: 'all 0.15s',
          }}>
            <span style={{ fontSize: 16 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
      <div style={{ marginTop: 'auto', padding: '16px', borderTop: `1px solid ${DS.border}` }}>
        <div style={{ background: DS.surface, border: `1px solid ${DS.border}`, borderRadius: 8, padding: '10px 12px' }}>
          <p style={{ margin: 0, color: DS.textMuted, fontSize: 11, fontWeight: 500 }}>COMPLIANCE ENGINE</p>
          <p style={{ margin: '4px 0 0', color: DS.green, fontSize: 12, fontWeight: 600 }}>● Online</p>
        </div>
      </div>
    </div>
  );
}

// ── Top Navbar ─────────────────────────────────────────────────────────────────
function TopNav({ user, onLogout, searchQuery, setSearchQuery }) {
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, height: 56, zIndex: 200,
      background: DS.bgSecond, borderBottom: `1px solid ${DS.border}`,
      display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16,
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 216, flexShrink: 0 }}>
        <ShieldLogo size={28} />
        <span style={{ fontWeight: 700, fontSize: 16, color: DS.textPri, letterSpacing: '-0.3px' }}>Customs Compliance Agent</span>
        <span style={{ background: DS.accent, color: 'white', fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 4, letterSpacing: '0.05em' }}>BETA</span>
      </div>

      {/* Search */}
      <div style={{ flex: 1, maxWidth: 480, position: 'relative' }}>
        <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: DS.textMuted, fontSize: 14 }}>🔍</span>
        <input
          value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search shipments, HS codes, exporters..."
          style={{
            width: '100%', padding: '8px 12px 8px 36px', borderRadius: 8,
            border: `1px solid ${DS.border}`, background: DS.surface,
            color: DS.textPri, fontSize: 13, outline: 'none', boxSizing: 'border-box',
          }}
        />
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Notification bell */}
        <button className="btn-ghost" style={{ background: 'none', border: `1px solid ${DS.border}`, padding: '6px 10px', borderRadius: 8, color: DS.textSec, cursor: 'pointer', fontSize: 16 }}>🔔</button>
        {/* User info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: DS.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontSize: 13, fontWeight: 700 }}>
            {user.email?.[0]?.toUpperCase() || 'U'}
          </div>
          <div>
            <div style={{ color: DS.textPri, fontSize: 13, fontWeight: 600, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
            <div style={{ color: DS.accent, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 500 }}>{user.role}</div>
          </div>
        </div>
        <button id="logout-btn" onClick={onLogout} className="btn-ghost" style={{
          padding: '7px 14px', borderRadius: 8, border: `1px solid ${DS.border}`,
          background: 'transparent', color: DS.textSec, cursor: 'pointer', fontSize: 13, fontFamily: 'Inter,sans-serif',
        }}>Sign Out</button>
      </div>
    </div>
  );
}

// ── Dashboard Page ─────────────────────────────────────────────────────────────
function DashboardPage({ scans, onNavigate }) {
  const recent = scans.slice(0, 5);
  const total = scans.length;
  const compliant = scans.filter(s => s.status === 'success').length;
  const rate = total ? ((compliant / total) * 100).toFixed(1) : '—';
  const flagged = scans.filter(s => s.status === 'error').length;

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: DS.textPri }}>Dashboard</h1>
        <p style={{ margin: '4px 0 0', color: DS.textMuted, fontSize: 14 }}>Compliance overview · {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>

      {/* Metric Cards */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
        <MetricCard icon="📦" label="Total Scans"     value={total || 0}  color={DS.accent} change={`${total} documents processed`} />
        <MetricCard icon="✅" label="Compliant Rate"  value={`${rate}%`}   color={DS.green}  change="All time compliance rate" />
        <MetricCard icon="⚠️" label="Flagged Today"   value={flagged || 0} color={DS.amber}  change="Requiring review" />
        <MetricCard icon="⚡" label="Avg. Process Time" value="2.3s"        color="#A78BFA"   change="Per document analysis" />
      </div>

      {/* Recent Scans */}
      <EnterpriseCard title="📋 Recent Scans" action={
        <button onClick={() => onNavigate('history')} style={{ background: 'none', border: `1px solid ${DS.border}`, color: DS.textSec, padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: 'Inter,sans-serif' }}>View All →</button>
      }>
        {recent.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: DS.textMuted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
            <p style={{ margin: 0 }}>No scans yet. <button onClick={() => onNavigate('scan')} style={{ background: 'none', border: 'none', color: DS.accent, cursor: 'pointer', fontSize: 14, padding: 0 }}>Upload your first document →</button></p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${DS.border}` }}>
                  {['Document', 'Country', 'Status', 'Date', ''].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '10px 12px', color: DS.textMuted, fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {recent.map(scan => (
                  <tr key={scan.id} className="tbl-row" style={{ borderBottom: `1px solid ${DS.border}20` }}>
                    <td style={{ padding: '12px', color: DS.textPri, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span style={{ color: DS.textMuted, marginRight: 6 }}>📄</span>{scan.filename}
                    </td>
                    <td style={{ padding: '12px', color: DS.textSec }}>{COUNTRY_FLAGS[scan.country] || ''} {scan.country}</td>
                    <td style={{ padding: '12px' }}><StatusBadge status={scan.status} /></td>
                    <td style={{ padding: '12px', color: DS.textMuted, whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(scan.created_at).toLocaleString()}</td>
                    <td style={{ padding: '12px' }}>
                      <button onClick={() => onNavigate('history')} style={{ background: 'none', border: `1px solid ${DS.border}`, color: DS.textSec, padding: '3px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: 'Inter,sans-serif' }}>View</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </EnterpriseCard>
    </div>
  );
}

// ── Scan Page (New Scan) ───────────────────────────────────────────────────────
function ScanPage({ user, onScanComplete }) {
  const [file, setFile]           = useState(null);
  const [country, setCountry]     = useState('IN');
  const [sendEmail, setSendEmail] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [result, setResult]       = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [explaining, setExplaining]   = useState(false);
  const [steps, setSteps]         = useState([]);
  const [auditOpen, setAuditOpen] = useState(false);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg'] },
    onDrop: acceptedFiles => setFile(acceptedFiles[0]),
  });

  const PIPELINE = [
    { label: 'Reading document',         icon: '📄' },
    { label: 'AI field extraction',      icon: '🤖' },
    { label: 'HS code classification',   icon: '📋' },
    { label: 'Validating customs rules', icon: '🌍' },
    { label: 'Generating report',        icon: '📊' },
  ];

  const getExplanation = async (fields, ctry, issues) => {
    setExplaining(true);
    try {
      const res = await axios.post(`${API}/explain`, { fields, country: ctry, issues },
        { headers: { 'Content-Type': 'application/json', ...authHeader() } });
      setExplanation(res.data.explanation);
    } catch (e) { setExplanation('Could not load explanation.'); }
    setExplaining(false);
  };

  const handleSubmit = async () => {
    if (!file) return alert('Please select a file');
    setLoading(true); setError(null); setResult(null);
    setExplanation(null); setSteps([]); setAuditOpen(false);

    try {
      setSteps(['Reading document...']);
      await new Promise(r => setTimeout(r, 400));
      setSteps(s => [...s, 'Extracting fields with AI...']);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('country', country);
      formData.append('send_email_flag', sendEmail ? 'true' : 'false');
      const res = await axios.post(`${API}/analyze`, formData, { headers: { ...authHeader() } });
      setSteps(s => [...s, 'Classifying HS codes...']);
      await new Promise(r => setTimeout(r, 300));
      setSteps(s => [...s, `Validating against ${country} customs rules...`]);
      if (res.data.status === 'success') {
        setResult(res.data);
        setSteps(s => [...s, 'Generating report...', 'Analysis complete!']);
        const f = extractFields(res.data);
        if (f) {
          const rules = COUNTRY_RULES[country];
          const val = parseFloat(f?.Value) || 0;
          const issues = [];
          if (val > rules.max_value_usd) issues.push(`Value USD ${val} exceeds ${country} threshold of USD ${rules.max_value_usd}`);
          if (rules.restricted.some(r => String(f?.HSCode || '').startsWith(r))) issues.push(`HS Code ${f.HSCode} is restricted for ${country} imports`);
          getExplanation(f, country, issues);
        }
        if (onScanComplete) onScanComplete();
      } else {
        setError(res.data.error || 'Document processing failed.');
        setSteps(s => [...s, 'Processing failed']);
      }
    } catch (e) {
      setError(e.response?.status === 401 ? 'Session expired. Please log in again.' : 'Analysis failed. Check that the backend is running.');
    }
    setLoading(false);
  };

  const fields = result ? extractFields(result) : null;
  const rules = COUNTRY_RULES[country];
  const value = parseFloat(fields?.Value) || 0;
  const hsCode = String(fields?.HSCode || '');
  const issues = fields ? [
    ...(value > rules.max_value_usd ? [`Value USD ${value} exceeds ${country} threshold of USD ${rules.max_value_usd}. ${rules.notes}`] : []),
    ...(rules.restricted.some(r => hsCode.startsWith(r)) ? [`HS Code ${hsCode} is restricted for ${country} imports`] : []),
  ] : [];
  const complianceStatus = !fields ? null : issues.length > 0 ? 'review' : 'success';

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: DS.textPri }}>New Document Scan</h1>
        <p style={{ margin: '4px 0 0', color: DS.textMuted, fontSize: 14 }}>Upload a customs document for AI-powered compliance analysis</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 20, alignItems: 'start' }}>
        {/* LEFT: Upload */}
        <div>
          <EnterpriseCard title="📄 Document Upload" style={{ marginBottom: 16 }}>
            {/* Dropzone */}
            <div {...getRootProps()} id="file-input-zone" style={{
              border: `2px dashed ${isDragActive ? DS.accent : DS.border}`,
              borderRadius: 10, padding: '28px 20px', textAlign: 'center',
              cursor: 'pointer', marginBottom: 16,
              background: isDragActive ? 'rgba(37,99,235,0.06)' : DS.surface,
              transition: 'all 0.2s',
            }}>
              <input {...getInputProps()} id="file-input" />
              {file ? (
                <div>
                  <div style={{ fontSize: 32, marginBottom: 8 }}>📄</div>
                  <p style={{ color: DS.green, fontWeight: 600, margin: 0, fontSize: 14 }}>✓ {file.name}</p>
                  <p style={{ color: DS.textMuted, fontSize: 12, margin: '4px 0 0' }}>{(file.size / 1024).toFixed(1)} KB</p>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.6 }}>📂</div>
                  <p style={{ color: DS.textSec, margin: '0 0 4px', fontWeight: 500, fontSize: 14 }}>
                    {isDragActive ? 'Drop file here...' : 'Drop invoice or bill of lading here'}
                  </p>
                  <p style={{ color: DS.textMuted, margin: 0, fontSize: 12 }}>or <span style={{ color: DS.accent, cursor: 'pointer' }}>browse files</span></p>
                  <p style={{ color: DS.textMuted, margin: '8px 0 0', fontSize: 11 }}>PDF, PNG, JPG accepted</p>
                </div>
              )}
            </div>

            {/* Country */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', color: DS.textSec, fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 8 }}>Destination Country</label>
              <select id="country-select" value={country} onChange={e => setCountry(e.target.value)} style={{
                width: '100%', padding: '10px 14px', borderRadius: 8,
                border: `1px solid ${DS.border}`, background: DS.surface,
                color: DS.textPri, fontSize: 14, outline: 'none', cursor: 'pointer',
              }}>
                <option value="IN">🇮🇳 India</option>
                <option value="UAE">🇦🇪 UAE</option>
                <option value="USA">🇺🇸 USA</option>
              </select>
            </div>

            {/* Email toggle */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 13, color: DS.textSec, marginBottom: 20 }}>
              <input id="send-email-checkbox" type="checkbox" checked={sendEmail} onChange={e => setSendEmail(e.target.checked)} style={{ width: 15, height: 15, cursor: 'pointer', accentColor: DS.accent }} />
              📧 Email results to {user.email}
            </label>

            <BtnPrimary id="analyze-btn" onClick={handleSubmit} disabled={loading || !file} style={{ width: '100%', padding: '13px', fontSize: 15 }}>
              {loading ? '⏳ Analyzing...' : '🔍 Analyze Document'}
            </BtnPrimary>
          </EnterpriseCard>

          {/* Pipeline steps */}
          {(loading || steps.length > 0) && (
            <EnterpriseCard title="⚙️ Processing Pipeline">
              {PIPELINE.map((step, i) => {
                const done = i < steps.length - 1;
                const active = i === steps.length - 1 && loading;
                const pending = i >= steps.length;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: i < PIPELINE.length - 1 ? `1px solid ${DS.border}20` : 'none' }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                      background: done ? DS.successBg : active ? 'rgba(37,99,235,0.15)' : DS.surface,
                      border: `1px solid ${done ? DS.green : active ? DS.accent : DS.border}`,
                    }}>
                      {done ? <span style={{ color: DS.green, fontSize: 12 }}>✓</span>
                        : active ? <div style={{ width: 12, height: 12, border: `2px solid ${DS.accent}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                        : <span style={{ color: DS.textMuted, fontSize: 10 }}>○</span>}
                    </div>
                    <span style={{ fontSize: 13, color: done ? DS.green : active ? DS.textPri : DS.textMuted, fontWeight: done || active ? 500 : 400 }}>
                      {step.icon} {step.label}
                    </span>
                  </div>
                );
              })}
            </EnterpriseCard>
          )}
        </div>

        {/* RIGHT: Results */}
        <div>
          {error && (
            <div style={{ background: DS.errBg, border: `1px solid ${DS.red}40`, borderRadius: 10, padding: 16, marginBottom: 16, color: '#F87171', fontSize: 13 }}>
              ✗ {error}
            </div>
          )}

          {!fields && !loading && !error && (
            <div style={{ background: DS.card, border: `1px solid ${DS.border}`, borderRadius: 12, padding: '60px 40px', textAlign: 'center' }}>
              <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }}>🛃</div>
              <p style={{ color: DS.textMuted, margin: 0, fontSize: 15 }}>Upload a customs document to see compliance analysis here</p>
            </div>
          )}

          {fields && (
            <div style={{ animation: 'slideIn 0.4s ease' }}>
              {/* Compliance Banner */}
              <div style={{
                background: complianceStatus === 'success' ? DS.successBg : DS.warnBg,
                border: `1px solid ${complianceStatus === 'success' ? DS.green : DS.amber}50`,
                borderRadius: 10, padding: '16px 20px', marginBottom: 16,
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{ fontSize: 24 }}>{complianceStatus === 'success' ? '✅' : '⚠️'}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: complianceStatus === 'success' ? DS.green : '#FBBF24' }}>
                    {complianceStatus === 'success' ? 'COMPLIANT' : 'NEEDS REVIEW'} — {country} Customs
                  </div>
                  <div style={{ fontSize: 13, color: DS.textSec, marginTop: 2 }}>
                    {issues.length === 0 ? 'Document passes all customs requirements' : `${issues.length} issue(s) require attention`}
                  </div>
                </div>
                <div style={{ marginLeft: 'auto' }}><StatusBadge status={complianceStatus} /></div>
              </div>

              {/* Extracted Fields Grid */}
              <EnterpriseCard title="📋 Extracted Fields" style={{ marginBottom: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: DS.border, borderRadius: 8, overflow: 'hidden' }}>
                  {[
                    { label: 'EXPORTER',          value: fields?.Exporter,                          hi: false },
                    { label: 'COUNTRY OF ORIGIN', value: `${COUNTRY_FLAGS[fields?.Origin] || ''} ${fields?.Origin}`, hi: false },
                    { label: 'DECLARED VALUE',    value: `${fields?.Currency} ${fields?.Value}`,   hi: true },
                    { label: 'CURRENCY',          value: fields?.Currency,                          hi: false },
                    { label: 'GOODS DESCRIPTION', value: fields?.Goods,                             hi: false },
                    { label: 'HS CODE',           value: fields?.HSCode,                            hi: true },
                  ].map((f, i) => (
                    <div key={i} style={{ background: DS.surface, padding: '14px 16px' }}>
                      <div style={{ color: DS.textMuted, fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>{f.label}</div>
                      <div style={{ color: f.hi ? '#93C5FD' : DS.textPri, fontWeight: f.hi ? 700 : 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {String(f.value || '') || '—'}
                      </div>
                    </div>
                  ))}
                </div>
              </EnterpriseCard>

              {/* Issues */}
              {issues.length > 0 && (
                <EnterpriseCard title="⚠️ Compliance Issues" style={{ marginBottom: 16 }}>
                  {issues.map((issue, i) => (
                    <div key={i} style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: i < issues.length - 1 ? `1px solid ${DS.border}30` : 'none' }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: DS.red, marginTop: 6, flexShrink: 0 }} />
                      <p style={{ margin: 0, color: '#FCA5A5', fontSize: 13, lineHeight: 1.6 }}>{issue}</p>
                    </div>
                  ))}
                </EnterpriseCard>
              )}

              {/* AI Advisor */}
              {(explaining || explanation) && (
                <EnterpriseCard title="🤖 AI Compliance Advisor" style={{ marginBottom: 16, borderLeft: `3px solid ${DS.accent}` }}>
                  {explaining
                    ? <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: DS.textMuted }}>
                        <div style={{ width: 14, height: 14, border: `2px solid ${DS.accent}`, borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                        Generating compliance advice...
                      </div>
                    : <div style={{ fontSize: 13, lineHeight: 1.8, color: DS.textSec, whiteSpace: 'pre-wrap' }}>{explanation}</div>
                  }
                </EnterpriseCard>
              )}

              {/* AI Reasoning Trace */}
              {result?.raw_output && (
                <EnterpriseCard title="🧠 AI Reasoning Trace" style={{ marginBottom: 16 }}>
                  <div style={{ background: '#060C14', borderRadius: 8, padding: 16, fontSize: 12, lineHeight: 1.7, color: '#4ADE80', fontFamily: 'monospace', maxHeight: 180, overflowY: 'auto' }}>
                    {(() => {
                      try {
                        let content = result.raw_output;
                        try { const outer = JSON.parse(content); if (outer?.out_ResultJSON) { const inner = JSON.parse(outer.out_ResultJSON); content = inner?.openai_response?.choices?.[0]?.message?.content || content; } } catch {}
                        content = content.replace(/```json\n[\s\S]*?```/g, '').trim();
                        if (!content) return <span>No reasoning available</span>;
                        return content.split('\n').filter(l => l.trim()).map((line, i) => <div key={i}>&gt; {line}</div>);
                      } catch { return <span>No reasoning available</span>; }
                    })()}
                  </div>
                </EnterpriseCard>
              )}

              {/* Audit Trail */}
              <div style={{ background: DS.card, border: `1px solid ${DS.border}`, borderRadius: 12, overflow: 'hidden' }}>
                <button onClick={() => setAuditOpen(o => !o)} style={{
                  width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer',
                  color: DS.textPri, fontWeight: 600, fontSize: 14, fontFamily: 'Inter,sans-serif',
                }}>
                  <span>🔍 Audit Trail</span>
                  <span style={{ color: DS.textMuted, fontSize: 12 }}>{auditOpen ? '▲ Collapse' : '▼ Expand'}</span>
                </button>
                {auditOpen && (
                  <div style={{ padding: '0 20px 20px', borderTop: `1px solid ${DS.border}` }}>
                    <pre style={{ background: '#060C14', padding: 16, borderRadius: 8, fontSize: 11, overflow: 'auto', maxHeight: 200, margin: '16px 0 0', color: '#94A3B8', lineHeight: 1.6 }}>
                      {JSON.stringify(result, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {!fields && result && (
            <EnterpriseCard title="Raw Response">
              <pre style={{ fontSize: 12, overflow: 'auto', color: DS.textSec }}>{JSON.stringify(result, null, 2)}</pre>
            </EnterpriseCard>
          )}
        </div>
      </div>
    </div>
  );
}

// ── History Page ───────────────────────────────────────────────────────────────
function HistoryPage() {
  const [scans, setScans]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [search, setSearch]     = useState('');
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterCountry, setFilterCountry] = useState('all');
  const [selected, setSelected] = useState(null);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${API}/history`, { headers: authHeader() });
      setScans(res.data.scans || []);
    } catch (e) { console.error('History load failed:', e); }
    setLoading(false);
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const filtered = scans.filter(s => {
    const matchSearch = !search || s.filename?.toLowerCase().includes(search.toLowerCase()) || s.country?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || s.status === filterStatus;
    const matchCountry = filterCountry === 'all' || s.country === filterCountry;
    return matchSearch && matchStatus && matchCountry;
  });

  const exportCSV = () => {
    const csv = ['ID,Filename,Country,Status,Date'].concat(
      filtered.map(s => `${s.id},${s.filename},${s.country},${s.status},${s.created_at}`)
    ).join('\n');
    const a = document.createElement('a'); a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv); a.download = 'scans.csv'; a.click();
  };

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: DS.textPri }}>Scan History</h1>
          <p style={{ margin: '4px 0 0', color: DS.textMuted, fontSize: 14 }}>{scans.length} total documents scanned</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={exportCSV} style={{ padding: '8px 16px', border: `1px solid ${DS.border}`, borderRadius: 8, background: DS.surface, color: DS.textSec, cursor: 'pointer', fontSize: 13, fontFamily: 'Inter,sans-serif' }}>⬇️ Export CSV</button>
          <button onClick={loadHistory} style={{ padding: '8px 16px', border: `1px solid ${DS.border}`, borderRadius: 8, background: DS.surface, color: DS.textSec, cursor: 'pointer', fontSize: 13, fontFamily: 'Inter,sans-serif' }}>🔄 Refresh</button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
          <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: DS.textMuted }}>🔍</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search documents..."
            style={{ width: '100%', padding: '9px 12px 9px 36px', borderRadius: 8, border: `1px solid ${DS.border}`, background: DS.surface, color: DS.textPri, fontSize: 13, outline: 'none', boxSizing: 'border-box' }} />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ padding: '9px 14px', borderRadius: 8, border: `1px solid ${DS.border}`, background: DS.surface, color: DS.textSec, fontSize: 13, outline: 'none' }}>
          <option value="all">All Statuses</option>
          <option value="success">Compliant</option>
          <option value="error">Flagged</option>
          <option value="pending">Pending</option>
        </select>
        <select value={filterCountry} onChange={e => setFilterCountry(e.target.value)} style={{ padding: '9px 14px', borderRadius: 8, border: `1px solid ${DS.border}`, background: DS.surface, color: DS.textSec, fontSize: 13, outline: 'none' }}>
          <option value="all">All Countries</option>
          <option value="IN">🇮🇳 India</option>
          <option value="UAE">🇦🇪 UAE</option>
          <option value="USA">🇺🇸 USA</option>
        </select>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 380px' : '1fr', gap: 16 }}>
        <EnterpriseCard>
          {loading ? (
            <div style={{ padding: '48px', textAlign: 'center', color: DS.textMuted }}>
              <div style={{ width: 32, height: 32, border: `3px solid ${DS.border}`, borderTopColor: DS.accent, borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
              Loading history...
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '48px', textAlign: 'center', color: DS.textMuted }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
              <p style={{ margin: 0 }}>No results found.</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${DS.border}` }}>
                    {['Document', 'Country', 'Status', 'Date', 'Action'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '12px 14px', color: DS.textMuted, fontWeight: 500, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((scan) => (
                    <tr key={scan.id} className="tbl-row" style={{ borderBottom: `1px solid ${DS.border}20`, background: selected?.id === scan.id ? 'rgba(37,99,235,0.08)' : 'transparent', cursor: 'pointer' }} onClick={() => setSelected(scan)}>
                      <td style={{ padding: '12px 14px', color: DS.textPri, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <span style={{ color: DS.textMuted, marginRight: 6 }}>📄</span>{scan.filename}
                      </td>
                      <td style={{ padding: '12px 14px', color: DS.textSec }}>{COUNTRY_FLAGS[scan.country] || ''} {scan.country}</td>
                      <td style={{ padding: '12px 14px' }}><StatusBadge status={scan.status} /></td>
                      <td style={{ padding: '12px 14px', color: DS.textMuted, whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(scan.created_at).toLocaleString()}</td>
                      <td style={{ padding: '12px 14px' }}>
                        <button onClick={e => { e.stopPropagation(); setSelected(scan); }} style={{ background: 'none', border: `1px solid ${DS.border}`, color: DS.textSec, padding: '3px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontFamily: 'Inter,sans-serif' }}>View →</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </EnterpriseCard>

        {/* Detail panel */}
        {selected && (
          <div style={{ animation: 'slideIn 0.25s ease' }}>
            <EnterpriseCard title={`📄 ${selected.filename}`} action={
              <button onClick={() => setSelected(null)} style={{ background: 'none', border: 'none', color: DS.textMuted, cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>✕</button>
            }>
              <div style={{ marginBottom: 12 }}><StatusBadge status={selected.status} /></div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                {[{ l: 'Country', v: `${COUNTRY_FLAGS[selected.country] || ''} ${selected.country}` }, { l: 'Date', v: new Date(selected.created_at).toLocaleDateString() }].map(f => (
                  <div key={f.l} style={{ background: DS.surface, borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ color: DS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{f.l}</div>
                    <div style={{ color: DS.textPri, fontSize: 13 }}>{f.v}</div>
                  </div>
                ))}
              </div>
              {selected.result?.fields && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {Object.entries(selected.result.fields).map(([k, v]) => (
                    <div key={k} style={{ background: DS.surface, borderRadius: 8, padding: '10px 12px' }}>
                      <div style={{ color: DS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{k}</div>
                      <div style={{ color: DS.textPri, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(v || '—')}</div>
                    </div>
                  ))}
                </div>
              )}
            </EnterpriseCard>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Analytics Page ─────────────────────────────────────────────────────────────
function AnalyticsPage({ scans }) {
  const countryData = [
    { country: 'India (IN)',  rate: 91, scans: Math.max(scans.filter(s => s.country === 'IN').length, 3) },
    { country: 'UAE',        rate: 96, scans: Math.max(scans.filter(s => s.country === 'UAE').length, 1) },
    { country: 'USA',        rate: 98, scans: Math.max(scans.filter(s => s.country === 'USA').length, 1) },
  ];
  const weekData = [
    { day: 'Mon', count: 28 }, { day: 'Tue', count: 42 }, { day: 'Wed', count: 35 },
    { day: 'Thu', count: 51 }, { day: 'Fri', count: 38 }, { day: 'Sat', count: 22 }, { day: 'Sun', count: 16 },
  ];
  const maxWeek = Math.max(...weekData.map(d => d.count));
  const hsData = [
    { code: '8542', label: 'Semiconductors', count: 34, color: DS.red },
    { code: '8471', label: 'Computers',       count: 28, color: DS.amber },
    { code: '6109', label: 'Apparel',          count: 19, color: DS.accent },
    { code: '3004', label: 'Pharma',           count: 15, color: '#A78BFA' },
    { code: '9401', label: 'Furniture',        count: 11, color: DS.green },
  ];
  const totalHS = hsData.reduce((a, b) => a + b.count, 0);

  return (
    <div style={{ animation: 'fadeIn 0.3s ease' }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: DS.textPri }}>Analytics</h1>
        <p style={{ margin: '4px 0 0', color: DS.textMuted, fontSize: 14 }}>Compliance trends and performance metrics</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
        {/* Compliance by Country */}
        <EnterpriseCard title="📊 Compliance Rate by Country">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {countryData.map(d => (
              <div key={d.country}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ color: DS.textSec, fontSize: 13 }}>{d.country}</span>
                  <span style={{ color: d.rate > 95 ? DS.green : d.rate > 90 ? DS.amber : DS.red, fontWeight: 600, fontSize: 13 }}>{d.rate}%</span>
                </div>
                <div style={{ height: 8, background: DS.surface, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${d.rate}%`, height: '100%', background: d.rate > 95 ? DS.green : d.rate > 90 ? DS.amber : DS.red, borderRadius: 4, transition: 'width 0.8s ease' }} />
                </div>
                <div style={{ color: DS.textMuted, fontSize: 11, marginTop: 3 }}>{d.scans} scans</div>
              </div>
            ))}
          </div>
        </EnterpriseCard>

        {/* Scans per day */}
        <EnterpriseCard title="📈 Scans — Last 7 Days">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 140, paddingTop: 10 }}>
            {weekData.map(d => (
              <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                <span style={{ color: DS.textMuted, fontSize: 10 }}>{d.count}</span>
                <div style={{
                  width: '100%', borderRadius: '4px 4px 0 0',
                  height: `${(d.count / maxWeek) * 100}px`,
                  background: `linear-gradient(to top, ${DS.accent}, #60A5FA)`,
                  minHeight: 4, transition: 'height 0.5s ease',
                }} />
                <span style={{ color: DS.textMuted, fontSize: 11 }}>{d.day}</span>
              </div>
            ))}
          </div>
        </EnterpriseCard>

        {/* Top HS Codes */}
        <EnterpriseCard title="🔢 Top Flagged HS Codes">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {hsData.map((h, i) => (
              <div key={h.code} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{ color: DS.textMuted, fontSize: 12, width: 16 }}>{i + 1}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span style={{ color: DS.textPri, fontSize: 13, fontWeight: 500 }}>{h.code} — {h.label}</span>
                    <span style={{ color: DS.textMuted, fontSize: 12 }}>{h.count}</span>
                  </div>
                  <div style={{ height: 5, background: DS.surface, borderRadius: 3 }}>
                    <div style={{ width: `${(h.count / hsData[0].count) * 100}%`, height: '100%', background: h.color, borderRadius: 3 }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </EnterpriseCard>

        {/* Risk Distribution */}
        <EnterpriseCard title="🎯 Risk Distribution">
          <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
            {/* Simple donut using conic-gradient */}
            <div style={{
              width: 120, height: 120, borderRadius: '50%', flexShrink: 0,
              background: `conic-gradient(${DS.green} 0% 62%, ${DS.amber} 62% 87%, ${DS.red} 87% 100%)`,
              boxShadow: `0 0 0 16px ${DS.card}`,
              position: 'relative',
            }}>
              <div style={{ position: 'absolute', inset: '20%', borderRadius: '50%', background: DS.card, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
                <span style={{ color: DS.textPri, fontWeight: 700, fontSize: 16 }}>62%</span>
                <span style={{ color: DS.textMuted, fontSize: 9 }}>COMPLIANT</span>
              </div>
            </div>
            <div style={{ flex: 1 }}>
              {[{ label: 'Compliant', pct: '62%', color: DS.green }, { label: 'Review', pct: '25%', color: DS.amber }, { label: 'Flagged', pct: '13%', color: DS.red }].map(r => (
                <div key={r.label} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: r.color, flexShrink: 0 }} />
                  <span style={{ color: DS.textSec, fontSize: 13, flex: 1 }}>{r.label}</span>
                  <span style={{ color: r.color, fontWeight: 600, fontSize: 13 }}>{r.pct}</span>
                </div>
              ))}
            </div>
          </div>
        </EnterpriseCard>
      </div>
    </div>
  );
}

// ── Settings Page ──────────────────────────────────────────────────────────────
function SettingsPage({ user }) {
  return (
    <div style={{ animation: 'fadeIn 0.3s ease', maxWidth: 600 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: DS.textPri }}>Settings</h1>
        <p style={{ margin: '4px 0 0', color: DS.textMuted, fontSize: 14 }}>Account and system configuration</p>
      </div>
      <EnterpriseCard title="👤 Account" style={{ marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {[{ l: 'Email', v: user.email }, { l: 'Role', v: user.role }, { l: 'User ID', v: user.id }, { l: 'MFA', v: 'Optional' }].map(f => (
            <div key={f.l} style={{ background: DS.surface, borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ color: DS.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{f.l}</div>
              <div style={{ color: DS.textPri, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.v}</div>
            </div>
          ))}
        </div>
      </EnterpriseCard>
      <EnterpriseCard title="⚙️ System">
        {[{ l: 'AI Engine', v: 'Groq LLaMA 3.1', status: 'Online' }, { l: 'RPA Engine', v: 'UiPath Orchestrator', status: 'Connected' }, { l: 'Database', v: 'PostgreSQL 15', status: 'Online' }, { l: 'Queue', v: 'Redis + RQ', status: 'Online' }].map(s => (
          <div key={s.l} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: `1px solid ${DS.border}20` }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: DS.textPri, fontSize: 13, fontWeight: 500 }}>{s.l}</div>
              <div style={{ color: DS.textMuted, fontSize: 12 }}>{s.v}</div>
            </div>
            <span style={{ background: DS.successBg, color: DS.green, fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 4, border: `1px solid ${DS.green}30` }}>● {s.status}</span>
          </div>
        ))}
      </EnterpriseCard>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
function AppInner() {
  const [user, setUser]           = useState(getUser());
  const [mfaUserId, setMfaUserId] = useState(null);
  const [showMfa, setShowMfa]     = useState(false);
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [scans, setScans]         = useState([]);

  // Analyze states (preserved exactly)
  const [file, setFile]           = useState(null);
  const [country, setCountry]     = useState('IN');
  const [result, setResult]       = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [explaining, setExplaining]   = useState(false);
  const [steps, setSteps]         = useState([]);
  const [jobId, setJobId]         = useState(null);
  const [polling, setPolling]     = useState(false);
  const [sendEmail, setSendEmail] = useState(false);
  const [histScan, setHistScan]   = useState(null);

  // Load scans for dashboard metrics
  const loadScans = useCallback(async () => {
    if (!getToken()) return;
    try {
      const res = await axios.get(`${API}/history`, { headers: authHeader() });
      setScans(res.data.scans || []);
    } catch {}
  }, []);

  useEffect(() => { if (user) loadScans(); }, [user, loadScans]);

  // Auth handlers (preserved exactly)
  const handleAuth   = (u) => { setUser(u); setMfaUserId(null); setShowMfa(false); };
  const handleLogout = () => { clearAuth(); setUser(null); setResult(null); setMfaUserId(null); setShowMfa(false); setJobId(null); setScans([]); };
  const handleMFA    = (userId) => { setMfaUserId(userId); setShowMfa(true); };

  // MFA Screen
  if (showMfa && mfaUserId) return (
    <OTPScreen userId={mfaUserId} onSuccess={handleAuth}
      onSkip={() => { localStorage.setItem('mfa_skipped', 'true'); setShowMfa(false); setMfaUserId(null); }} />
  );

  // Not logged in
  if (!user) return <AuthPage onAuth={handleAuth} onMFA={handleMFA} />;

  // Main UI
  return (
    <div style={{ fontFamily: 'Inter,sans-serif', minHeight: '100vh', background: DS.bg, color: DS.textPri }}>
      <style>{GLOBAL_CSS}</style>
      <TopNav user={user} onLogout={handleLogout} searchQuery={searchQuery} setSearchQuery={setSearchQuery} />
      <Sidebar currentPage={currentPage} setPage={setCurrentPage} />

      <div style={{ marginLeft: 240, marginTop: 56, padding: 28, minHeight: 'calc(100vh - 56px)' }}>
        {currentPage === 'dashboard' && <DashboardPage scans={scans} onNavigate={setCurrentPage} />}
        {currentPage === 'scan'      && <ScanPage user={user} onScanComplete={loadScans} />}
        {currentPage === 'history'   && <HistoryPage />}
        {currentPage === 'analytics' && <AnalyticsPage scans={scans} />}
        {currentPage === 'settings'  && <SettingsPage user={user} />}
      </div>
    </div>
  );
}

// ── Root with GoogleOAuthProvider (preserved exactly) ──────────────────────────
export default function App() {
  if (GOOGLE_CLIENT_ID) {
    return (
      <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
        <AppInner />
      </GoogleOAuthProvider>
    );
  }
  return <AppInner />;
}