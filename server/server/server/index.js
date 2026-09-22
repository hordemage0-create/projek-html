require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const midtransClient = require('midtrans-client');
const path = require('path');
const notif = require('./notif');

const app = express();
app.use(cors());

/* =========================================================
   DATABASE
   ========================================================= */
const db = new Database(path.join(__dirname, 'database.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    whatsapp TEXT NOT NULL,
    password TEXT NOT NULL,
    saldo INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS deposits (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    snap_token TEXT,
    payment_type TEXT,
    paid_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    produk_id TEXT NOT NULL,
    produk_nama TEXT NOT NULL,
    target TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    saldo_before INTEGER,
    saldo_after INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    nama TEXT NOT NULL,
    kategori TEXT NOT NULL,
    harga INTEGER NOT NULL,
    deskripsi TEXT,
    aktif INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

/* =========================================================
   SEED PRODUK
   ========================================================= */
const countProducts = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
if (countProducts === 0) {
  const insert = db.prepare(`
    INSERT INTO products (id, nama, kategori, harga, deskripsi) VALUES (?, ?, ?, ?, ?)
  `);
  const seed = [
    ['ml-86', 'Mobile Legends 86 Diamond', 'game', 20000, 'Diamond ML 86'],
    ['ml-172', 'Mobile Legends 172 Diamond', 'game', 40000, 'Diamond ML 172'],
    ['ff-70', 'Free Fire 70 Diamond', 'game', 10000, 'Diamond FF 70'],
    ['ff-140', 'Free Fire 140 Diamond', 'game', 20000, 'Diamond FF 140'],
    ['pubg-60', 'PUBG Mobile 60 UC', 'game', 15000, 'UC PUBG 60'],
    ['pubg-325', 'PUBG Mobile 325 UC', 'game', 75000, 'UC PUBG 325'],
    ['pulsa-10', 'Pulsa Telkomsel 10.000', 'pulsa', 11000, 'Pulsa Tsel 10rb'],
    ['pulsa-25', 'Pulsa Telkomsel 25.000', 'pulsa', 26000, 'Pulsa Tsel 25rb'],
    ['data-3', 'Paket Data 3GB / 30 Hari', 'data', 35000, 'Data 3GB'],
    ['data-10', 'Paket Data 10GB / 30 Hari', 'data', 85000, 'Data 10GB'],
    ['gopay-50', 'GoPay 50.000', 'ewallet', 52000, 'Saldo GoPay 50rb'],
    ['ovo-100', 'OVO 100.000', 'ewallet', 102000, 'Saldo OVO 100rb'],
    ['pln-20', 'Token PLN 20.000', 'pln', 21500, 'Token listrik 20rb'],
    ['pln-50', 'Token PLN 50.000', 'pln', 51500, 'Token listrik 50rb'],
  ];
  const tx = db.transaction(() => { seed.forEach(p => insert.run(...p)); });
  tx();
  console.log(`✅ Seeded ${seed.length} produk`);
}

/* =========================================================
   MIDTRANS
   ========================================================= */
const snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
});

/* =========================================================
   MIDDLEWARE
   ========================================================= */
function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token tidak ditemukan' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token tidak valid' });
  }
}

function authAdmin(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || auth !== 'Bearer ' + process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized admin' });
  }
  next();
}

/* =========================================================
   VALIDASI
   ========================================================= */
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isPhone = v => /^0\d{9,13}$/.test(v);

/* =========================================================
   AUTH: REGISTER
   ========================================================= */
