/**
 * Database Module for OrderKuota Gateway (SQLite DB)
 * File: orderkuota_gateway.db
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const SessionManager = require('./sessionManager');

const DB_FILE = path.join(__dirname, 'orderkuota_gateway.db');

let dbInstance = null;

function getDbConnection() {
    if (!dbInstance) {
        dbInstance = new sqlite3.Database(DB_FILE, (err) => {
            if (err) {
                console.error('❌ Gagal membuka database SQLite:', err.message);
            } else {
                console.log('🗄️ Database SQLite terhubung:', DB_FILE);
            }
        });
    }
    return dbInstance;
}

function runQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = getDbConnection();
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ id: this.lastID, changes: this.changes });
        });
    });
}

function getQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = getDbConnection();
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
}

function allQuery(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = getDbConnection();
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
}

async function initDb() {
    const db = getDbConnection();

    // Create Tables
    await runQuery(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            token TEXT,
            user_id TEXT,
            merchant_code TEXT UNIQUE,
            api_hash TEXT,
            cookies TEXT,
            chat_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    try {
        await runQuery(`ALTER TABLE accounts ADD COLUMN chat_id TEXT;`);
    } catch (e) {
        // Column already exists
    }

    try {
        await runQuery(`ALTER TABLE accounts ADD COLUMN last_qris_balance REAL DEFAULT 0;`);
    } catch (e) {
        // Column already exists
    }

    await runQuery(`
        CREATE TABLE IF NOT EXISTS pending_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT,
            ref_id TEXT UNIQUE,
            qr_string TEXT,
            amount REAL,
            created_at INTEGER,
            status TEXT DEFAULT 'PENDING'
        )
    `);

    await runQuery(`
        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id TEXT,
            ref_id TEXT UNIQUE,
            signature TEXT,
            amount REAL,
            saldo_akhir REAL,
            description TEXT,
            date TEXT,
            is_notified INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log('✅ SQLite Tables Ready (accounts, pending_payments, transactions)');

    // Migrasi data dari SessionManager/JSON DB jika SQLite masih kosong
    await migrateFromJsonToSqlite();
}

async function migrateFromJsonToSqlite() {
    try {
        const jsonData = SessionManager.loadSessions();
        
        // Import Accounts
        if (jsonData.accounts && jsonData.accounts.length > 0) {
            for (const acc of jsonData.accounts) {
                const existing = await getQuery(`SELECT id FROM accounts WHERE username = ?`, [acc.username]);
                if (!existing) {
                    await runQuery(
                        `INSERT INTO accounts (username, token, user_id, merchant_code, api_hash, cookies) VALUES (?, ?, ?, ?, ?, ?)`,
                        [acc.username, acc.token, acc.user_id, acc.merchant_code, acc.api_hash, JSON.stringify(acc.cookies || {})]
                    );
                    console.log(`📦 Migrasi Akun SQLite: ${acc.username}`);
                }
            }
        }

        // Import Transactions
        if (jsonData.transactions && jsonData.transactions.length > 0) {
            for (const tx of jsonData.transactions) {
                const existing = await getQuery(`SELECT id FROM transactions WHERE ref_id = ?`, [tx.ref_id]);
                if (!existing) {
                    await runQuery(
                        `INSERT INTO transactions (account_id, ref_id, signature, amount, saldo_akhir, description, date, is_notified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                        [tx.account_id, tx.ref_id, tx.signature, tx.amount, tx.saldo_akhir, tx.description, tx.date, tx.is_notified || 0]
                    );
                }
            }
        }

        // Import Pending Payments
        if (jsonData.pending_payments && jsonData.pending_payments.length > 0) {
            for (const p of jsonData.pending_payments) {
                const existing = await getQuery(`SELECT id FROM pending_payments WHERE ref_id = ?`, [p.ref_id]);
                if (!existing) {
                    await runQuery(
                        `INSERT INTO pending_payments (account_id, ref_id, qr_string, amount, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
                        [p.account_id, p.ref_id, p.qr_string, p.amount, p.created_at, p.status || 'PENDING']
                    );
                }
            }
        }
    } catch (e) {
        console.error('⚠️ Gagal migrasi data dari JSON ke SQLite:', e.message);
    }
}

// -------------------------------------------------------------
// ACCOUNTS MANAGEMENT
// -------------------------------------------------------------

async function getAccountByUsername(username) {
    const row = await getQuery(`SELECT * FROM accounts WHERE username = ?`, [username]);
    if (row && row.cookies) {
        try { row.cookies = JSON.parse(row.cookies); } catch (e) {}
    }
    if (!row) {
        return SessionManager.getSession(username);
    }
    return row;
}

async function getAccountByMerchant(merchantCode, apiHash) {
    const row = await getQuery(`SELECT * FROM accounts WHERE merchant_code = ? AND api_hash = ?`, [merchantCode, apiHash]);
    if (row && row.cookies) {
        try { row.cookies = JSON.parse(row.cookies); } catch (e) {}
    }
    if (!row) {
        const data = SessionManager.loadSessions();
        return data.accounts.find(a => a.merchant_code === merchantCode && a.api_hash === apiHash) || null;
    }
    return row;
}

async function getAllAccounts() {
    const rows = await allQuery(`SELECT * FROM accounts ORDER BY id ASC`);
    if (rows && rows.length > 0) {
        return rows.map(row => {
            if (row.cookies) {
                try { row.cookies = JSON.parse(row.cookies); } catch (e) {}
            }
            return row;
        });
    }
    return SessionManager.loadSessions().accounts;
}

async function addOrUpdateAccount(username, password, chatId, token, userId, cookies) {
    const crypto = require('crypto');
    const existing = await getAccountByUsername(username);
    const cookiesStr = typeof cookies === 'string' ? cookies : JSON.stringify(cookies || []);

    let merchantCode = (existing && existing.merchant_code) ? existing.merchant_code : ('M' + crypto.randomBytes(4).toString('hex').toUpperCase());
    let apiHash = (existing && existing.api_hash) ? existing.api_hash : crypto.randomBytes(16).toString('hex');

    if (existing && existing.id) {
        await runQuery(
            `UPDATE accounts SET token = ?, user_id = ?, merchant_code = ?, api_hash = ?, cookies = ?, chat_id = ? WHERE username = ?`,
            [token, String(userId), merchantCode, apiHash, cookiesStr, String(chatId), username]
        );
    } else {
        await runQuery(
            `INSERT INTO accounts (username, token, user_id, merchant_code, api_hash, cookies, chat_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [username, token, String(userId), merchantCode, apiHash, cookiesStr, String(chatId)]
        );
    }

    const updatedAccount = {
        username,
        password,
        chat_id: String(chatId),
        token,
        user_id: String(userId),
        cookies,
        merchant_code: merchantCode,
        api_hash: apiHash
    };

    SessionManager.saveSession(updatedAccount);
    return updatedAccount;
}

async function saveAccount(accountData) {
    return addOrUpdateAccount(
        accountData.username,
        accountData.password,
        accountData.chat_id || 'CLI',
        accountData.token,
        accountData.user_id,
        accountData.cookies
    );
}

async function updateAccountToken(username, token, userId) {
    await runQuery(`UPDATE accounts SET token = ?, user_id = ? WHERE username = ?`, [token, userId, username]);
    
    const acc = await getAccountByUsername(username);
    if (acc) {
        acc.token = token;
        acc.user_id = userId;
        SessionManager.saveSession(acc);
    }
}

async function updateAccountQrisBalance(username, qrisBalance) {
    try {
        await runQuery(`UPDATE accounts SET last_qris_balance = ? WHERE username = ?`, [qrisBalance, username]);
    } catch (e) {}
    const acc = await getAccountByUsername(username);
    if (acc) {
        acc.last_qris_balance = qrisBalance;
        SessionManager.saveSession(username, acc);
    }
}

// -------------------------------------------------------------
// PENDING PAYMENTS MANAGEMENT
// -------------------------------------------------------------

async function savePendingPayment(accountId, refId, qrString, amount) {
    const createdAt = Date.now();
    await runQuery(
        `INSERT OR REPLACE INTO pending_payments (account_id, ref_id, qr_string, amount, created_at, status) VALUES (?, ?, ?, ?, ?, 'PENDING')`,
        [accountId, refId, qrString, amount, createdAt]
    );

    // Sync to SessionManager
    const data = SessionManager.loadSessions();
    data.pending_payments = data.pending_payments.filter(p => p.ref_id !== refId);
    data.pending_payments.push({
        id: createdAt,
        account_id: accountId,
        ref_id: refId,
        qr_string: qrString,
        amount: amount,
        created_at: createdAt,
        status: 'PENDING'
    });
    SessionManager.saveSessions(data);
}

async function getPendingPayment(refId) {
    const row = await getQuery(`SELECT * FROM pending_payments WHERE ref_id = ?`, [refId]);
    if (row) return row;

    const data = SessionManager.loadSessions();
    return (data.pending_payments || []).find(p => p.ref_id === refId) || null;
}

async function hasActivePendingPayments(maxAgeMs = 300000) {
    const cutoff = Date.now() - maxAgeMs;
    try {
        const row = await getQuery(
            `SELECT COUNT(*) as count FROM pending_payments WHERE status = 'PENDING' AND created_at >= ?`,
            [cutoff]
        );
        if (row && row.count > 0) return true;
    } catch (e) {}

    const data = SessionManager.loadSessions();
    const active = (data.pending_payments || []).some(
        p => p.status === 'PENDING' && p.created_at >= cutoff
    );
    return active;
}

async function claimPendingPayment(accountId, amount) {
    let row = await getQuery(
        `SELECT * FROM pending_payments WHERE (account_id = ? OR account_id = ? OR account_id = '0' OR account_id = 'DEFAULT') AND amount = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
        [accountId, String(accountId), amount]
    );

    if (!row) {
        row = await getQuery(
            `SELECT * FROM pending_payments WHERE amount = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
            [amount]
        );
    }

    if (row) {
        await runQuery(`UPDATE pending_payments SET status = 'CLAIMED' WHERE ref_id = ?`, [row.ref_id]);
        
        // Sync to SessionManager
        const data = SessionManager.loadSessions();
        const pending = (data.pending_payments || []).find(p => p.ref_id === row.ref_id);
        if (pending) pending.status = 'CLAIMED';
        SessionManager.saveSessions(data);

        return row.ref_id;
    }

    return null;
}

// -------------------------------------------------------------
// TRANSACTIONS HISTORY MANAGEMENT
// -------------------------------------------------------------

async function saveTransaction(accountId, refId, signature, amount, saldoAkhir, description, date) {
    const existing = await getQuery(`SELECT id FROM transactions WHERE ref_id = ? OR signature = ?`, [refId, signature]);
    if (existing) {
        return false;
    }

    await runQuery(
        `INSERT INTO transactions (account_id, ref_id, signature, amount, saldo_akhir, description, date, is_notified) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [accountId, refId, signature, amount, saldoAkhir, description, date]
    );

    // Sync to SessionManager
    const data = SessionManager.loadSessions();
    const alreadyExists = (data.transactions || []).some(t => t.ref_id === refId || t.signature === signature);
    if (!alreadyExists) {
        data.transactions.push({
            id: Date.now(),
            account_id: accountId,
            ref_id: refId,
            signature: signature,
            amount: amount,
            saldo_akhir: saldoAkhir,
            description: description,
            date: date,
            is_notified: 0
        });
        SessionManager.saveSessions(data);
    }

    return true;
}

async function getTransactionByRef(accountId, refId) {
    const row = await getQuery(`SELECT * FROM transactions WHERE ref_id = ?`, [refId]);
    if (row) return row;

    const data = SessionManager.loadSessions();
    const list = (data.transactions || []).filter(t => t.ref_id === refId);
    return list.length > 0 ? list[list.length - 1] : null;
}

async function getTransactionBySignature(accountId, signature) {
    const row = await getQuery(`SELECT * FROM transactions WHERE (account_id = ? OR account_id = ?) AND signature = ?`, [accountId, String(accountId), signature]);
    if (row) return row;

    const data = SessionManager.loadSessions();
    return data.transactions.find(t => String(t.account_id) === String(accountId) && t.signature === signature) || null;
}

async function getRecentTransactions(accountId, limit = 50, page = 1) {
    const limitNum = (limit === 'all' || limit === '0' || limit === 0) ? -1 : (parseInt(limit, 10) || 50);
    const pageNum = parseInt(page, 10) || 1;
    const offset = limitNum > 0 ? (pageNum - 1) * limitNum : 0;

    let rows = [];
    if (limitNum === -1) {
        rows = await allQuery(`SELECT * FROM transactions WHERE account_id = ? OR account_id = ? ORDER BY id DESC`, [accountId, String(accountId)]);
    } else {
        rows = await allQuery(`SELECT * FROM transactions WHERE account_id = ? OR account_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, [accountId, String(accountId), limitNum, offset]);
    }

    if (rows && rows.length > 0) {
        return rows;
    }

    const data = SessionManager.loadSessions();
    const list = data.transactions.filter(t => String(t.account_id) === String(accountId)).reverse();

    if (limitNum === -1) return list;
    return list.slice(offset, offset + limitNum);
}



module.exports = {
    initDb,
    getAccount: getAccountByUsername,
    getAccountByUsername,
    getAccountByMerchant,
    getAllAccounts,
    saveAccount,
    addOrUpdateAccount,
    updateAccountToken,
    updateAccountQrisBalance,
    savePendingPayment,
    getPendingPayment,
    hasActivePendingPayments,
    claimPendingPayment,
    saveTransaction,
    getTransactionByRef,
    getTransactionBySignature,
    getRecentTransactions
};
