import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { GoogleOAuthProvider, useGoogleLogin } from '@react-oauth/google';

const API = 'http://localhost:8000';
const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || '';

const COUNTRY_RULES = {
  IN: { max_value_usd: 800, notes: "Values above USD 800 require Bill of Entry filing", restricted: ["9301", "9302"] },
  UAE: { max_value_usd: 1000, notes: "VAT registration required for commercial consignments", restricted: ["9301", "9302", "2402"] },
  USA: { max_value_usd: 800, notes: "Section 321 de minimis applies below USD 800", restricted: ["9301"] }
};

// ── Token helpers ──────────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem('ca_token');
const setToken = (t) => localStorage.setItem('ca_token', t);
const clearAuth = () => { localStorage.removeItem('ca_token'); localStorage.removeItem('ca_rtoken'); localStorage.removeItem('ca_user'); };
const getUser = () => { try { return JSON.parse(localStorage.getItem('ca_user')); } catch { return null; } };
const authHeader = () => ({ Authorization: `Bearer ${getToken()}` });

function extractFields(result) {
  if (result?.fields && Object.keys(result.fields).length > 0) {
    return result.fields;
  }

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
  } catch {
    // Not a JSON envelope, use raw string directly
  }

  try {
    const matches = [...content.matchAll(/```json\n([\s\S]*?)```/g)];
    if (!matches.length) return null;
    const parsed = JSON.parse(matches[matches.length - 1][1]);
    return {
      Exporter: typeof (parsed?.Exporter) === 'object'
        ? (parsed?.Exporter?.Name || parsed?.Exporter?.CompanyName || JSON.stringify(parsed?.Exporter))
        : (parsed?.Exporter || parsed?.exporter || ""),
      Origin: parsed?.Origin?.Country || parsed?.Origin || parsed?.origin || "",
      Value: parsed?.["Import/Export"]?.Value || parsed?.Value?.amount || parsed?.value?.amount || parsed?.Value || parsed?.value || "",
      Currency: parsed?.["Import/Export"]?.Currency || parsed?.Value?.currency || parsed?.value?.currency || parsed?.Currency || parsed?.currency || "USD",
      Goods: parsed?.["Description of Goods"]?.Goods || parsed?.Goods || parsed?.goods || parsed?.Goods_Description || parsed?.goods_description || "",
      HSCode: parsed?.["Tariff Classification"]?.["HS Code"] || parsed?.["HS Code"] || parsed?.HSCode || parsed?.hsCode || parsed?.HS_Code || parsed?.hs_code || ""
    };
  } catch { return null; }
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function ComplianceCard({ fields, country }) {
  if (!fields) return null;
  const rules = COUNTRY_RULES[country];
  const value = parseFloat(fields?.Value) || 0;
  const hsCode = String(fields?.HSCode || "");
  const issues = [];
  if (value > rules.max_value_usd) {
    issues.push(`⚠️ Value USD ${value} exceeds ${country} threshold of USD ${rules.max_value_usd}. ${rules.notes}`);
  }
  if (rules.restricted.some(r => hsCode.startsWith(r))) {
    issues.push(`🚫 HS Code ${hsCode} is restricted for ${country} imports`);
  }
  return (
    <div style={{ background: issues.length ? '#fff8f0' : '#f0fff4', border: `1px solid ${issues.length ? '#f6ad55' : '#68d391'}`, borderRadius: 12, padding: 24, marginBottom: 16 }}>
      <h3 style={{ marginTop: 0, color: issues.length ? '#c05621' : '#276749' }}>
        {issues.length ? '⚠️ Needs Review' : '✅ Compliant'} — {country} Customs
      </h3>
      {issues.length > 0
        ? issues.map((i, idx) => <p key={idx} style={{ margin: '8px 0', color: '#c05621' }}>{i}</p>)
        : <p style={{ margin: 0, color: '#276749' }}>Document passes all {country} customs requirements</p>
      }
    </div>
  );
}

