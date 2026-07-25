require('dotenv').config();
require('bytenode');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const QRCode = require('qrcode');
const crypto = require('crypto');

const OrderKuotaCore = require('./core.jsc');
const db = require('./database');
const SessionManager = require('./sessionManager.jsc');

const app = express();
const PORT = process.env.PORT || 3001;
const SYSTEM_API_KEY = process.env.API_KEY || 'supersecretkey123';

process.on('uncaughtException', (err) => {
    const message = err?.message || String(err);
    if (message.includes('ETIMEDOUT') || message.includes('ECONNRESET') || message.includes('EFATAL')) {
        console.warn('⚠️ [SERVER] Error Koneksi Jaringan (Auto-recovered):', message);
    } else {
        console.error('⚠️ [SERVER] Uncaught Exception:', err);
    }
});

process.on('unhandledRejection', (reason) => {
    const message = reason?.message || String(reason);
    if (message.includes('ETIMEDOUT') || message.includes('ECONNRESET') || message.includes('EFATAL')) {
        console.warn('⚠️ [SERVER] Rejection Jaringan (Auto-recovered):', message);
    } else {
        console.error('⚠️ [SERVER] Unhandled Rejection:', reason);
    }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const apiRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    message: { success: false, error: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' }
});
app.use(apiRateLimiter);

const logBuffer = [];
function logEvent(type, message, detail = null) {
    const entry = {
        timestamp: new Date().toISOString(),
        type,
        message,
        detail
    };
    logBuffer.unshift(entry);
    if (logBuffer.length > 100) logBuffer.pop();

    const prefix = `[${entry.timestamp}] [${type}]`;
    if (type === 'ERROR') {
        console.error(`${prefix} ${message}`, detail || '');
    } else {
        console.log(`${prefix} ${message}`);
    }
}

function normalizeAmount(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;

    let text = String(value).trim().replace(/[^0-9.,]/g, '');
    if (!text) return 0;

    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(text)) {
        text = text.replace(/\./g, '').replace(',', '.');
    } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
        text = text.replace(/\./g, '');
    } else if (text.includes(',')) {
        text = text.replace(/\./g, '').replace(',', '.');
    }

    const number = parseFloat(text);
    return isNaN(number) ? 0 : number;
}

async function resolveAccountByRequest(req) {
    const merchantCode = req.query.merchant;
    const apiHash = req.query.hash;

    if (merchantCode && apiHash) {
        return db.getAccountByMerchant(merchantCode, apiHash);
    }

    const apiKey = req.headers['x-api-key'] || req.query.api_key;
    if (apiKey === SYSTEM_API_KEY) {
        const accounts = await db.getAllAccounts();
        if (accounts.length > 0) return accounts[0];
    }

    const envUsername = process.env.ORKUT_USERNAME;
    const envToken = process.env.ORKUT_TOKEN;
    const envUserId = process.env.ORKUT_USER_ID;

    if (envUsername && envToken) {
        return {
            id: 0,
            username: envUsername,
            token: envToken,
            user_id: envUserId,
            merchant_code: 'DEFAULT'
        };
    }

    return null;
}

app.get('/', (req, res) => {
    res.json({
        name: 'OrderKuota Partner API Gateway',
        status: 'Online',
        version: '2.0.0',
        features: ['Multi-Account SQLite', 'Dynamic QRIS', 'Smart On-Demand Watcher'],
        timestamp: new Date().toISOString()
    });
});

app.get(['/health', '/api/health'], (req, res) => {
    res.json({
        success: true,
        message: 'Layanan API Gateway Berfungsi Normal',
        timestamp: new Date().toISOString()
    });
});

