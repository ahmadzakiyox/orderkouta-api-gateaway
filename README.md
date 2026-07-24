# OrderKuota Partner API Gateway

> **Autonomous & Stateful QRIS Payment Gateway** — Sistem mandiri berbasis Node.js untuk membuat QRIS Dinamis, mendeteksi pembayaran masuk, dan mencocokkan transaksi secara otomatis menggunakan data dari platform OrderKuota.

---

## 📌 Gambaran Singkat

Sistem ini **bukan** server OrderKuota resmi. Ini adalah **gateway penghubung** yang:

1. **Login** ke akun OrderKuota Anda via CLI.
2. **Membuat QRIS Dinamis** dengan nominal tertentu melalui REST API.
3. **Memantau saldo QRIS** secara otomatis dan mendeteksi pembayaran masuk.
4. **Mencatat semua transaksi** ke database SQLite lokal (`orderkuota_gateway.db`).

---

## 🏗️ Arsitektur Sistem

```
┌─────────────────────────────────────────────────────────────┐
│                 OrderKuota Gateway System                    │
│                                                             │
│  ┌──────────┐           ┌──────────────────────────┐       │
│  │ login.js │           │       server.js           │       │
│  │ (CLI     │           │  (REST API Gateway)       │       │
│  │  Login)  │           │                           │       │
│  └────┬─────┘           └────────────┬──────────────┘       │
│       │                              │                      │
│       ▼                              ▼                      │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                     core.js                          │   │
│  │       (Komunikasi langsung ke API OrderKuota)        │   │
│  │  • Login & OTP  • Buat QRIS  • Cek Saldo & Mutasi   │   │
│  └────────────────────────┬─────────────────────────────┘   │
│                           │                                  │
│       ┌───────────────────┼───────────────────┐             │
│       ▼                   ▼                   ▼             │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────┐    │
│  │ database │     │ sessionMgr   │     │ OrderKuota   │    │
│  │  .js     │     │ .js          │     │ API          │    │
│  │ (SQLite) │     │ (JSON File)  │     │ (External)   │    │
│  └──────────┘     └──────────────┘     └──────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 📂 Struktur File

| File | Fungsi |
|---|---|
| `server.js` | REST API Gateway — endpoint buat QRIS, cek status, riwayat transaksi |
| `login.js` | CLI Login interaktif — login OrderKuota langsung dari terminal |
| `core.js` | Inti komunikasi ke API OrderKuota (login, OTP, QRIS, mutasi) |
| `database.js` | Modul SQLite — semua operasi CRUD ke `orderkuota_gateway.db` |
| `sessionManager.js` | Backup sesi ke file JSON (`.SESI_ORKUT_JANGAN_HAPUS.json`) |
| `.env` | Konfigurasi (Port, API Key, kredensial OrderKuota) |

---

## 💾 Database (SQLite)

Semua data disimpan di file **`orderkuota_gateway.db`** (otomatis dibuat saat pertama kali jalan). Tabel:

| Tabel | Isi |
|---|---|
| `accounts` | Akun OrderKuota (username, token, merchant_code, api_hash, last_qris_balance) |
| `pending_payments` | QRIS yang sudah dibuat tapi belum dibayar (ref_id, amount, status: PENDING/CLAIMED) |
| `transactions` | Transaksi yang sudah terverifikasi masuk (ref_id, amount, signature, tanggal) |

Setiap perubahan di SQLite juga di-sync ke file JSON (`.SESI_ORKUT_JANGAN_HAPUS.json`) sebagai backup redundan.

---

## ⚙️ Cara Kerja Deteksi Pembayaran

Sistem **tidak menerima webhook** dari OrderKuota. Deteksi pembayaran dilakukan dengan **polling cerdas (Smart On-Demand Polling)**:

### 1. Buat QRIS → Simpan ke Pending

```
Client request → POST /create_payment → QRIS dibuat → Disimpan ke tabel pending_payments (status: PENDING)
```

### 2. Smart Watcher Aktif

Saat QRIS dibuat, **Smart Watcher** otomatis menyala:
- Polling setiap **15 detik** selama **5 menit**.
- Setiap polling: panggil API OrderKuota → bandingkan saldo QRIS sekarang vs saldo terakhir di DB.
- Jika **saldo naik** → terdeteksi ada pembayaran masuk.

### 3. Pencocokan Transaksi (Claim)

Saat pembayaran terdeteksi:
1. Cari di `pending_payments` yang **nominalnya cocok** dan statusnya `PENDING`.
2. Jika ketemu → update status jadi `CLAIMED` → simpan ke tabel `transactions`.
3. Ref ID dari pending payment menjadi Ref ID transaksi (bisa dilacak).

### 4. Mode Hemat (Idle)

Jika **tidak ada QRIS pending** atau sudah lewat 5 menit → Watcher otomatis mati. **0 request ke API** saat tidak ada transaksi.

```
Alur: IDLE (0 req) → QRIS dibuat → Polling 15s (5 menit) → Semua lunas → IDLE lagi
```

### 5. Balance Delta Fallback

Jika API OrderKuota tidak memberikan detail riwayat teks (misal versi app tidak cocok), sistem otomatis membandingkan `last_qris_balance` di database dengan saldo terbaru dari API. Selisih kenaikan dianggap sebagai pembayaran masuk.

---

## 🚀 Setup & Instalasi

### Prasyarat

- **Node.js** v18+
- **npm** v8+

### 1. Clone & Install

```bash
git clone https://github.com/username/orderkuota-gateway.git
cd orderkuota-gateway
npm install
```

### 2. Konfigurasi `.env`

```bash
cp .env.example .env
```

Edit file `.env`:

```env
# Port server API Gateway
PORT=3001