function FieldCard({ label, value, highlight }) {
  const displayValue = typeof value === 'object' ? JSON.stringify(value) : value;
  return (
    <div style={{ background: highlight ? '#ebf8ff' : '#f8f9fa', border: `1px solid ${highlight ? '#90cdf4' : '#dee2e6'}`, borderRadius: 8, padding: '12px 16px', marginBottom: 8 }}>
      <div style={{ fontSize: 11, color: '#718096', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: '#1a202c', marginTop: 4 }}>{displayValue || '—'}</div>
    </div>
  );
}

// ── OTP Verification Screen ────────────────────────────────────────────────────
function OTPScreen({ userId, onSuccess }) {
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleVerify = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res = await axios.post(`${API}/auth/verify-otp`, { user_id: userId, otp });
      localStorage.setItem('ca_token', res.data.access_token);
      localStorage.setItem('ca_rtoken', res.data.refresh_token);
      localStorage.setItem('ca_user', JSON.stringify(res.data.user));
      onSuccess(res.data.user);
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid OTP. Please try again.');
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Inter, sans-serif'
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 20, padding: '48px 40px',
        width: '100%', maxWidth: 420,
        boxShadow: '0 25px 50px rgba(0,0,0,0.4)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🔐</div>
          <h1 style={{ color: 'white', fontSize: 22, fontWeight: 700, margin: 0 }}>Two-Factor Verification</h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, marginTop: 8 }}>
            Enter the 6-digit OTP sent to your email.
          </p>
        </div>
        <form onSubmit={handleVerify}>
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 6 }}>OTP Code</label>
            <input
              id="otp-input"
              type="text"
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
              required
              maxLength={6}
              placeholder="123456"
              style={{
                width: '100%', padding: '14px', borderRadius: 10, textAlign: 'center',
                border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)',
                color: 'white', fontSize: 24, letterSpacing: 8, outline: 'none', boxSizing: 'border-box'
              }}
            />
          </div>
          {error && (
            <div style={{ background: 'rgba(252,129,129,0.15)', border: '1px solid rgba(252,129,129,0.4)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#fc8181', fontSize: 14 }}>
              {error}
            </div>
          )}
          <button id="otp-submit" type="submit" disabled={loading || otp.length !== 6} style={{
            width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: (loading || otp.length !== 6) ? 'rgba(255,255,255,0.2)' : 'linear-gradient(135deg, #667eea, #764ba2)',
            color: 'white', fontWeight: 700, fontSize: 16, transition: 'all 0.2s'
          }}>
            {loading ? '⏳ Verifying...' : 'Verify OTP'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── Google Login Button ────────────────────────────────────────────────────────
function GoogleLoginButton({ onSuccess, onError }) {
  const login = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      try {
        const res = await axios.post(`${API}/auth/google`, { token: tokenResponse.access_token });
        localStorage.setItem('ca_token', res.data.access_token);
        localStorage.setItem('ca_rtoken', res.data.refresh_token);
        localStorage.setItem('ca_user', JSON.stringify(res.data.user));
        onSuccess(res.data.user);
      } catch (err) {
        onError(err.response?.data?.detail || 'Google login failed');
      }
    },
    onError: () => onError('Google authentication failed'),
  });

  return (
    <button
      id="google-login-btn"
      type="button"
      onClick={() => login()}
      style={{
        width: '100%', padding: '12px 0', borderRadius: 10, border: '1px solid rgba(255,255,255,0.2)',
        background: 'rgba(255,255,255,0.08)', color: 'white', fontWeight: 600, fontSize: 15,
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        marginBottom: 16, transition: 'all 0.2s'
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
      Continue with Google
    </button>
  );
}

// ── Login / Register Page ──────────────────────────────────────────────────────
function AuthPage({ onAuth, onMFA }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const endpoint = mode === 'login' ? '/auth/login' : '/auth/register';
      const res = await axios.post(`${API}${endpoint}`, { email, password });

      // MFA flow — if server says OTP required
      if (res.data.mfa_required) {
        onMFA(res.data.user_id);
        return;
      }

      localStorage.setItem('ca_token', res.data.access_token);
      localStorage.setItem('ca_rtoken', res.data.refresh_token);
      localStorage.setItem('ca_user', JSON.stringify(res.data.user));
      onAuth(res.data.user);
    } catch (err) {
      setError(err.response?.data?.detail || 'Authentication failed');
    }
    setLoading(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Inter, sans-serif'
    }}>
      <div style={{
        background: 'rgba(255,255,255,0.05)',
        backdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 20, padding: '48px 40px',
        width: '100%', maxWidth: 420,
        boxShadow: '0 25px 50px rgba(0,0,0,0.4)'
      }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🛃</div>
          <h1 style={{ color: 'white', fontSize: 24, fontWeight: 700, margin: 0 }}>Customs Compliance Agent</h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 14, marginTop: 6 }}>
            {mode === 'login' ? 'Sign in to your account' : 'Create a new account'}
          </p>
        </div>

        <div style={{ display: 'flex', background: 'rgba(255,255,255,0.08)', borderRadius: 10, marginBottom: 24, padding: 4 }}>
          {['login', 'register'].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              flex: 1, padding: '8px 0', border: 'none', borderRadius: 8, cursor: 'pointer',
              background: mode === m ? 'rgba(255,255,255,0.18)' : 'transparent',
              color: mode === m ? 'white' : 'rgba(255,255,255,0.5)',
              fontWeight: mode === m ? 600 : 400, fontSize: 14, transition: 'all 0.2s'
            }}>
              {m === 'login' ? 'Sign In' : 'Register'}
            </button>
          ))}
        </div>

        {/* Google Login Button — only on Sign In */}
        {mode === 'login' && GOOGLE_CLIENT_ID && (
          <>
            <GoogleLoginButton onSuccess={onAuth} onError={setError} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.12)' }} />
              <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 12 }}>or</span>
              <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.12)' }} />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 6 }}>Email</label>
            <input id="auth-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required
              placeholder="you@example.com"
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)',
                color: 'white', fontSize: 15, outline: 'none', boxSizing: 'border-box'
              }} />
          </div>
          <div style={{ marginBottom: 24 }}>
            <label style={{ display: 'block', color: 'rgba(255,255,255,0.7)', fontSize: 13, marginBottom: 6 }}>Password</label>
            <input id="auth-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required
              placeholder={mode === 'register' ? 'Min. 6 characters' : '••••••••'}
              style={{
                width: '100%', padding: '12px 14px', borderRadius: 10,
                border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.08)',
                color: 'white', fontSize: 15, outline: 'none', boxSizing: 'border-box'
              }} />
          </div>

          {error && (
            <div style={{ background: 'rgba(252,129,129,0.15)', border: '1px solid rgba(252,129,129,0.4)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#fc8181', fontSize: 14 }}>
              {error}
            </div>
          )}

          <button id="auth-submit" type="submit" disabled={loading} style={{
            width: '100%', padding: '13px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: loading ? 'rgba(255,255,255,0.2)' : 'linear-gradient(135deg, #667eea, #764ba2)',
            color: 'white', fontWeight: 700, fontSize: 16,
            boxShadow: loading ? 'none' : '0 4px 15px rgba(102,126,234,0.4)',
            transition: 'all 0.2s'
          }}>
            {loading ? '⏳ Please wait...' : (mode === 'login' ? 'Sign In' : 'Create Account')}
          </button>
        </form>
      </div>
    </div>
  );
}