app.get('/create_payment', async (req, res) => {
    try {
        const amount = req.query.amount;
        const note = req.query.note || '';
        const parsedAmount = normalizeAmount(amount);

        if (!amount || isNaN(amount) || parsedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Nominal pembayaran tidak valid' });
        }

        const account = await resolveAccountByRequest(req);
        if (!account || !account.username || !account.token) {
            return res.status(401).json({ success: false, message: 'Kredensial Merchant tidak valid atau belum dikonfigurasi' });
        }

        const core = new OrderKuotaCore({
            username: account.username,
            authToken: account.token,
            userId: account.user_id,
            cookies: account.cookies
        });

        const activeSession = await SessionManager.ensureValidToken(account.username, core, db);
        if (activeSession) {
            account.token = activeSession.token;
            account.user_id = activeSession.user_id;
            core.authToken = activeSession.token;
            core.userId = activeSession.user_id;
        }

        const qrisResult = await core.createQris(parsedAmount, note);

        if (!qrisResult.success || !qrisResult.results) {
            return res.status(500).json(qrisResult);
        }

        const qrString = qrisResult.results.qr_string;
        const merchantName = qrisResult.results.merchant_name || 'MERCHANT';
        const cleanMerchantName = merchantName.split(' ')[0].toUpperCase();

        const customTrxId = req.query.trx_id || req.query.order_id || req.query.ref;
        let refId = '';

        if (customTrxId) {
            refId = String(customTrxId).trim();
            const existingPending = await db.getPendingPayment(refId);
            const existingTx = await db.getTransactionByRef(account.id, refId);
            if (existingPending || existingTx) {
                return res.status(400).json({
                    success: false,
                    message: `TRX-ID / Order ID '${refId}' sudah pernah digunakan.`
                });
            }
        } else {
            const uniqueSource = `${parsedAmount}${Date.now()}`;
            const hashSuffix = crypto.createHash('md5').update(uniqueSource).digest('hex').substring(0, 16).toUpperCase();
            refId = `${cleanMerchantName}-${hashSuffix}`;
        }

        if (account.id > 0) {
            await db.savePendingPayment(account.id, refId, qrString, parsedAmount);
            triggerSmartWatcher();
        }

        const protocol = req.protocol;
        const host = req.get('host');
        const domain = process.env.BASE_URL || `${protocol}://${host}`;
        const qrLink = `${domain}/pay/?merchant=${account.merchant_code}&ref=${refId}.png`;

        logEvent('SUCCESS', `QRIS Dinamis Rp ${parsedAmount} Berhasil Dibuat. Ref: ${refId}`);

        return res.json({
            success: true,
            results: {
                qr_link: qrLink,
                qr_string: qrString,
                total_bayar: parsedAmount,
                ref: refId,
                merchant_name: merchantName
            }
        });
    } catch (err) {
        logEvent('ERROR', `Gagal create_payment: ${err.message}`);
        res.status(500).json({ success: false, message: 'Internal Server Error', error: err.message });
    }
});

app.get('/pay/', async (req, res) => {
    try {
        let refId = req.query.ref;
        if (!refId) {
            return res.status(400).send('Parameter ref wajib disediakan');
        }

        if (refId.toLowerCase().endsWith('.png')) {
            refId = refId.slice(0, -4);
        }

        const payment = await db.getPendingPayment(refId);
        if (!payment || !payment.qr_string) {
            return res.status(404).send(`Link pembayaran tidak ditemukan atau sudah kedaluwarsa (Ref: ${refId})`);
        }

        const pngBuffer = await QRCode.toBuffer(payment.qr_string, {
            type: 'png',
            margin: 2,
            scale: 8
        });

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
        return res.send(pngBuffer);
    } catch (err) {
        logEvent('ERROR', `Gagal render QR PNG: ${err.message}`);
        res.status(500).send('Gagal membuat gambar QR Code');
    }
});

