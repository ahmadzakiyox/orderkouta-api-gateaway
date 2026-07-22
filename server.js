require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const { crypto } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY_SISTEM = process.env.API_KEY || 'supersecretkey123';
const CACHE_FILE_PATH = path.join(__dirname, '.orderkuota_cache.json');

// OrderKuota API Constants
const API_URL = 'https://app.orderkuota.com:443/api/v2';
const HOST = 'app.orderkuota.com';
const USER_AGENT = 'okhttp/4.12.0';
const APP_VERSION_NAME = '25.12.31';
const APP_VERSION_CODE = '2173257';
const APP_REG_ID = 'fmn9oYXrRN6_kjpTGNlT-a%3AAPA91bGM5WvbAvKlFLCx9p3eVPOP_8awY6oP2ChgSch1vY4m3Mi6wnJLmlXbOYytIC2Wat7eum5tilchooYEoOr4wLKKdOgrCz_cq79A5hIpWaWH1fYyznQ&';

// In-Memory Storage & Maps
const qrCodeStorageMap = new Map();
const daftarTransaksiYangSudahDiklaimMap = new Map();
const logAktivitasSistem = [];

// Cleanup stale transactions older than 24 hours
setInterval(() => {
    const waktuBatasSatuHari = Date.now() - (24 * 60 * 60 * 1000);
    for (const [idTransaksi, timestamp] of daftarTransaksiYangSudahDiklaimMap.entries()) {
        if (timestamp < waktuBatasSatuHari) {
            daftarTransaksiYangSudahDiklaimMap.delete(idTransaksi);
        }
    }
}, 60 * 60 * 1000);

function catatLogAktivitas(tipe, pesan, detail = null) {
    const itemLog = {
        timestamp: new Date().toISOString(),
        type: tipe,
        message: pesan,
        detail: detail
    };
    logAktivitasSistem.unshift(itemLog);
    if (logAktivitasSistem.length > 100) logAktivitasSistem.pop();
    
    const awalan = `[${itemLog.timestamp}] [${tipe}]`;
    if (tipe === 'ERROR') console.error(`${awalan} ${pesan}`, detail || '');
    else if (tipe === 'WARNING') console.warn(`${awalan} ${pesan}`);
    else console.log(`${awalan} ${pesan}`);
}

// Stateful Cache File Functions (.orderkuota_cache.json)
function saveCacheToFile(dataObj) {
    try {
        const cacheData = {
            username: dataObj.username || process.env.ORKUT_USERNAME,
            token: dataObj.token || process.env.ORKUT_TOKEN,
            user_id: dataObj.user_id || process.env.ORKUT_USER_ID,
            last_updated: new Date().toISOString()
        };
        fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(cacheData, null, 2), 'utf8');
        catatLogAktivitas('INFO', 'Cache sesi OrderKuota berhasil disimpan ke file .orderkuota_cache.json');
    } catch (err) {
        catatLogAktivitas('ERROR', `Gagal menyimpan file cache: ${err.message}`);
    }
}

function loadCacheFromFile() {
    try {
        if (fs.existsSync(CACHE_FILE_PATH)) {
            const raw = fs.readFileSync(CACHE_FILE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && (parsed.token || parsed.user_id)) {
                return parsed;
            }
        }
    } catch (err) {
        catatLogAktivitas('ERROR', `Gagal membaca file .orderkuota_cache.json: ${err.message}`);
    }
    return null;
}

// Express Security Middlewares
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const limiterPermintaan = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 120,
    message: { success: false, error: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' }
});
app.use(limiterPermintaan);

function autentikasiApiKey(permintaan, respon, lanjut) {
    const apiKeyDikirim = permintaan.headers['x-api-key'] || permintaan.query.api_key;
    if (!apiKeyDikirim || apiKeyDikirim !== API_KEY_SISTEM) {
        catatLogAktivitas('WARNING', `Akses Ditolak: API Key tidak valid dari IP ${permintaan.ip}`);
        return respon.status(401).json({ success: false, error: 'Akses Ditolak: API Key Tidak Valid' });
    }
    lanjut();
}