// ── History Panel ──────────────────────────────────────────────────────────────
function HistoryPanel({ onSelectScan }) {
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${API}/history`, { headers: authHeader() });
      setScans(res.data.scans || []);
    } catch (e) {
      console.error('History load failed:', e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const statusBadge = (s) => {
    const map = { success: { bg: '#f0fff4', color: '#276749', label: '✅ Done' }, error: { bg: '#fff5f5', color: '#c53030', label: '❌ Error' }, pending: { bg: '#fffaf0', color: '#c05621', label: '⏳ Pending' } };
    const st = map[s] || { bg: '#f8f9fa', color: '#718096', label: s };
    return <span style={{ background: st.bg, color: st.color, padding: '2px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600 }}>{st.label}</span>;
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#718096' }}>⏳ Loading history...</div>;
  if (!scans.length) return (
    <div style={{ padding: 40, textAlign: 'center', color: '#718096' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>📂</div>
      <p>No scans yet. Upload a document to get started.</p>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>📋 Scan History</h2>
        <button onClick={loadHistory} style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #cbd5e0', background: 'white', cursor: 'pointer', fontSize: 13 }}>🔄 Refresh</button>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ background: '#f8f9fa' }}>
              {['Filename', 'Country', 'Status', 'Date', 'Action'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '12px 16px', fontWeight: 600, color: '#4a5568', borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scans.map((scan, idx) => (
              <tr key={scan.id} style={{ background: idx % 2 === 0 ? 'white' : '#fafafa', transition: 'background 0.15s' }}
                onMouseEnter={e => e.currentTarget.style.background = '#ebf8ff'}
                onMouseLeave={e => e.currentTarget.style.background = idx % 2 === 0 ? 'white' : '#fafafa'}>
                <td style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  📄 {scan.filename}
                </td>
                <td style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
                  {scan.country === 'IN' ? '🇮🇳' : scan.country === 'UAE' ? '🇦🇪' : '🇺🇸'} {scan.country}
                </td>
                <td style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>{statusBadge(scan.status)}</td>
                <td style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', color: '#718096', whiteSpace: 'nowrap' }}>
                  {new Date(scan.created_at).toLocaleString()}
                </td>
                <td style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0' }}>
                  <button onClick={() => onSelectScan(scan)} style={{
                    padding: '4px 12px', borderRadius: 6, border: '1px solid #667eea',
                    background: 'white', color: '#667eea', cursor: 'pointer', fontSize: 12, fontWeight: 600
                  }}>View →</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
function AppInner() {
  const [user, setUser] = useState(getUser());
  const [mfaUserId, setMfaUserId] = useState(null);
  const [tab, setTab] = useState('analyze');

  // Analyze states
  const [file, setFile] = useState(null);
  const [country, setCountry] = useState('IN');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [explanation, setExplanation] = useState(null);
  const [explaining, setExplaining] = useState(false);
  const [steps, setSteps] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [polling, setPolling] = useState(false);
  const [sendEmail, setSendEmail] = useState(false);

  // History scan view
  const [histScan, setHistScan] = useState(null);

  // ── Auth ──────────────────────────────────────────────────────────────────────
  const handleAuth = (u) => { setUser(u); setMfaUserId(null); };
  const handleLogout = () => { clearAuth(); setUser(null); setResult(null); setMfaUserId(null); setJobId(null); };
  const handleMFA = (userId) => setMfaUserId(userId);

  const getExplanation = async (fields, country, issues) => {
    setExplaining(true);
    try {
      const res = await axios.post(
        `${API}/explain`,
        { fields, country, issues },
        { headers: { 'Content-Type': 'application/json', ...authHeader() } }
      );
      setExplanation(res.data.explanation);
    } catch (e) {
      console.error(e);
      setExplanation("Could not load explanation.");
    }
    setExplaining(false);
  };

  const handleSubmit = async () => {
    if (!file) return alert('Please select a file');
    setLoading(true);
    setError(null);
    setResult(null);
    setExplanation(null);
    setSteps([]);
    setJobId(null);
    setPolling(false);

    try {
      setSteps(['📄 Reading document...']);
      await new Promise(r => setTimeout(r, 400));

      setSteps(s => [...s, '🤖 Extracting fields with AI...']);
      const formData = new FormData();
      formData.append('file', file);
      formData.append('country', country);
      formData.append('send_email_flag', sendEmail ? 'true' : 'false');

      const res = await axios.post(`${API}/analyze`, formData, {
        headers: { ...authHeader() }
      });

      setSteps(s => [...s, '📋 Classifying HS codes...']);
      await new Promise(r => setTimeout(r, 300));

      setSteps(s => [...s, `🌍 Validating against ${country} customs rules...`]);

      if (res.data.status === 'success') {
        setResult(res.data);
        setSteps(s => [...s, '✅ Analysis complete!']);

        const f = extractFields(res.data);
        if (f) {
          const rules = COUNTRY_RULES[country];
          const val = parseFloat(f?.Value) || 0;
          const issues = [];
          if (val > rules.max_value_usd) issues.push(`Value USD ${val} exceeds ${country} threshold of USD ${rules.max_value_usd}`);
          if (rules.restricted.some(r => String(f?.HSCode || "").startsWith(r))) issues.push(`HS Code ${f.HSCode} is restricted for ${country} imports`);
          getExplanation(f, country, issues);
        }
      } else {
        setError(res.data.error || 'Document processing failed synchronously.');
        setSteps(s => [...s, '❌ Processing failed']);
      }
    } catch (e) {
      setError(e.response?.status === 401
        ? 'Session expired. Please log in again.'
        : 'Analysis failed. Check that the backend is running.');
    }
    setLoading(false);
  };

  const fields = result ? extractFields(result) : null;

  // ── MFA Screen ────────────────────────────────────────────────────────────────
  if (!user && mfaUserId) return <OTPScreen userId={mfaUserId} onSuccess={handleAuth} />;

  // ── Not logged in ─────────────────────────────────────────────────────────────
  if (!user) return <AuthPage onAuth={handleAuth} onMFA={handleMFA} />;

  // ── Main UI ───────────────────────────────────────────────────────────────────
  return (
    <div style={{ fontFamily: 'Inter, sans-serif', minHeight: '100vh', background: '#f7f8fc' }}>
      <style>{`
        @keyframes bounce {
          0%, 100% { transform: translateY(0); opacity: 0.4; }
          50% { transform: translateY(-6px); opacity: 1; }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        input::placeholder { color: rgba(0,0,0,0.3); }
      `}</style>

      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg, #1a1a2e, #16213e)', color: 'white', padding: '20px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>🛃 Customs Compliance Agent</h1>
          <p style={{ margin: '4px 0 0', color: '#a0aec0', fontSize: 13 }}>
            Autonomous document analysis · UiPath + Groq AI · India · UAE · USA
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 600 }}>{user.email}</div>
            <div style={{ color: '#667eea', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 }}>{user.role}</div>
          </div>
          <button id="logout-btn" onClick={handleLogout} style={{
            padding: '8px 16px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.08)', color: 'white', cursor: 'pointer', fontSize: 13
          }}>Sign Out</button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div style={{ background: 'white', borderBottom: '1px solid #e2e8f0', padding: '0 32px', display: 'flex', gap: 4 }}>
        {[{ id: 'analyze', label: '🔍 Analyze' }, { id: 'history', label: '📋 History' }].map(t => (
          <button key={t.id} id={`tab-${t.id}`} onClick={() => { setTab(t.id); setHistScan(null); }} style={{
            padding: '14px 20px', border: 'none', background: 'transparent', cursor: 'pointer',
            fontSize: 14, fontWeight: tab === t.id ? 700 : 400,
            color: tab === t.id ? '#667eea' : '#718096',
            borderBottom: tab === t.id ? '3px solid #667eea' : '3px solid transparent',
            transition: 'all 0.2s'
          }}>{t.label}</button>
        ))}
      </div>

      <div style={{ maxWidth: 960, margin: '0 auto', padding: 32 }}>

        {/* ── History Tab ── */}
        {tab === 'history' && (
          <div style={{ background: 'white', borderRadius: 16, padding: 32, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
            {histScan ? (
              <div>
                <button onClick={() => setHistScan(null)} style={{ marginBottom: 20, padding: '6px 14px', borderRadius: 8, border: '1px solid #cbd5e0', background: 'white', cursor: 'pointer', fontSize: 13 }}>← Back to History</button>
                <h2 style={{ marginTop: 0 }}>📄 {histScan.filename}</h2>
                {histScan.result?.fields && <ComplianceCard fields={histScan.result.fields} country={histScan.country} />}
                {histScan.result?.explanation && (
                  <div style={{ background: 'white', borderRadius: 12, padding: 20, border: '1px solid #e2e8f0', marginBottom: 16, borderLeft: '4px solid #667eea' }}>
                    <h3 style={{ marginTop: 0, color: '#553c9a' }}>🤖 AI Compliance Advisor</h3>
                    <div style={{ fontSize: 14, lineHeight: 1.8, color: '#4a5568', whiteSpace: 'pre-wrap' }}>{histScan.result.explanation}</div>
                  </div>
                )}
                {histScan.result?.fields && (
                  <div style={{ background: 'white', borderRadius: 12, padding: 20, border: '1px solid #e2e8f0' }}>
                    <h3 style={{ marginTop: 0 }}>📋 Extracted Fields</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                      <FieldCard label="Exporter" value={histScan.result.fields?.Exporter} />
                      <FieldCard label="Country of Origin" value={histScan.result.fields?.Origin} />
                      <FieldCard label="Declared Value" value={`${histScan.result.fields?.Value} ${histScan.result.fields?.Currency}`} highlight />
                      <FieldCard label="Currency" value={histScan.result.fields?.Currency} />
                      <FieldCard label="Goods Description" value={histScan.result.fields?.Goods} />
                      <FieldCard label="HS Code" value={histScan.result.fields?.HSCode} highlight />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <HistoryPanel onSelectScan={setHistScan} />
            )}
          </div>
        )}

        {/* ── Analyze Tab ── */}
        {tab === 'analyze' && (
          <div>
            {/* Upload Card */}
            <div style={{ background: 'white', borderRadius: 16, padding: 32, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 24 }}>
              <h2 style={{ marginTop: 0, fontSize: 18 }}>📄 Upload Document</h2>
              <div style={{ border: '2px dashed #cbd5e0', borderRadius: 12, padding: 32, textAlign: 'center', marginBottom: 20 }}>
                <input id="file-input" type="file" accept=".pdf,.png,.jpg" onChange={e => setFile(e.target.files[0])} />
                {file && <p style={{ color: '#38a169', marginTop: 8, marginBottom: 0 }}>✓ {file.name}</p>}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
                <div>
                  <label style={{ fontWeight: 600, marginRight: 8, fontSize: 14 }}>Destination Country:</label>
                  <select id="country-select" value={country} onChange={e => setCountry(e.target.value)}
                    style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #cbd5e0', fontSize: 15 }}>
                    <option value="IN">🇮🇳 India</option>
                    <option value="UAE">🇦🇪 UAE</option>
                    <option value="USA">🇺🇸 USA</option>
                  </select>
                </div>
                <button id="analyze-btn" onClick={handleSubmit} disabled={loading}
                  style={{
                    padding: '10px 28px', background: loading ? '#a0aec0' : '#1a1a2e', color: 'white',
                    border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: loading ? 'not-allowed' : 'pointer'
                  }}>
                  {loading ? '⏳ Analyzing...' : '🔍 Analyze Document'}
                </button>
              </div>

              {/* Email toggle */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontSize: 14, color: '#4a5568' }}>
                <input id="send-email-checkbox" type="checkbox" checked={sendEmail} onChange={e => setSendEmail(e.target.checked)}
                  style={{ width: 16, height: 16, cursor: 'pointer' }} />
                📧 Send results to my email ({user.email})
              </label>

              {/* Processing Steps */}
              {steps.length > 0 && (
                <div style={{ marginTop: 24, background: '#f8f9fa', borderRadius: 12, padding: 20 }}>
                  <h3 style={{ marginTop: 0, fontSize: 15, color: '#4a5568' }}>⚙️ Processing</h3>
                  {steps.map((step, i) => (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0',
                      color: i === steps.length - 1 ? '#1a1a2e' : '#718096',
                      fontWeight: i === steps.length - 1 ? 600 : 400, fontSize: 14
                    }}>
                      {step}
                    </div>
                  ))}
                  {loading && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                      {[0, 1, 2].map(i => (
                        <div key={i} style={{
                          width: 8, height: 8, borderRadius: '50%', background: '#667eea',
                          animation: `bounce 1s infinite ${i * 0.2}s`
                        }} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && (
              <div style={{ background: '#fff5f5', border: '1px solid #fc8181', padding: 16, borderRadius: 8, marginBottom: 16, color: '#c53030' }}>
                {error}
              </div>
            )}

            {/* Results */}
            {fields && (
              <div>
                <ComplianceCard fields={fields} country={country} />

                {(explaining || explanation) && (
                  <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16, borderLeft: '4px solid #667eea' }}>
                    <h3 style={{ marginTop: 0, color: '#553c9a' }}>🤖 AI Compliance Advisor</h3>
                    {explaining
                      ? <p style={{ color: '#718096' }}>⏳ Generating compliance advice...</p>
                      : <div style={{ fontSize: 14, lineHeight: 1.8, color: '#4a5568', whiteSpace: 'pre-wrap' }}>{explanation}</div>
                    }
                  </div>
                )}

                <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
                  <h3 style={{ marginTop: 0 }}>📋 Extracted Fields</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <FieldCard label="Exporter" value={fields?.Exporter} />
                    <FieldCard label="Country of Origin" value={fields?.Origin} />
                    <FieldCard label="Declared Value" value={`${fields?.Value} ${fields?.Currency}`} highlight />
                    <FieldCard label="Currency" value={fields?.Currency} />
                    <FieldCard label="Goods Description" value={fields?.Goods} />
                    <FieldCard label="HS Code" value={fields?.HSCode} highlight />
                  </div>
                </div>

                <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)', marginBottom: 16 }}>
                  <h3 style={{ marginTop: 0 }}>🧠 AI Reasoning Trace</h3>
                  <div style={{ background: '#f8f9fa', borderRadius: 8, padding: 16, fontSize: 14, lineHeight: 1.7, color: '#4a5568' }}>
                    {result?.raw_output && (() => {
                      try {
                        let content = result.raw_output;
                        try {
                          const outer = JSON.parse(content);
                          if (outer?.out_ResultJSON) {
                            const inner = JSON.parse(outer.out_ResultJSON);
                            content = inner?.openai_response?.choices?.[0]?.message?.content || content;
                          }
                        } catch (e) { }
                        content = content.replace(/```json\n[\s\S]*?```/g, '').trim();
                        if (!content) return <p>No reasoning available</p>;
                        return content.split('\n').filter(l => l.trim()).map((line, i) => <p key={i} style={{ margin: '4px 0' }}>{line}</p>);
                      } catch { return <p>No reasoning available</p>; }
                    })()}
                  </div>
                </div>

                <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                  <h3 style={{ marginTop: 0 }}>🔍 Audit Trail</h3>
                  <pre style={{ background: '#f8f9fa', padding: 16, borderRadius: 8, fontSize: 11, overflow: 'auto', maxHeight: 200, margin: 0 }}>
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </div>
              </div>
            )}

            {!fields && result && (
              <div style={{ background: 'white', borderRadius: 16, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.08)' }}>
                <h3>Raw Response</h3>
                <pre style={{ fontSize: 12, overflow: 'auto' }}>{JSON.stringify(result, null, 2)}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Root with GoogleOAuthProvider ──────────────────────────────────────────────
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