app.get('/history', async (req, res) => {
    try {
        const account = await resolveAccountByRequest(req);
        if (!account) {
            return res.status(401).json({ success: false, message: 'Kredensial Merchant tidak valid' });
        }

        const core = new OrderKuotaCore({
            username: account.username,
            authToken: account.token,
            userId: account.user_id,
            cookies: account.cookies
        });

        const limitParam = req.query.limit || 50;
        const pageParam = req.query.page || 1;
        const syncPages = Math.min(parseInt(req.query.sync_pages || 1, 10), 10);

        let liveMutasiRes = null;
        const fetchedMutasiList = [];

        for (let page = 1; page <= syncPages; page++) {
            const pageRes = await core.getTransactionQris(page);
            if (pageRes?.success) {
                liveMutasiRes = pageRes;
                const pageItems = pageRes.qris_history?.results || pageRes.qris_history?.data || [];
                
                for (const item of pageItems) {
                    const itemAmount = normalizeAmount(item.kredit || item.jumlah || item.amount || 0);
                    if (itemAmount <= 0) continue;

                    const baseRef = OrderKuotaCore.generateRefId(item, account.username);
                    const signature = OrderKuotaCore.generateSignature(baseRef);
                    const claimedRef = await db.claimPendingPayment(account.id, itemAmount);
                    const displayRef = claimedRef || baseRef;

                    await db.saveTransaction(
                        account.id,
                        displayRef,
                        signature,
                        itemAmount,
                        normalizeAmount(item.saldo_akhir || 0),
                        item.keterangan || 'QRIS OrderKuota',
                        item.tanggal || new Date().toISOString()
                    );
                    fetchedMutasiList.push(item);
                }
            }
        }

        const cachedTransactions = await db.getRecentTransactions(account.id, limitParam, pageParam);

        return res.json({
            success: true,
            source: 'database',
            page: parseInt(pageParam, 10) || 1,
            limit: limitParam === 'all' ? 'all' : (parseInt(limitParam, 10) || 50),
            merchant_name: liveMutasiRes ? liveMutasiRes.qris_name : 'MERCHANT',
            qris_balance: liveMutasiRes ? liveMutasiRes.qris_balance : 0,
            account: liveMutasiRes ? liveMutasiRes.account : null,
            results: cachedTransactions.length > 0 ? cachedTransactions : fetchedMutasiList
        });
    } catch (err) {
        logEvent('ERROR', `Gagal mengambil riwayat transaksi: ${err.message}`);
        res.status(500).json({ success: false, message: 'Gagal mengambil riwayat transaksi', error: err.message });
    }
});

app.get('/transactions', async (req, res) => {
    try {
        const refId = req.query.ref || req.query.trx_id || req.query.order_id;
        const account = await resolveAccountByRequest(req);

        if (!account) {
            return res.status(401).json({ success: false, message: 'Kredensial Merchant atau API Key tidak valid' });
        }

        if (refId) {
            const dbTx = await db.getTransactionByRef(account.id, refId);
            if (dbTx) {
                return res.json({
                    success: true,
                    status: 'PAID',
                    source: 'database',
                    data: {
                        trx_id: dbTx.ref_id,
                        ref_id: dbTx.ref_id,
                        amount: dbTx.amount,
                        status: 'PAID',
                        description: dbTx.description,
                        date: dbTx.date,
                        signature: dbTx.signature
                    }
                });
            }

            const pending = await db.getPendingPayment(refId);
            if (pending) {
                const statusStr = pending.status === 'CLAIMED' ? 'PAID' : 'PENDING';
                return res.json({
                    success: true,
                    status: statusStr,
                    source: 'database',
                    data: {
                        trx_id: pending.ref_id,
                        ref_id: pending.ref_id,
                        amount: pending.amount,
                        status: statusStr,
                        created_at: pending.created_at,
                        message: statusStr === 'PAID' ? 'Pembayaran Lunas' : 'Menunggu Pembayaran'
                    }
                });
            }

            return res.status(404).json({
                success: false,
                status: 'NOT_FOUND',
                message: `Transaksi TRX-ID / Ref ID '${refId}' tidak ditemukan.`
            });
        }

        const core = new OrderKuotaCore({
            username: account.username,
            authToken: account.token,
            userId: account.user_id,
            cookies: account.cookies
        });

        const limitParam = req.query.limit || 50;
        const pageParam = req.query.page || 1;
        const syncPages = Math.min(parseInt(req.query.sync_pages || 1, 10), 10);

        let liveMutasiRes = null;
        const fetchedMutasiList = [];

        for (let page = 1; page <= syncPages; page++) {
            const pageRes = await core.getTransactionQris(page);
            if (pageRes?.success) {
                liveMutasiRes = pageRes;
                const pageItems = pageRes.qris_history?.results || pageRes.qris_history?.data || [];
                
                for (const item of pageItems) {
                    const itemAmount = normalizeAmount(item.kredit || item.jumlah || item.amount || 0);
                    if (itemAmount <= 0) continue;

                    const baseRef = OrderKuotaCore.generateRefId(item, account.username);
                    const signature = OrderKuotaCore.generateSignature(baseRef);
                    const claimedRef = await db.claimPendingPayment(account.id, itemAmount);
                    const displayRef = claimedRef || baseRef;

                    await db.saveTransaction(
                        account.id,
                        displayRef,
                        signature,
                        itemAmount,
                        normalizeAmount(item.saldo_akhir || 0),
                        item.keterangan || 'QRIS OrderKuota',
                        item.tanggal || new Date().toISOString()
                    );
                    fetchedMutasiList.push(item);
                }
            }
        }

        const cachedTransactions = await db.getRecentTransactions(account.id, limitParam, pageParam);

        return res.json({
            success: true,
            source: 'live_api',
            data: {
                total: cachedTransactions.length > 0 ? cachedTransactions.length : fetchedMutasiList.length,
                transactions: cachedTransactions.length > 0 ? cachedTransactions : fetchedMutasiList,
                qris_balance: liveMutasiRes ? liveMutasiRes.qris_balance : 0,
                qris_name: liveMutasiRes ? liveMutasiRes.qris_name : 'MERCHANT',
                account: liveMutasiRes ? liveMutasiRes.account : null
            }
        });
    } catch (err) {
        logEvent('ERROR', `Gagal mengecek transaksi: ${err.message}`);
        res.status(500).json({ success: false, message: 'Gagal mengecek transaksi', error: err.message });
    }
});

