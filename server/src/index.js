require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const { errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const customerRoutes = require('./routes/customers');
const personnelRoutes = require('./routes/personnel');
const orderRoutes = require('./routes/orders');
const stationRoutes = require('./routes/stations');
const incomingRoutes = require('./routes/incoming');
const ticketRoutes = require('./routes/tickets');
const auditRoutes = require('./routes/audit');
const dashboardRoutes = require('./routes/dashboard');

const app = express();

// Allowed origins. This is an API-only service for the Android APK; there is no
// served web client. The native Capacitor WebView fetches cross-origin to the
// Render API and sends Origin: https://localhost (androidScheme: https), so that
// origin is required. http://localhost:5173 is for local browser dev only.
// Additional dev-only origins (e.g. LAN/Tailscale IPs or alternate ports like 5174)
// can be configured via DEV_CORS_EXTRA_ORIGINS (comma-separated).
const devExtraOrigins = process.env.NODE_ENV !== 'production' && process.env.DEV_CORS_EXTRA_ORIGINS
  ? process.env.DEV_CORS_EXTRA_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'https://localhost',
  'capacitor://localhost',
  'http://100.96.45.91:5173',
  ...devExtraOrigins,
];
app.use(
  cors({
    origin(origin, cb) {
      // No origin = same-origin / non-browser clients (e.g. native fetch); allow.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      // Outside production, also allow any :5173 origin (e.g. a LAN/Tailscale IP)
      // so `npm run dev` can be reached from another device — a tablet doing a
      // live review of the app over the network, for instance — during local dev.
      if (process.env.NODE_ENV !== 'production' && /^https?:\/\/[^/]+:5173$/.test(origin)) {
        return cb(null, true);
      }
      cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

// 10 MB limit to accommodate Base64-encoded ID images on personnel routes
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/v1/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/personnel', personnelRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/stations', stationRoutes);
app.use('/api/v1/incoming', incomingRoutes);
app.use('/api/v1/tickets', ticketRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);

// API-only service — the product ships as an Android APK. No web client is served.
app.use((req, res) => res.status(404).json({ error: 'Not found — Leyble Hub is an Android app.' }));

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Leyble Hub API running on port ${PORT}`);
});