# API Key untuk autentikasi endpoint tertentu (ganti dengan key rahasia Anda)
API_KEY=supersecretkey123

# Base URL domain publik untuk link gambar QR (opsional)
BASE_URL=https://domain-anda.com
```

> ** Penjelasan `BASE_URL`:**
> `BASE_URL` digunakan untuk menyusun URL `qr_link` (link gambar QR Code) pada respon `/create_payment`.
> - **Jika diisi** (misal: `https://pay.domainanda.com`): `qr_link` akan menggunakan domain tersebut.
> - **Jika dikosongkan**: Server otomatis mendeteksi host/domain pengakses secara dinamis (`http://localhost:3001` atau domain VPS yang sedang dipanggil).

> **Catatan:** `ORKUT_USERNAME`, `ORKUT_TOKEN`, dan `ORKUT_USER_ID` akan **otomatis terisi** setelah Anda menjalankan perintah `node login.js`.

### 3. Login Akun OrderKuota (CLI)

```bash
node login.js
```

Proses:
1. Masukkan username & password OrderKuota.
2. Terima OTP via SMS/WhatsApp.
3. Masukkan kode OTP.
4. ✅ Token, User ID, Merchant Code, dan API Hash otomatis tersimpan ke database & `.env`.

### 4. Jalankan Server

```bash
npm start
# atau
node server.js
```

### Setup Otomatis (Linux/Mac)

```bash
chmod +x setup.sh
./setup.sh
```

Script `setup.sh` otomatis menjalankan:
1. ✅ Cek & validasi Node.js + npm
2. 📦 Install dependensi (`npm install`)
3. ⚙️ Buat file `.env` dari template
4. 🔐 Login interaktif OrderKuota (`node login.js`)
5. 🚀 Pilih mode: Jalankan langsung / PM2 (production) / Skip

---

## 🐳 Deploy dengan Docker

### Build & Run

```bash
docker build -t orderkuota-gateway .
docker run -d \
  --name orderkuota-gateway \
  -p 3001:3001 \
  -v $(pwd)/.env:/app/.env \
  -v $(pwd)/orderkuota_gateway.db:/app/orderkuota_gateway.db \
  -v $(pwd)/.SESI_ORKUT_JANGAN_HAPUS.json:/app/.SESI_ORKUT_JANGAN_HAPUS.json \
  orderkuota-gateway
```

### Atau dengan Docker Compose

```bash
docker-compose up -d
```

> **Penting:** Login (`node login.js`) harus dilakukan **sebelum** build Docker, karena proses login bersifat interaktif (butuh input OTP).

---

## 🖥️ Deploy di VPS (Ubuntu/Debian)

```bash
# 1. Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Clone repo
git clone https://github.com/username/orderkuota-gateway.git
cd orderkuota-gateway
npm install

# 3. Login
node login.js

# 4. Jalankan dengan PM2 (agar tetap hidup)
sudo npm install -g pm2
pm2 start server.js --name orderkuota-gateway
pm2 save
pm2 startup
```

---

## 🌐 Deploy di cPanel (Shared Hosting)

> cPanel harus support **Node.js Selector** (CloudLinux).