app.post('/check-payment', async (req, res) => {
    try {
        const account = await resolveAccountByRequest(req);
        if (!account) {
            return res.status(401).json({ success: false, error: 'Kredensial Merchant atau API Key tidak valid' });
        }

        const { amount, startTime } = req.body || {};
        const targetAmount = normalizeAmount(amount);

        if (targetAmount <= 0) {
            return res.status(400).json({ success: false, message: 'Nominal pembayaran wajib disediakan' });
        }

        const minTimestamp = startTime ? new Date(startTime).getTime() : 0;

        const dbTransactions = await db.getRecentTransactions(account.id, 50);
        for (const tx of dbTransactions) {
            const txAmount = normalizeAmount(tx.amount);
            const txTime = new Date(tx.date || tx.created_at || Date.now()).getTime();
            if (Math.abs(txAmount - targetAmount) < 0.01 && txTime >= (minTimestamp - 60000)) {
                return res.json({
                    success: true,
                    paid: true,
                    transaction: {
                        transaction_id: tx.ref_id || tx.id,
                        ref_id: tx.ref_id,
                        amount: txAmount,
                        payer: tx.description || 'QRIS OrderKuota',
                        transaction_time: tx.date || new Date().toISOString()
                    }
                });
            }
        }

        const core = new OrderKuotaCore({
            username: account.username,
            authToken: account.token,
            userId: account.user_id,
            cookies: account.cookies
        });

        const liveMutasiRes = await core.getTransactionQris();
        const mutasiItems = liveMutasiRes?.qris_history?.results || liveMutasiRes?.qris_history?.data || [];

        let matchedTransaction = null;

        for (const item of mutasiItems) {
            const itemAmount = normalizeAmount(item.kredit || item.jumlah || item.amount || 0);
            const itemTime = new Date(item.tanggal || item.created_at || Date.now()).getTime();

            if (Math.abs(itemAmount - targetAmount) < 0.01 && itemTime >= minTimestamp) {
                const claimedRef = await db.claimPendingPayment(account.id, itemAmount);
                const baseRef = claimedRef || OrderKuotaCore.generateRefId(item, account.username);
                const signature = OrderKuotaCore.generateSignature(baseRef);

                await db.saveTransaction(
                    account.id,
                    baseRef,
                    signature,
                    itemAmount,
                    normalizeAmount(item.saldo_akhir || 0),
                    item.keterangan || 'QRIS OrderKuota',
                    item.tanggal || new Date().toISOString()
                );

                matchedTransaction = {
                    transaction_id: item.id || `${itemAmount}_${itemTime}`,
                    ref_id: baseRef,
                    amount: itemAmount,
                    payer: item.keterangan || 'QRIS OrderKuota',
                    transaction_time: item.tanggal || new Date().toISOString()
                };
                break;
            }
        }

        if (matchedTransaction) {
            return res.json({ success: true, paid: true, transaction: matchedTransaction });
        } else {
            return res.json({ success: true, paid: false, message: 'Pembayaran belum ditemukan' });
        }
    } catch (err) {
        logEvent('ERROR', `Gagal mengecek verifikasi pembayaran: ${err.message}`);
        res.status(500).json({ success: false, paid: false, error: err.message });
    }
});

