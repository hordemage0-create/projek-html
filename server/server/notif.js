const WAHA_URL = process.env.WAHA_URL || 'http://localhost:3000';
const WAHA_API_KEY = process.env.WAHA_API_KEY;
const WAHA_SESSION = process.env.WAHA_SESSION || 'default';

function formatPhone(phone) {
  let clean = String(phone).replace(/\D/g, '');
  if (clean.startsWith('0')) clean = '62' + clean.slice(1);
  else if (clean.startsWith('8')) clean = '62' + clean;
  return clean + '@c.us';
}

async function kirimPesan(phone, text) {
  if (!WAHA_API_KEY) {
    console.warn('⚠️ WAHA_API_KEY belum diset');
    return { skipped: true };
  }
  try {
    const res = await fetch(`${WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': WAHA_API_KEY },
      body: JSON.stringify({ session: WAHA_SESSION, chatId: formatPhone(phone), text }),
    });
    if (!res.ok) throw new Error(`WAHA error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    console.log(`📱 WA terkirim ke ${phone}: ${data.id || 'ok'}`);
    return data;
  } catch (err) {
    console.error(`❌ Gagal kirim WA ke ${phone}:`, err.message);
    return { error: err.message };
  }
}

async function notifWelcome(user) {
  const text =
    `🎉 *SELAMAT DATANG!*\n\n` +
    `Halo *${user.nama}*,\n\n` +
    `Akun kamu di *Toko PutzzPedia* berhasil dibuat! 🛒\n\n` +
    `📧 Email: ${user.email}\n` +
    `💰 Saldo: Rp${(user.saldo || 0).toLocaleString('id-ID')}\n\n` +
    `Yuk mulai top-up kebutuhan digital kamu:\n` +
    `🔗 https://tokoputzzpedia.com\n\n` +
    `Ada pertanyaan? Balas pesan ini ya! 😊`;
  return kirimPesan(user.whatsapp, text);
}

async function notifDepositBerhasil(user, deposit) {
  const text =
    `✅ *DEPOSIT BERHASIL*\n\n` +
    `Halo *${user.nama}*,\n\n` +
    `Deposit kamu sudah masuk! 🎉\n\n` +
    `💰 Nominal: *Rp${deposit.amount.toLocaleString('id-ID')}*\n` +
    `🆔 ID: ${deposit.id}\n` +
    `💳 Metode: ${deposit.payment_type || 'Midtrans'}\n` +
    `📅 Tanggal: ${new Date().toLocaleString('id-ID')}\n\n` +
    `Saldo kamu sekarang: *Rp${user.saldo.toLocaleString('id-ID')}*\n\n` +
    `Terima kasih sudah top-up di Toko PutzzPedia! 🛒`;
  return kirimPesan(user.whatsapp, text);
}

async function notifOrderBerhasil(user, order) {
  const text =
    `🛒 *ORDER BERHASIL*\n\n` +
    `Halo *${user.nama}*,\n\n` +
    `Order kamu sedang diproses! ⚡\n\n` +
    `📦 Produk: *${order.produk_nama}*\n` +
    `🎯 Target: \`${order.target}\`\n` +
    `💰 Harga: *Rp${order.amount.toLocaleString('id-ID')}*\n` +
    `🆔 Order ID: ${order.id}\n\n` +
    `Saldo setelah order: *Rp${order.saldo_after.toLocaleString('id-ID')}*\n\n` +
    `Terima kasih sudah order di Toko PutzzPedia! 🎉`;
  return kirimPesan(user.whatsapp, text);
}

async function notifSaldoKurang(user, produk, kurang) {
  const text =
    `⚠️ *SALDO TIDAK CUKUP*\n\n` +
    `Halo *${user.nama}*,\n\n` +
    `Kamu mencoba order *${produk.nama}* tapi saldo kamu kurang.\n\n` +
    `💰 Harga: Rp${produk.harga.toLocaleString('id-ID')}\n` +
    `💵 Saldo: Rp${user.saldo.toLocaleString('id-ID')}\n` +
    `❌ Kurang: *Rp${kurang.toLocaleString('id-ID')}*\n\n` +
    `Top-up saldo dulu di:\n` +
    `https://tokoputzzpedia.com/deposit.html\n\n` +
    `Terima kasih! 🙏`;
  return kirimPesan(user.whatsapp, text);
}

module.exports = { kirimPesan, notifWelcome, notifDepositBerhasil, notifOrderBerhasil, notifSaldoKurang };