app.post('/api/auth/register', express.json(), async (req, res) => {
  try {
    const { nama, email, whatsapp, password } = req.body;

    if (!nama || nama.trim().length < 3)
      return res.status(400).json({ error: 'Nama minimal 3 karakter' });
    if (!isEmail(email))
      return res.status(400).json({ error: 'Email tidak valid' });
    if (!isPhone(whatsapp))
      return res.status(400).json({ error: 'Format WhatsApp: 08xxxxxxxxxx' });
    if (!password || password.length < 6)
      return res.status(400).json({ error: 'Password minimal 6 karakter' });

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) return res.status(409).json({ error: 'Email sudah terdaftar' });

    const hash = await bcrypt.hash(password, 10);
    const info = db.prepare(`
      INSERT INTO users (nama, email, whatsapp, password) VALUES (?, ?, ?, ?)
    `).run(nama.trim(), email.trim().toLowerCase(), whatsapp.trim(), hash);

    const user = db.prepare(`
      SELECT id, nama, email, whatsapp, saldo, created_at FROM users WHERE id = ?
    `).get(info.lastInsertRowid);

    const token = jwt.sign(
      { id: user.id, email: user.email, nama: user.nama },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );

    res.status(201).json({ message: 'Akun dibuat', token, user });

    // Kirim WA welcome (non-blocking)
    notif.notifWelcome(user).catch(err => console.error('WA welcome error:', err));
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* =========================================================
   AUTH: LOGIN
   ========================================================= */
app.post('/api/auth/login', express.json(), async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!isEmail(email)) return res.status(400).json({ error: 'Email tidak valid' });
    if (!password) return res.status(400).json({ error: 'Password wajib diisi' });

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
    if (!user) return res.status(401).json({ error: 'Email atau password salah' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Email atau password salah' });

    const token = jwt.sign(
      { id: user.id, email: user.email, nama: user.nama },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );

    res.json({
      message: 'Login berhasil',
      token,
      user: {
        id: user.id, nama: user.nama, email: user.email,
        whatsapp: user.whatsapp, saldo: user.saldo, created_at: user.created_at,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* =========================================================
   USER: PROFILE
   ========================================================= */
app.get('/api/user/profile', authMiddleware, (req, res) => {
  const user = db.prepare(`
    SELECT id, nama, email, whatsapp, saldo, created_at FROM users WHERE id = ?
  `).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ user });
});

/* =========================================================
   USER: UPDATE PROFILE
   ========================================================= */
app.put('/api/user/profile', express.json(), authMiddleware, (req, res) => {
  try {
    const { nama, whatsapp } = req.body;
    if (!nama || nama.trim().length < 3)
      return res.status(400).json({ error: 'Nama minimal 3 karakter' });
    if (!isPhone(whatsapp))
      return res.status(400).json({ error: 'Format WhatsApp tidak valid' });

    db.prepare('UPDATE users SET nama = ?, whatsapp = ? WHERE id = ?')
      .run(nama.trim(), whatsapp.trim(), req.user.id);

    const user = db.prepare(`
      SELECT id, nama, email, whatsapp, saldo, created_at FROM users WHERE id = ?
    `).get(req.user.id);

    res.json({ message: 'Profil diperbarui', user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* =========================================================
   USER: GANTI PASSWORD
   ========================================================= */
app.put('/api/user/password', express.json(), authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6)
      return res.status(400).json({ error: 'Password baru minimal 6 karakter' });

    const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
    const match = await bcrypt.compare(oldPassword, user.password);
    if (!match) return res.status(401).json({ error: 'Password lama salah' });

    const hash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, req.user.id);

    res.json({ message: 'Password berhasil diubah' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

/* =========================================================
   DEPOSIT: CREATE SNAP TOKEN
   ========================================================= */
app.post('/api/deposit/create', express.json(), authMiddleware, async (req, res) => {
  try {
    const { amount } = req.body;
    const MIN = 10000, MAX = 10000000;
    if (!amount || isNaN(amount) || amount < MIN || amount > MAX) {
      return res.status(400).json({
        error: `Nominal Rp${MIN.toLocaleString('id-ID')} - Rp${MAX.toLocaleString('id-ID')}`,
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const depositId = 'DEP-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

    const transaction = await snap.createTransaction({
      transaction_details: { order_id: depositId, gross_amount: amount },
      customer_details: {
        first_name: user.nama, email: user.email, phone: user.whatsapp,
      },
      item_details: [{
        id: 'deposit', price: amount, quantity: 1, name: 'Deposit Saldo PutzzPedia',
      }],
    });

    db.prepare(`
      INSERT INTO deposits (id, user_id, amount, status, snap_token)
      VALUES (?, ?, ?, 'pending', ?)
    `).run(depositId, user.id, amount, transaction.token);

    res.json({
      deposit_id: depositId,
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      amount,
    });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ error: 'Gagal membuat deposit' });
  }
});

/* =========================================================
   DEPOSIT: STATUS CHECK
   ========================================================= */
app.get('/api/deposit/:id/status', authMiddleware, (req, res) => {
  const deposit = db.prepare(`
    SELECT id, amount, status, paid_at, created_at
    FROM deposits WHERE id = ? AND user_id = ?
  `).get(req.params.id, req.user.id);
  if (!deposit) return res.status(404).json({ error: 'Deposit tidak ditemukan' });
  res.json({ deposit });
});

/* =========================================================
   DEPOSIT: RIWAYAT USER
   ========================================================= */
app.get('/api/user/deposits', authMiddleware, (req, res) => {
  const deposits = db.prepare(`
    SELECT id, amount, status, paid_at, created_at
    FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ deposits });
});

/* =========================================================
   WEBHOOK MIDTRANS
   ========================================================= */
app.post('/api/midtrans/callback',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    try {
      const notifData = JSON.parse(req.body.toString());
      const {
        order_id, status_code, gross_amount, signature_key,
        transaction_status, fraud_status, payment_type,
      } = notifData;

      // Verifikasi signature SHA512
      const expected = crypto
        .createHash('sha512')
        .update(order_id + status_code + gross_amount + process.env.MIDTRANS_SERVER_KEY)
        .digest('hex');

      if (expected !== signature_key) {
        console.warn('❌ Signature tidak valid:', order_id);
        return res.status(403).json({ message: 'Invalid signature' });
      }

      const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(order_id);
      if (!deposit) return res.status(404).json({ message: 'Not found' });
      if (deposit.status === 'paid') return res.status(200).json({ message: 'Already processed' });

      const isSuccess =
        status_code === '200' && fraud_status === 'accept' &&
        (transaction_status === 'settlement' || transaction_status === 'capture');

      if (!isSuccess) {
        if (['expire', 'cancel', 'deny'].includes(transaction_status)) {
          db.prepare(`UPDATE deposits SET status = ? WHERE id = ?`).run(transaction_status, order_id);
        }
        console.log(`ℹ️ ${order_id} status: ${transaction_status} — dilewati`);
        return res.status(200).json({ message: 'Not success' });
      }

      // Transaksi atomik: update deposit + tambah saldo
      const tx = db.transaction(() => {
        db.prepare(`
          UPDATE deposits SET status = 'paid', paid_at = CURRENT_TIMESTAMP, payment_type = ?
          WHERE id = ?
        `).run(payment_type || 'unknown', order_id);
        db.prepare(`UPDATE users SET saldo = saldo + ? WHERE id = ?`)
          .run(deposit.amount, deposit.user_id);
      });
      tx();

      // Kirim WA notifikasi
      const userAfter = db.prepare('SELECT * FROM users WHERE id = ?').get(deposit.user_id);
      const depositAfter = db.prepare('SELECT * FROM deposits WHERE id = ?').get(order_id);
      notif.notifDepositBerhasil(userAfter, depositAfter)
        .catch(err => console.error('WA deposit error:', err));

      console.log(`✅ Deposit ${order_id} sukses. Saldo +Rp${deposit.amount}`);
      res.status(200).json({ message: 'OK' });
    } catch (err) {
      console.error('Webhook error:', err);
      res.status(500).json({ message: 'Internal error' });
    }
  }
);

/* =========================================================
   PRODUK: LIST (public)
   ========================================================= */
app.get('/api/products', (req, res) => {
  const { kategori } = req.query;
  let q = 'SELECT * FROM products WHERE aktif = 1';
  const params = [];
  if (kategori) { q += ' AND kategori = ?'; params.push(kategori); }
  q += ' ORDER BY kategori, harga';
  const products = db.prepare(q).all(...params);
  res.json({ products });
});

/* =========================================================
   ORDER: CREATE (potong saldo)
   ========================================================= */
app.post('/api/order/create', express.json(), authMiddleware, async (req, res) => {
  try {
    const { produk_id, target } = req.body;
    if (!produk_id || !target)
      return res.status(400).json({ error: 'Produk dan target wajib diisi' });

    const produk = db.prepare('SELECT * FROM products WHERE id = ? AND aktif = 1').get(produk_id);
    if (!produk) return res.status(404).json({ error: 'Produk tidak ditemukan' });

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

    if (user.saldo < produk.harga) {
      const kurang = produk.harga - user.saldo;

      // Kirim WA info saldo kurang
      notif.notifSaldoKurang(user, produk, kurang)
        .catch(err => console.error('WA saldo kurang error:', err));

      return res.status(400).json({
        error: 'Saldo tidak cukup',
        saldo: user.saldo,
        harga: produk.harga,
        kurang,
      });
    }

    const orderId = 'ORD-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const saldoBefore = user.saldo;
    const saldoAfter = user.saldo - produk.harga;

    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET saldo = ? WHERE id = ?').run(saldoAfter, user.id);
      db.prepare(`
        INSERT INTO orders
        (id, user_id, produk_id, produk_nama, target, amount, status, saldo_before, saldo_after)
        VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, ?)
      `).run(orderId, user.id, produk.id, produk.nama, target, produk.harga, saldoBefore, saldoAfter);
    });
    tx();

    // Kirim WA notifikasi order
    const userAfter = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    notif.notifOrderBerhasil(userAfter, {
      id: orderId, produk_nama: produk.nama, target,
      amount: produk.harga, saldo_after: saldoAfter,
    }).catch(err => console.error('WA order error:', err));

    console.log(`✅ Order ${orderId} sukses. ${produk.nama} → ${target}. Saldo: ${saldoBefore} → ${saldoAfter}`);

    res.json({
      message: 'Order berhasil',
      order: {
        id: orderId, produk_nama: produk.nama, target,
        amount: produk.harga, status: 'paid',
        saldo_before: saldoBefore, saldo_after: saldoAfter,
      },
    });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ error: 'Gagal membuat order' });
  }
});

/* =========================================================
   ORDER: RIWAYAT USER
   ========================================================= */
app.get('/api/user/orders', authMiddleware, (req, res) => {
  const orders = db.prepare(`
    SELECT id, produk_nama, target, amount, status, created_at
    FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ orders });
});

/* =========================================================
   ADMIN: STATS
   ========================================================= */
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalOrders = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
  const totalDeposits = db.prepare('SELECT COUNT(*) as c FROM deposits').get().c;
  const totalRevenue = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as s FROM deposits WHERE status = 'paid'
  `).get().s;
  const totalSpent = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as s FROM orders WHERE status = 'paid'
  `).get().s;
  const totalSaldo = db.prepare('SELECT COALESCE(SUM(saldo), 0) as s FROM users').get().s;
  const pendingDeposits = db.prepare(`
    SELECT COUNT(*) as c FROM deposits WHERE status = 'pending'
  `).get().c;

  res.json({
    totalUsers, totalOrders, totalDeposits,
    totalRevenue, totalSpent, totalSaldo, pendingDeposits,
  });
});

/* =========================================================
   ADMIN: LIST USERS
   ========================================================= */
app.get('/api/admin/users', authAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT id, nama, email, whatsapp, saldo, created_at
    FROM users ORDER BY created_at DESC
  `).all();
  res.json({ users });
});

/* =========================================================
   ADMIN: TAMBAH / KURANGI SALDO
   ========================================================= */
app.post('/api/admin/users/:id/saldo', express.json(), authAdmin, (req, res) => {
  const { amount, action } = req.body;
  const userId = parseInt(req.params.id);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Nominal tidak valid' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

  const delta = action === 'subtract' ? -amount : amount;
  const newSaldo = user.saldo + delta;
  if (newSaldo < 0) return res.status(400).json({ error: 'Saldo tidak boleh negatif' });

  db.prepare('UPDATE users SET saldo = ? WHERE id = ?').run(newSaldo, userId);

  console.log(`🔧 Admin ${action}: user ${userId} — ${delta > 0 ? '+' : ''}${delta}`);

  res.json({
    message: 'Saldo diperbarui',
    saldo_before: user.saldo,
    saldo_after: newSaldo,
  });
});

/* =========================================================
   ADMIN: LIST DEPOSITS
   ========================================================= */
app.get('/api/admin/deposits', authAdmin, (req, res) => {
  const deposits = db.prepare(`
    SELECT d.*, u.nama as user_nama, u.email as user_email
    FROM deposits d
    JOIN users u ON u.id = d.user_id
    ORDER BY d.created_at DESC LIMIT 100
  `).all();
  res.json({ deposits });
});

/* =========================================================
   ADMIN: KONFIRMASI DEPOSIT MANUAL
   ========================================================= */
app.post('/api/admin/deposits/:id/confirm', authAdmin, (req, res) => {
  const deposit = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
  if (!deposit) return res.status(404).json({ error: 'Deposit tidak ditemukan' });
  if (deposit.status === 'paid')
    return res.status(400).json({ error: 'Sudah dikonfirmasi' });

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE deposits SET status='paid', paid_at=CURRENT_TIMESTAMP, payment_type='manual'
      WHERE id=?
    `).run(req.params.id);
    db.prepare(`UPDATE users SET saldo = saldo + ? WHERE id = ?`)
      .run(deposit.amount, deposit.user_id);
  });
  tx();

  // Kirim WA
  const userAfter = db.prepare('SELECT * FROM users WHERE id = ?').get(deposit.user_id);
  const depositAfter = db.prepare('SELECT * FROM deposits WHERE id = ?').get(req.params.id);
  notif.notifDepositBerhasil(userAfter, depositAfter)
    .catch(err => console.error('WA deposit error:', err));

  console.log(`🔧 Admin konfirmasi deposit ${req.params.id} — Rp${deposit.amount}`);
  res.json({ message: 'Deposit dikonfirmasi manual' });
});

/* =========================================================
   ADMIN: LIST ORDERS
   ========================================================= */
app.get('/api/admin/orders', authAdmin, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, u.nama as user_nama, u.email as user_email
    FROM orders o
    JOIN users u ON u.id = o.user_id
    ORDER BY o.created_at DESC LIMIT 100
  `).all();
  res.json({ orders });
});

/* =========================================================
   ADMIN: UPDATE STATUS ORDER (refund)
   ========================================================= */
app.post('/api/admin/orders/:id/status', express.json(), authAdmin, (req, res) => {
  const { status } = req.body;
  const valid = ['pending', 'paid', 'failed', 'refunded'];
  if (!valid.includes(status))
    return res.status(400).json({ error: 'Status tidak valid' });

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);

  if (status === 'refunded' && order.status !== 'refunded') {
    db.prepare('UPDATE users SET saldo = saldo + ? WHERE id = ?')
      .run(order.amount, order.user_id);
    console.log(`💸 Refund order ${order.id}: +Rp${order.amount}`);
  }

  res.json({ message: 'Status diperbarui' });
});

/* =========================================================
   START SERVER
   ========================================================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`💳 Midtrans: ${process.env.MIDTRANS_IS_PRODUCTION === 'true' ? 'PRODUCTION' : 'SANDBOX'}`);
  console.log(`📱 WAHA: ${process.env.WAHA_URL}`);
  console.log(`📁 Database: ${path.join(__dirname, 'database.sqlite')}`);
});