let watcherInterval = null;
let watcherTimeout = null;

function triggerSmartWatcher(pollingIntervalMs = 15000, maxDurationMs = 300000) {
    if (watcherInterval) clearInterval(watcherInterval);
    if (watcherTimeout) clearTimeout(watcherTimeout);

    logEvent('INFO', `⚡ [Smart Watcher] Polling cepat (${pollingIntervalMs / 1000}s) DIAKTIFKAN selama ${maxDurationMs / 60000} menit.`);

    executeWatcherCycle().catch(() => {});

    watcherInterval = setInterval(async () => {
        const hasPending = await db.hasActivePendingPayments(maxDurationMs);
        if (!hasPending) {
            logEvent('INFO', '🛡️ [Smart Watcher] Semua pembayaran selesai/expired. Kembali ke mode idle.');
            stopSmartWatcher();
            return;
        }

        await executeWatcherCycle();
    }, pollingIntervalMs);

    watcherTimeout = setTimeout(() => {
        logEvent('INFO', `⏳ [Smart Watcher] Waktu aktif ${maxDurationMs / 60000} menit berakhir. Kembali ke mode idle.`);
        stopSmartWatcher();
    }, maxDurationMs);
}

function stopSmartWatcher() {
    if (watcherInterval) clearInterval(watcherInterval);
    if (watcherTimeout) clearTimeout(watcherTimeout);
    watcherInterval = null;
    watcherTimeout = null;
}

async function executeWatcherCycle() {
    try {
        const accounts = await db.getAllAccounts();
        for (const account of accounts) {
            if (!account.token || !account.user_id) continue;

            const core = new OrderKuotaCore({
                username: account.username,
                authToken: account.token,
                userId: account.user_id,
                cookies: account.cookies
            });

            await SessionManager.ensureValidToken(account.username, core, db);
            const liveMutasiRes = await core.getTransactionQris();
            const mutasiItems = liveMutasiRes?.qris_history?.results || liveMutasiRes?.qris_history?.data || [];

            for (const item of mutasiItems) {
                const amount = normalizeAmount(item.kredit || item.jumlah || item.amount || 0);
                if (amount <= 0) continue;

                const baseRef = OrderKuotaCore.generateRefId(item, account.username);
                const signature = OrderKuotaCore.generateSignature(baseRef);
                const displayRef = (await db.claimPendingPayment(account.id, amount)) || baseRef;

                await db.saveTransaction(
                    account.username,
                    displayRef,
                    signature,
                    amount,
                    normalizeAmount(item.saldo_akhir || 0),
                    item.keterangan || 'QRIS OrderKuota',
                    item.tanggal || new Date().toISOString()
                );
            }
        }
    } catch (err) {
        logEvent('ERROR', `Error pada siklus Watcher: ${err.message}`);
    }
}

(async () => {
    try {
        logEvent('INFO', '📦 Inisialisasi Storage Sesi & Database SQLite...');
        await db.initDb();
        logEvent('INFO', '✅ Database & Session Storage Berhasil Terhubung');

        app.listen(PORT, () => {
            logEvent('INFO', `🚀 Server REST API OrderKuota Gateway v2.0 (Pure Web API) Berjalan di Port ${PORT}`);
            logEvent('INFO', `🌐 URL Base Gateway: ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
            logEvent('INFO', '🛡️ Mode Pure On-Demand: Polling HANYA menyala 15s saat ada transaksi QRIS pending (0 Request saat idle/kosong).');
        });
    } catch (err) {
        logEvent('ERROR', `Gagal memulai server API: ${err.message}`);
    }
})();
