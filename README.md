# 🚀 OrderKuota Partner API Gateway (Stateful Edition)

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D%2020.0.0-blue.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Express Framework](https://img.shields.io/badge/Express-4.19.2-lightgrey.svg?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com)
[![Docker Ready](https://img.shields.io/badge/Docker-Ready-2496ED.svg?style=for-the-badge&logo=docker&logoColor=white)](https://www.docker.com/)
[![Architecture](https://img.shields.io/badge/Architecture-Stateful%20VPS-brightgreen.svg?style=for-the-badge)](#)

API Gateway mandiri (Autonomous & Stateful) berkinerja tinggi untuk otomatisasi verifikasi mutasi transaksi OrderKuota, pencetakan QRIS Dinamis berstandar EMVCo (CRC16-CCITT) 5 Menit, serta pemantauan status transaksi realtime tanpa database berat.

---

> [!IMPORTANT]
> ### ⚠️ Disclaimer: Unofficial API Gateway
> Proyek ini adalah **Unofficial API Gateway** yang dikembangkan oleh **NUXYS PROJECT** dan **TIDAK berafiliasi resmi dengan OrderKuota** dalam kapasitas apapun.
> 
> **Kenapa Aman Digunakan?**
> *   ✅ **Credential Tersimpan Aman**: Token, User ID, & API Key disimpan di server Anda sendiri di file `.env` & `.orderkuota_cache.json` dan **tidak pernah dikirim ke pihak ketiga manapun**.
> *   ✅ **Zero Third-Party**: Semua lalu lintas data berjalan langsung dari server Anda ke endpoint resmi `app.orderkuota.com`.

---

## 🎯 Cara Kerja & Konsep Utama Sistem

> [!WARNING]
> ### 🚨 WAJIB MENGGUNAKAN VPS (Tidak Mendukung Serverless Cloud Gratis)
> Sistem *Autonomous Session Caching* gateway ini **WAJIB di-deploy di VPS (Virtual Private Server) atau Dedicated Server** yang memiliki penyimpanan permanen (*Persistent Storage*) seperti Hostinger, DigitalOcean, AWS EC2, Contabo, dsb.
> 
> **JANGAN menggunakan layanan cloud gratisan/ephemeral seperti Render.com, Vercel, Heroku, atau Railway!**
> Layanan tersebut sering melakukan "Sleep" dan *restart* yang **menghapus semua file lokal** (termasuk `.orderkuota_cache.json`).

### 1. Autonomous Caching (`.orderkuota_cache.json`)
Setiap kali *session token* dan `user_id` berhasil diproses, gateway akan otomatis membuat dan menyimpan token sesi ke dalam file `.orderkuota_cache.json` di direktori VPS Anda. Saat aplikasi Node.js atau PM2 di-restart, gateway tinggal membaca ulang file JSON tersebut tanpa perlu melakukan *login* ulang.

### 2. In-Memory Dynamic QRIS EMVCo Generator (5 Menit Expiry)
Proses pembuatan QRIS Dinamis **0% menembak API OrderKuota**. Server membaca QRIS Statis stiker Anda (`ORDERKUOTA_BASE_QR_STRING`), menyuntikkan Tag Nominal `54`, dan menghitung ulang kode checksum 4-karakter **CRC16-CCITT** secara in-memory dalam hitungan milidetik.
- **Masa Aktif**: Diberi batas waktu 5 menit (`expires_in: "5 menit"`).
- **Public Image Redirect**: Menghasilkan link publik `GET /qr/:id` yang langsung mengarahkan ke gambar QR Code siap tampil di web toko.

---

## 📡 Dokumentasi API Endpoints Lengkap

Seluruh endpoint memerlukan Header `X-API-Key: <YOUR_API_KEY>` atau Query Param `?api_key=<YOUR_API_KEY>`.

### 📋 Tabel Ringkasan Endpoints API

| Method | Endpoint | Fungsi | Autentikasi |
| :--- | :--- | :--- | :--- |
| **GET** | `/` | Status root server | Public |
| **GET** | `/health` / `/api/health` | Health Check server | Public |
| **POST** | `/check-payment` | Verifikasi lunas nominal transaksi | API Key |
| **POST** | `/create-qris` | Generate QRIS Dinamis (5 Menit Expiry) + Redirect | API Key |
| **GET** | `/qr/:id` | Tampilan Gambar QR Code di Browser | Public |
| **GET** | `/transactions` | Ambil daftar mutasi transaksi OrderKuota terbaru | API Key |
| **GET** | `/token-status` | Cek status kesehatan Token OrderKuota | API Key |
| **GET** | `/api/logs` | Monitoring 100 log aktivitas memori | API Key |

---

## 🛠️ PANDUAN SELF-HOSTING & DEPLOYMENT VPS

### Self-Host di Server VPS (Ubuntu / Debian dengan PM2)

#### 1. Install Node.js & PM2
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -y -g pm2
```

#### 2. Setup Proyek
```bash
git clone https://github.com/ahmadzakiyox/orderkuota-gateway.git
cd orderkuota-gateway
npm install
cp .env.example .env
```
*(Sesuaikan isi `.env` Anda dengan `ORKUT_USERNAME`, `ORKUT_TOKEN`, dan `API_KEY`)*.

#### 3. Jalankan via PM2 (Auto-Restart pada Background)
```bash
pm2 start server.js --name orderkuota-gateway
pm2 save
pm2 startup
```

---

## ❓ Troubleshooting & Penanganan Kode Error

| Status Error | Penyebab | Solusi |
| :--- | :--- | :--- |
| `401 Unauthorized: Invalid API Key` | API Key tidak sesuai dengan `API_KEY` di `.env`. | Periksa kembali header `X-API-Key` atau query param `?api_key=`. |
| `Gagal mengambil OrderKuota User ID` | Token OrderKuota kedaluwarsa atau username salah. | Minta token baru via bot Telegram dan perbarui `.env` atau `.orderkuota_cache.json`. |
| `410 Gone (QR expired)` | Link gambar QR Code telah melewati batas waktu 5 menit. | Buat QRIS baru via `POST /create-qris`. |
| `paid: false` | Pembayaran belum masuk atau transaksi sudah pernah diklaim dalam 24 jam. | Lakukan pengecekan ulang setelah pembeli menyelesaikan transfer di HP. |

---

## ☕ Dukungan & Donasi

Proyek ini dikembangkan oleh **NUXYS PROJECT** untuk membantu mempermudah proses pembayaran toko online Anda. Jika proyek **OrderKuota API Gateway** ini bermanfaat, Anda bisa mendukung kami melalui donasi!

**Silakan scan QRIS di bawah ini untuk berdonasi:**

<p align="center">
  <img src="https://github.com/ahmadzakiyox/DB/blob/a3aa4e5fb31e5f6f66b686b8629b233d440b717a/6269360055874426106_121.jpg?raw=true" alt="QRIS Donasi" width="300"/>
</p>

💡 **Punya ide fitur baru, pertanyaan, atau butuh bantuan integrasi?** 
Jangan ragu untuk menghubungi kami di Telegram: **[@ahmadzaki_yo](https://t.me/ahmadzaki_yo)**
