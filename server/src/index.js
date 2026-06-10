require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const { errorHandler } = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const customerRoutes = require('./routes/customers');
const personnelRoutes = require('./routes/personnel');
const orderRoutes = require('./routes/orders');
const incomingRoutes = require('./routes/incoming');
const ticketRoutes = require('./routes/tickets');
const auditRoutes = require('./routes/audit');
const dashboardRoutes = require('./routes/dashboard');

const app = express();

// Allowed browser origins. Local dev uses the Vite server; the native Android
// app (Capacitor) serves from https://localhost. CLIENT_ORIGIN may add more
// (comma-separated) in production.
const allowedOrigins = [
  'http://localhost:5173',
  'https://localhost',
  'capacitor://localhost',
  ...(process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map((o) => o.trim()) : []),
];
app.use(
  cors({
    origin(origin, cb) {
      // No origin = same-origin / non-browser clients (e.g. native fetch); allow.
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);

// 10 MB limit to accommodate Base64-encoded ID images on personnel routes
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/personnel', personnelRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/incoming', incomingRoutes);
app.use('/api/v1/tickets', ticketRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/dashboard', dashboardRoutes);

// Serve the built React app (client/dist) at the same origin as the API,
// so the SameSite=Strict login cookie works for browser/PWA clients.
const clientDist = path.join(__dirname, '../../client/dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Leyble Hub API running on port ${PORT}`);
});
