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
const incomingRoutes = require('./routes/incoming');
const ticketRoutes = require('./routes/tickets');
const auditRoutes = require('./routes/audit');
const dashboardRoutes = require('./routes/dashboard');

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
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

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Leyble Hub API running on port ${PORT}`);
});
