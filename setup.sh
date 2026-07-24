#!/bin/bash

# =================================================================
# OrderKuota Partner API Gateway - Setup & Login Otomatis
# Docs: README.md
# =================================================================

set -e

echo "================================================================="
echo "🚀 OrderKuota Gateway - Setup Otomatis (Node.js Edition)"
echo "================================================================="
echo ""

# -----------------------------------------------------------------
# 1. Cek Node.js (minimal v18)
# -----------------------------------------------------------------
if ! command -v node &> /dev/null; then
    echo "❌ Node.js belum terinstall!"
    echo ""
    echo "Install Node.js v18+ terlebih dahulu:"
    echo "  Ubuntu/Debian : curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt install -y nodejs"
    echo "  CentOS/RHEL   : curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash - && sudo yum install -y nodejs"
    echo "  macOS          : brew install node@18"
    exit 1
fi

NODE_VERSION=$(node -v)
echo "✅ Node.js : $NODE_VERSION"

if ! command -v npm &> /dev/null; then
    echo "❌ npm belum terinstall! Install npm terlebih dahulu."
    exit 1
fi

NPM_VERSION=$(npm -v)
echo "✅ npm     : $NPM_VERSION"
echo ""

# -----------------------------------------------------------------
# 2. Install dependensi npm
# -----------------------------------------------------------------
if [ -d "node_modules" ]; then
    echo "⚡ node_modules sudah ada, melewati npm install."
else
    echo "📦 Menginstall dependensi npm..."
    npm install --production
    if [ $? -ne 0 ]; then
        echo "❌ Gagal install dependensi npm!"
        exit 1
    fi
    echo "✅ Dependensi npm berhasil diinstall!"
fi
echo ""

# -----------------------------------------------------------------
# 3. Buat file .env dari template (jika belum ada)
# -----------------------------------------------------------------
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "✅ File .env berhasil dibuat dari .env.example"
    else
        cat > .env <<EOF
# Server
PORT=3001
API_KEY=supersecretkey123
BASE_URL=http://localhost:3001

# OrderKuota (otomatis terisi setelah login)
ORKUT_USERNAME=
ORKUT_TOKEN=
ORKUT_USER_ID=
EOF
        echo "✅ File .env berhasil dibuat (template default)"
    fi
else
    echo "ℹ️  File .env sudah ada, tidak ditimpa."
fi
echo ""

# -----------------------------------------------------------------
# 4. Login akun OrderKuota (interaktif)
# -----------------------------------------------------------------
echo "================================================================="
echo "🔐 LOGIN AKUN ORDERKUOTA"
echo "================================================================="
echo ""
echo "Proses ini akan:"
echo "  1. Meminta username & password OrderKuota Anda"
echo "  2. Mengirim kode OTP ke SMS/WhatsApp"
echo "  3. Menyimpan token, Merchant Code, dan API Hash"
echo "     ke database SQLite & file .env secara otomatis"
echo ""

node login.js

echo ""
echo "================================================================="
echo "🎉 SETUP SELESAI!"
echo "================================================================="
echo ""
echo "📋 File penting yang sudah dibuat:"
echo "   • .env                              (konfigurasi)"
echo "   • orderkuota_gateway.db             (database SQLite)"
echo "   • .SESI_ORKUT_JANGAN_HAPUS.json     (backup sesi)"
echo ""

# -----------------------------------------------------------------
# 5. Jalankan server atau setup PM2
# -----------------------------------------------------------------
echo "Pilih cara menjalankan server:"
echo "  1) Jalankan langsung          (node server.js)"
echo "  2) Install & jalankan via PM2 (auto-restart, production)"
echo "  3) Tidak jalankan sekarang"
echo ""
read -r -p "Pilihan (1/2/3, default: 1): " MODE_CHOICE
MODE_CHOICE=${MODE_CHOICE:-1}

case "$MODE_CHOICE" in
    1)
        echo ""
        echo "🚀 Menjalankan Web API Server..."
        echo "================================================================="
        node server.js
        ;;
    2)
        echo ""
        if ! command -v pm2 &> /dev/null; then
            echo "📦 Menginstall PM2 secara global..."
            sudo npm install -g pm2
        fi
        echo "🚀 Menjalankan server via PM2..."
        pm2 start server.js --name orderkuota-gateway
        pm2 save
        echo ""
        echo "✅ Server berjalan via PM2!"
        echo ""
        echo "Perintah PM2 berguna:"
        echo "  pm2 status                     → Cek status"
        echo "  pm2 logs orderkuota-gateway    → Lihat log"
        echo "  pm2 restart orderkuota-gateway → Restart"
        echo "  pm2 stop orderkuota-gateway    → Stop"
        echo ""
        echo "Agar auto-start saat reboot:"
        echo "  pm2 startup"
        ;;
    *)
        echo ""
        echo "ℹ️  Server tidak dijalankan."
        echo ""
        echo "Jalankan nanti dengan:"
        echo "  npm start                                  → Langsung"
        echo "  pm2 start server.js --name orderkuota-gw   → Via PM2"
        ;;
esac