1. Upload semua file project ke folder (misal `~/orderkuota-gateway`).
2. Buka **cPanel → Setup Node.js App**.
3. Buat aplikasi baru:
   - Node.js version: `18`
   - Application root: `orderkuota-gateway`
   - Application startup file: `server.js`
4. Klik **Run NPM Install**.
5. Login dulu via SSH: `cd ~/orderkuota-gateway && node login.js`
6. Klik **Start App**.

---

## 🔌 REST API Endpoints

Semua endpoint tersedia setelah server berjalan di `http://localhost:3001`.

---

### 1. Buat Pembayaran QRIS

```
GET /create_payment?merchant={MERCHANT_CODE}&hash={API_HASH}&amount={NOMINAL}
```

| Parameter | Wajib | Keterangan |
|---|---|---|
| `merchant` | Ya* | Merchant Code dari akun |
| `hash` | Ya* | API Hash dari akun |
| `amount` | Ya | Nominal pembayaran (Rupiah) |
| `note` | Tidak | Catatan |
| `trx_id` / `order_id` / `ref` | Tidak | Custom TRX-ID unik (jika tidak diisi, auto-generate) |

> *Jika `merchant` & `hash` tidak dikirim, sistem fallback ke kredensial `.env`.

**Contoh Request:**
```
GET /create_payment?merchant=M1A2B3C4D&hash=abc123...&amount=50000&trx_id=ORDER-001
```

**Response Sukses:**
```json
{
  "success": true,
  "results": {
    "qr_link": "https://domain.com/pay/?merchant=M1A2B3C4D&ref=ORDER-001.png",
    "qr_string": "000201010212...",
    "total_bayar": 50000,
    "ref": "ORDER-001",
    "merchant_name": "TOKO ABC"
  }
}
```

---

### 2. Cek Status Pembayaran

```
GET /transactions?merchant={MERCHANT_CODE}&hash={API_HASH}&ref={REF_ID}
```

**Response — Sudah Lunas:**
```json
{
  "success": true,
  "status": "PAID",
  "data": {
    "trx_id": "ORDER-001",
    "ref_id": "ORDER-001",
    "amount": 50000,
    "status": "PAID",
    "description": "Pembayaran QRIS",
    "date": "2026-07-24 22:30:00",
    "signature": "a1b2c3d4..."
  }
}
```

**Response — Masih Pending:**
```json
{
  "success": true,
  "status": "PENDING",
  "data": {
    "trx_id": "ORDER-001",
    "amount": 50000,
    "status": "PENDING",
    "message": "Menunggu Pembayaran"
  }
}
```

**Response — Tidak Ditemukan:**
```json
{
  "success": false,
  "status": "NOT_FOUND",
  "message": "Transaksi TRX-ID / Ref ID 'ORDER-001' tidak ditemukan."
}
```

---

### 3. Render QR Code (Gambar PNG)

```
GET /pay/?merchant={MERCHANT_CODE}&ref={REF_ID}.png
```

Mengembalikan **gambar QR Code PNG** yang bisa langsung di-embed di `<img>` tag. Link ini yang dikirim ke pelanggan untuk di-scan.

---

### 4. Riwayat Transaksi

```
GET /history?merchant={MERCHANT_CODE}&hash={API_HASH}&limit=50&page=1
```

Mengembalikan daftar transaksi dari database + sinkronisasi terbaru dari API OrderKuota.

---

### 5. Health Check

```
GET /health
GET /api/health
```

---

## 🔄 Contoh Alur Integrasi (Website/App Anda)

### Alur Lengkap: Buat QRIS → Tampilkan → Cek Status → Validasi

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Website /  │     │  OrderKuota      │     │  Pembeli        │
│  App Anda   │     │  Gateway         │     │  (Scan QRIS)    │
└──────┬──────┘     └────────┬─────────┘     └────────┬────────┘
       │                     │                         │
       │  1. GET /create_payment                       │
       │     ?amount=50000&trx_id=INV-001              │
       │────────────────────►│                         │
       │                     │                         │
       │  Response: qr_link, ref                       │
       │◄────────────────────│                         │
       │                     │                         │
       │  2. Tampilkan QR    │                         │
       │     ke pembeli      │     3. Scan & Bayar     │
       │─────────────────────│────────────────────────►│
       │                     │                         │
       │                     │  (Smart Watcher aktif   │
       │                     │   polling 15s otomatis) │
       │                     │                         │
       │  4. GET /transactions?ref=INV-001             │
       │────────────────────►│                         │
       │                     │                         │
       │  Response:          │                         │
       │  status: "PAID" ✅  │                         │
       │◄────────────────────│                         │
       │                     │                         │
       │  5. Proses pesanan  │                         │
       │     ────────►       │                         │