// EMVCo Dynamic QRIS Generator (CRC16-CCITT)
function crc16ccitt(str) {
    let crc = 0xffff;
    for (let i = 0; i < str.length; i++) {
        crc ^= str.charCodeAt(i) << 8;
        for (let j = 0; j < 8; j++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
            crc &= 0xffff;
        }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parseEmvTags(qris) {
    const tags = [];
    let i = 0;
    while (i + 4 <= qris.length) {
        const id = qris.slice(i, i + 2);
        const len = Number(qris.slice(i + 2, i + 4));
        const value = qris.slice(i + 4, i + 4 + len);
        if (!id || !Number.isFinite(len) || value.length !== len) break;
        tags.push({ id, len, value });
        i += 4 + len;
    }
    return tags;
}

function buildEmvTags(tags) {
    return tags.map((t) => t.id + String(t.value.length).padStart(2, '0') + t.value).join('');
}

function generateDynamicQRIS(qrisStatis, nominal) {
    let raw = String(qrisStatis || '').trim();
    raw = raw.replace(/6304[0-9A-Fa-f]{4}$/, '');
    const tags = parseEmvTags(raw).filter((t) => t.id !== '54' && t.id !== '63');
    const poi = tags.find((t) => t.id === '01');
    if (poi) poi.value = '12';
    const amountStr = Number(nominal).toFixed(0);
    tags.push({ id: '54', len: amountStr.length, value: amountStr });
    const rebuilt = buildEmvTags(tags) + '6304';
    return rebuilt + crc16ccitt(rebuilt);
}

// OrderKuota API Helpers
async function getOrkutProfile(username, token) {
    try {
        const payload = {
            'auth_token': token,
            'auth_username': username,
            'app_version_name': APP_VERSION_NAME,
            'app_version_code': APP_VERSION_CODE,
            'app_reg_id': APP_REG_ID
        };

        const response = await axios.post(`${API_URL}/user`, qs.stringify(payload), {
            headers: {
                'Host': HOST,
                'User-Agent': USER_AGENT,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': '*/*',
                'Connection': 'keep-alive'
            },
            timeout: 15000
        });

        const data = response.data;
        if (data && data.success && data.data) {
            const userId = data.data.id || data.data.user_id;
            if (userId) return userId.toString();
        }
        return null;
    } catch (err) {
        catatLogAktivitas('ERROR', `Gagal fetch profile OrderKuota: ${err.message}`);
        return null;
    }
}

async function fetchMutasiOrkut(username, token, userId) {
    const payload = {
        'auth_token': token,
        'auth_username': username,
        'requests[qris_history][page]': '1',
        'requests[qris_history][keterangan]': '',
        'requests[qris_history][jumlah]': '',
        'requests[qris_history][user_id]': userId,
        'requests[0]': 'account',
        'app_version_name': APP_VERSION_NAME,
        'app_version_code': APP_VERSION_CODE,
        'app_reg_id': APP_REG_ID
    };

    const response = await axios.post(`${API_URL}/qris/mutasi/${userId}`, qs.stringify(payload), {
        headers: {
            'Host': HOST,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        },
        timeout: 15000
    });

    const data = response.data;
    if (data && data.qris_history) {
        if (Array.isArray(data.qris_history.results)) return data.qris_history.results;
        if (Array.isArray(data.qris_history.data)) return data.qris_history.data;
    } else if (data && data.data && Array.isArray(data.data)) {
        return data.data;
    }
    return [];
}

// API Routes
app.get('/', (permintaan, respon) => {
    respon.json({
        name: 'OrderKuota API Gateway',
        status: 'Online',
        architecture: 'Stateful (.orderkuota_cache.json)',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (permintaan, respon) => {
    respon.json({ success: true, message: 'Layanan API OrderKuota Berfungsi Normal', timestamp: new Date() });
});
app.get('/api/health', (permintaan, respon) => {
    respon.json({ success: true, message: 'Layanan API OrderKuota Berfungsi Normal', timestamp: new Date() });
});

app.post('/create-qris', autentikasiApiKey, async (permintaan, respon) => {
    try {
        const { amount } = permintaan.body;
        if (!amount || isNaN(amount) || parseInt(amount, 10) <= 0) {
            return respon.status(400).json({ success: false, message: 'Nominal (amount) wajib angka positif' });
        }

        const qrisStatis = process.env.ORDERKUOTA_BASE_QR_STRING;
        if (!qrisStatis) {
            return respon.status(500).json({ success: false, message: 'ORDERKUOTA_BASE_QR_STRING belum diatur di .env' });
        }

        const qrisDinamisString = generateDynamicQRIS(qrisStatis, amount);
        const qrId = Math.random().toString(36).substring(2, 10);
        const qrBuffer = await QRCode.toBuffer(qrisDinamisString, { type: 'png', margin: 2, scale: 8 });

        qrCodeStorageMap.set(qrId, {
            buffer: qrBuffer,
            createdAt: Date.now(),
            expiresAt: Date.now() + (5 * 60 * 1000)
        });

        const host = permintaan.get('host');
        const protocol = permintaan.protocol;
        const qrisImageUrl = `${protocol}://${host}/qr/${qrId}`;

        catatLogAktivitas('SUCCESS', `QRIS Dinamis Rp ${amount} Berhasil Dibuat. ID: ${qrId}`);

        respon.json({
            success: true,
            message: 'QRIS Dinamis Berhasil Dibuat (Berlaku 5 Menit)',
            data: {
                qr_id: qrId,
                qris_url: qrisImageUrl,
                qris_string: qrisDinamisString,
                amount: parseInt(amount, 10),
                expires_in: '5 menit'
            }
        });
    } catch (err) {
        catatLogAktivitas('ERROR', `Gagal membuat QRIS: ${err.message}`);
        respon.status(500).json({ success: false, message: 'Gagal Membuat QRIS Dinamis', error: err.message });
    }
});

app.get('/qr/:id', (permintaan, respon) => {
    const qrData = qrCodeStorageMap.get(permintaan.params.id);
    if (!qrData) return respon.status(404).send('QR Code Tidak Ditemukan');
    if (Date.now() > qrData.expiresAt) {
        qrCodeStorageMap.delete(permintaan.params.id);
        return respon.status(410).send('QR Code Telah Kedaluwarsa (Batas 5 Menit)');
    }
    respon.setHeader('Content-Type', 'image/png');
    respon.setHeader('Cache-Control', 'no-store, must-revalidate');
    respon.send(qrData.buffer);
});

app.get('/transactions', autentikasiApiKey, async (permintaan, respon) => {
    const cached = loadCacheFromFile();
    const username = process.env.ORKUT_USERNAME || cached?.username;
    const token = process.env.ORKUT_TOKEN || cached?.token;
    let userId = process.env.ORKUT_USER_ID || cached?.user_id;

    if (!username || !token) {
        return respon.status(400).json({ success: false, error: 'ORKUT_USERNAME dan ORKUT_TOKEN Wajib Diatur di .env' });
    }

    try {
        if (!userId) {
            catatLogAktivitas('INFO', 'ORKUT_USER_ID belum ada di cache/.env. Mengambil User ID dari API OrderKuota...');
            userId = await getOrkutProfile(username, token);
            if (userId) {
                saveCacheToFile({ username, token, user_id: userId });
            }
        }

        if (!userId) {
            return respon.status(400).json({ success: false, error: 'Gagal mengambil OrderKuota User ID' });
        }

        const mutasiList = await fetchMutasiOrkut(username, token, userId);
        respon.json({
            success: true,
            data: {
                total: mutasiList.length,
                transactions: mutasiList
            }
        });
    } catch (err) {
        catatLogAktivitas('ERROR', `Gagal mengambil mutasi OrderKuota: ${err.message}`);
        respon.status(500).json({ success: false, error: 'Gagal mengambil mutasi OrderKuota', detail: err.message });
    }
});

app.post('/check-payment', autentikasiApiKey, async (permintaan, respon) => {
    const { amount, startTime } = permintaan.body;
    if (!amount || isNaN(amount)) {
        return respon.status(400).json({ success: false, message: 'Nominal (amount) Wajib Disediakan' });
    }

    const cached = loadCacheFromFile();
    const username = process.env.ORKUT_USERNAME || cached?.username;
    const token = process.env.ORKUT_TOKEN || cached?.token;
    let userId = process.env.ORKUT_USER_ID || cached?.user_id;

    if (!username || !token) {
        return respon.status(400).json({ success: false, message: 'ORKUT_USERNAME dan ORKUT_TOKEN Wajib Diatur di .env' });
    }

    try {
        if (!userId) {
            userId = await getOrkutProfile(username, token);
            if (userId) saveCacheToFile({ username, token, user_id: userId });
        }

        if (!userId) return respon.status(400).json({ success: false, message: 'Gagal mengambil OrderKuota User ID' });

        const mutasiList = await fetchMutasiOrkut(username, token, userId);
        const nominalTargetAngka = parseInt(amount, 10);
        const timestampFilterMulaiMs = startTime ? new Date(startTime).getTime() : 0;

        let transaksiCocok = null;

        for (const item of mutasiList) {
            const nominalTransaksi = parseInt(item.kredit || item.jumlah || item.amount || item.gross_amount || 0, 10);
            const timestampTransaksiMs = new Date(item.tanggal || item.created_at || item.waktu || Date.now()).getTime();
            const idTransaksi = item.id || item.transaction_id || item.invoice || `${nominalTransaksi}_${timestampTransaksiMs}`;

            if (nominalTransaksi === nominalTargetAngka && timestampTransaksiMs >= timestampFilterMulaiMs) {
                if (!daftarTransaksiYangSudahDiklaimMap.has(idTransaksi)) {
                    daftarTransaksiYangSudahDiklaimMap.set(idTransaksi, Date.now());
                    transaksiCocok = {
                        transaction_id: idTransaksi,
                        amount: nominalTransaksi,
                        payer: item.keterangan || item.payer || 'QRIS OrderKuota',
                        transaction_time: item.tanggal || new Date().toISOString()
                    };
                    break;
                }
            }
        }

        if (transaksiCocok) {
            catatLogAktivitas('SUCCESS', `Pembayaran OrderKuota Lunas: Rp ${nominalTargetAngka}`, transaksiCocok);
            return respon.json({ success: true, paid: true, transaction: transaksiCocok });
        } else {
            return respon.json({ success: true, paid: false, message: 'Pembayaran belum ditemukan atau sudah diklaim' });
        }
    } catch (err) {
        catatLogAktivitas('ERROR', `Gagal cek pembayaran OrderKuota: ${err.message}`);
        respon.status(500).json({ success: false, paid: false, message: 'Gagal memproses pengecekan mutasi', error: err.message });
    }
});

app.get('/token-status', autentikasiApiKey, async (permintaan, respon) => {
    const cached = loadCacheFromFile();
    const username = process.env.ORKUT_USERNAME || cached?.username;
    const token = process.env.ORKUT_TOKEN || cached?.token;
    const userId = process.env.ORKUT_USER_ID || cached?.user_id;

    if (!username || !token) {
        return respon.json({ success: false, data: { status: 'invalid', message: 'Kredensial ORKUT_USERNAME / ORKUT_TOKEN belum diatur' } });
    }

    try {
        const profileUserId = userId || await getOrkutProfile(username, token);
        if (profileUserId) {
            return respon.json({
                success: true,
                data: {
                    status: 'valid',
                    user_id: profileUserId,
                    username: username,
                    message: 'Token dan Sesi OrderKuota Aktif dan Berfungsi'
                }
            });
        } else {
            return respon.json({ success: false, data: { status: 'invalid', message: 'Gagal Verifikasi Token ke Server OrderKuota' } });
        }
    } catch (err) {
        respon.json({ success: false, data: { status: 'invalid', message: err.message } });
    }
});

app.get('/api/logs', autentikasiApiKey, (permintaan, respon) => {
    respon.json({ success: true, total: logAktivitasSistem.length, logs: logAktivitasSistem });
});

app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint Tidak Ditemukan' });
});

app.listen(PORT, () => {
    catatLogAktivitas('INFO', `🚀 Server OrderKuota Gateway Berjalan di Port ${PORT}`);
    catatLogAktivitas('INFO', `🔒 Proteksi API Key Aktif`);
});