```

### Contoh Implementasi (JavaScript)

```javascript
// 1. Buat QRIS
const createRes = await fetch(
  'https://gateway-anda.com/create_payment?merchant=M1A2B3C4D&hash=abc123&amount=50000&trx_id=INV-001'
);
const createData = await createRes.json();

if (createData.success) {
  // Tampilkan QR ke user
  document.getElementById('qr-img').src = createData.results.qr_link;
  document.getElementById('total').textContent = `Rp ${createData.results.total_bayar.toLocaleString()}`;
}

// 2. Polling cek status setiap 5 detik
const checkInterval = setInterval(async () => {
  const statusRes = await fetch(
    'https://gateway-anda.com/transactions?merchant=M1A2B3C4D&hash=abc123&ref=INV-001'
  );
  const statusData = await statusRes.json();

  if (statusData.status === 'PAID') {
    clearInterval(checkInterval);
    alert('Pembayaran berhasil! Pesanan diproses.');
    // Lanjutkan proses order...
  }
}, 5000);
```

### Contoh Implementasi (PHP)

```php
// 1. Buat QRIS
$response = file_get_contents(
  'https://gateway-anda.com/create_payment?merchant=M1A2B3C4D&hash=abc123&amount=50000&trx_id=INV-001'
);
$data = json_decode($response, true);

if ($data['success']) {
    $qrLink = $data['results']['qr_link'];
    $ref = $data['results']['ref'];
    echo "<img src='{$qrLink}' alt='QRIS'>";
}

// 2. Cek status (dipanggil via AJAX atau cron)
$statusRes = file_get_contents(
  "https://gateway-anda.com/transactions?merchant=M1A2B3C4D&hash=abc123&ref=INV-001"
);
$status = json_decode($statusRes, true);

if ($status['status'] === 'PAID') {
    // Pembayaran berhasil, proses order
    echo "LUNAS! Amount: Rp " . number_format($status['data']['amount']);
}
```

### Contoh Implementasi (Python)

```python
import requests, time

# 1. Buat QRIS
res = requests.get('https://gateway-anda.com/create_payment', params={
    'merchant': 'M1A2B3C4D',
    'hash': 'abc123',
    'amount': 50000,
    'trx_id': 'INV-001'
})
data = res.json()
print(f"QR Link: {data['results']['qr_link']}")

# 2. Polling cek status
while True:
    status = requests.get('https://gateway-anda.com/transactions', params={
        'merchant': 'M1A2B3C4D',
        'hash': 'abc123',
        'ref': 'INV-001'
    }).json()

    if status.get('status') == 'PAID':
        print(f"✅ LUNAS! Rp {status['data']['amount']}")
        break

    time.sleep(5)  # Tunggu 5 detik
```

---

## 🔐 Keamanan

| Mekanisme | Detail |
|---|---|
| **Merchant Code & API Hash** | Setiap akun mendapat kode unik acak. Digunakan untuk autentikasi endpoint. |
| **API Key (Header)** | Endpoint tertentu memerlukan header `X-API-Key` atau query `?api_key=`. |
| **Rate Limiter** | Maksimal 120 request/menit per IP. |
| **Helmet.js** | Security headers otomatis (XSS, Clickjacking, dll). |
| **Deduplikasi TRX-ID** | TRX-ID/Order ID yang sudah pernah digunakan tidak bisa dipakai ulang. |
| **SHA-256 Signature** | Setiap transaksi memiliki signature unik untuk validasi keaslian. |
| **Token Auto-Refresh** | Token dicek validitasnya setiap 5 menit, auto-refresh jika kedaluwarsa. |

---

## 📋 Catatan Penting

1. **Login wajib dilakukan sekali** sebelum server bisa digunakan. Token tersimpan permanen di database.
2. **File `.SESI_ORKUT_JANGAN_HAPUS.json`** adalah backup sesi. Jangan dihapus kecuali ingin reset semua data.
3. **File `orderkuota_gateway.db`** adalah database utama. Backup secara berkala.
4. **Smart Watcher** hanya aktif saat ada QRIS pending — tidak ada request sia-sia ke API OrderKuota.

---

## 📄 Lisensi

MIT License — **NUXYS PROJECT**