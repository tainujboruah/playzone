const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'db.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'ADMIN123';

// Load or Initialize Persistent File Database
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      currentPeriod: 20261124001,
      currentPeriod1m: 20261124001,
      users: [],
      bets: [],
      transactions: [],
      history: [
        { period: 20261124000, number: 7, color: 'green' },
        { period: 20261123999, number: 2, color: 'red' },
        { period: 20261123998, number: 5, color: 'violet' }
      ],
      history1m: [
        { period: 20261124000, number: 7, color: 'green' },
        { period: 20261123999, number: 2, color: 'red' },
        { period: 20261123998, number: 5, color: 'violet' }
      ]
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (data.currentPeriod1m === undefined) data.currentPeriod1m = 20261124001;
  if (!data.history1m) data.history1m = [
    { period: 20261124000, number: 7, color: 'green' },
    { period: 20261123999, number: 2, color: 'red' },
    { period: 20261123998, number: 5, color: 'violet' }
  ];
  return data;
}

let db = loadDB();
let timeLeft = 30;
let timeLeft1m = 60;
let manualNextResult = null;
let manualNextResult1m = null;
const sessions = {}; // token -> userId

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  const [salt, key] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
}

function getColorByNumber(num) {
  if (num === 0 || num === 5) return 'violet';
  return num % 2 === 0 ? 'red' : 'green';
}

// Settle one finished period (mode: '30s' or '1min')
function settlePeriod(mode) {
  const is1m = mode === '1min';
  const periodKey = is1m ? 'currentPeriod1m' : 'currentPeriod';
  const histKey = is1m ? 'history1m' : 'history';
  const winningNumber = is1m
    ? (manualNextResult1m !== null ? manualNextResult1m : Math.floor(Math.random() * 10))
    : (manualNextResult !== null ? manualNextResult : Math.floor(Math.random() * 10));
  const winningColor = getColorByNumber(winningNumber);
  if (is1m) manualNextResult1m = null; else manualNextResult = null;

  // Settle all pending bets for this mode's current period
  db.bets.forEach((bet) => {
    if ((bet.mode || '30s') === mode && bet.period === db[periodKey] && bet.status === 'pending') {
      let payout = 0;
      if (bet.type === 'number' && Number(bet.choice) === winningNumber) {
        payout = bet.amount * 9;
      } else if (bet.type === 'color') {
        if (bet.choice === winningColor) {
          payout = bet.choice === 'violet' ? bet.amount * 4.5 : bet.amount * 2;
        } else if (
          (winningNumber === 0 && bet.choice === 'red') ||
          (winningNumber === 5 && bet.choice === 'green')
        ) {
          payout = bet.amount * 1.5;
        }
      }

      bet.payout = payout;
      bet.status = payout > 0 ? 'won' : 'lost';
      bet.resultNumber = winningNumber;

      if (payout > 0) {
        const user = db.users.find((u) => u.id === bet.userId);
        if (user) user.balance += payout;
      }
    }
  });

  db[histKey].unshift({
    period: db[periodKey],
    number: winningNumber,
    color: winningColor
  });
  if (db[histKey].length > 30) db[histKey].pop();

  db[periodKey]++;
}

// Live Game Timers & Settlement Engine (30s + 1 Min modes run side by side)
setInterval(() => {
  timeLeft--;
  if (timeLeft <= 0) {
    settlePeriod('30s');
    timeLeft = 30;
    saveDB();
  }
  timeLeft1m--;
  if (timeLeft1m <= 0) {
    settlePeriod('1min');
    timeLeft1m = 60;
    saveDB();
  }
}, 1000);

// Middlewares
function requireAuth(req, res, next) {
  const token = req.headers['x-token'];
  const userId = sessions[token];
  if (!userId) return res.status(401).json({ error: 'Login required' });
  const user = db.users.find((u) => u.id === userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.blocked) return res.status(403).json({ error: 'Account blocked by Admin' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Invalid Admin Key' });
  }
  next();
}

// --- AUTH APIs ---
app.post('/api/auth/register', (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password || password.length < 4) {
    return res.status(400).json({ error: 'Valid phone aur min 4-digit password dalein' });
  }
  if (db.users.find((u) => u.phone === phone)) {
    return res.status(400).json({ error: 'Ye number pehle se registered hai' });
  }

  const newUser = {
    id: 'USR' + Math.floor(1000 + Math.random() * 9000),
    phone,
    passwordHash: hashPassword(password),
    balance: 50, // Demo welcome balance
    wagered: 0,
    deposited: 0,
    blocked: false,
    createdAt: new Date().toISOString()
  };
  db.users.push(newUser);
  saveDB();

  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = newUser.id;
  res.json({ token, user: { id: newUser.id, phone: newUser.phone, balance: newUser.balance } });
});

app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body;
  const user = db.users.find((u) => u.phone === phone);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Phone ya password galat hai' });
  }
  if (user.blocked) return res.status(403).json({ error: 'Account blocked hai' });

  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = user.id;
  res.json({ token, user: { id: user.id, phone: user.phone, balance: user.balance } });
});

// --- GAME & USER APIs ---
app.get('/api/state', requireAuth, (req, res) => {
  const myBets = db.bets.filter((b) => b.userId === req.user.id).slice(0, 20);
  const myTxns = db.transactions.filter((t) => t.userId === req.user.id).slice(0, 20);

  res.json({
    period: db.currentPeriod,
    timeLeft,
    period1m: db.currentPeriod1m,
    timeLeft1m,
    user: { id: req.user.id, phone: req.user.phone, balance: req.user.balance, wagered: req.user.wagered || 0, deposited: req.user.deposited || 0 },
    history: db.history.slice(0, 15),
    history1m: (db.history1m || []).slice(0, 15),
    myBets,
    myTxns
  });
});

app.post('/api/bet', requireAuth, (req, res) => {
  const { type, choice, amount } = req.body;
  const betAmount = Number(amount);
  const mode = req.body.mode === '1min' ? '1min' : '30s';
  const modeTimeLeft = mode === '1min' ? timeLeft1m : timeLeft;

  if (modeTimeLeft <= 5) return res.status(400).json({ error: 'Last 5 sec me betting lock hoti hai' });
  if (!betAmount || betAmount < 1) return res.status(400).json({ error: 'Minimum bet ₹1 hai' });
  if (betAmount > req.user.balance) return res.status(400).json({ error: 'Wallet balance kam hai' });

  req.user.balance -= betAmount;
  req.user.wagered = (req.user.wagered || 0) + betAmount;
  const bet = {
    id: 'BET' + Date.now(),
    userId: req.user.id,
    period: mode === '1min' ? db.currentPeriod1m : db.currentPeriod,
    mode,
    type,
    choice: String(choice),
    amount: betAmount,
    payout: 0,
    status: 'pending',
    time: new Date().toLocaleTimeString()
  };
  db.bets.unshift(bet);
  saveDB();

  res.json({ message: 'Bet placed!', balance: req.user.balance });
});

app.post('/api/wallet/request', requireAuth, (req, res) => {
  const { type, amount, reference } = req.body;
  const amt = Number(amount);

  if (!['deposit', 'withdrawal'].includes(type)) {
    return res.status(400).json({ error: 'Invalid transaction type' });
  }
  if (!amt || amt < 1) return res.status(400).json({ error: 'Minimum amount ₹1 hai' });
  if (!reference) return res.status(400).json({ error: 'UTR ya UPI ID enter karein' });

  if (type === 'withdrawal') {
    if (amt > req.user.balance) return res.status(400).json({ error: 'Balance kam hai' });
    const wagered = req.user.wagered || 0;
    const deposited = req.user.deposited || 0;
    const required = deposited + 50;
    if (wagered < required) return res.status(400).json({ error: `Withdrawal ke liye ₹${required} ke bets lagane honge (deposit ₹${deposited} + bonus ₹50) — abhi ₹${wagered} ke bets lage hain.` });
    req.user.balance -= amt; // Hold balance until approved/rejected
  }

  const txn = {
    id: 'TXN' + Math.floor(10000 + Math.random() * 90000),
    userId: req.user.id,
    phone: req.user.phone,
    type,
    amount: amt,
    reference,
    status: 'pending',
    time: new Date().toLocaleString()
  };
  db.transactions.unshift(txn);
  saveDB();

  res.json({ message: `${type} request submit ho gayi!`, balance: req.user.balance });
});

// --- ADMIN APIs ---
app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const pendingDeposits = db.transactions
    .filter((t) => t.type === 'deposit' && t.status === 'pending')
    .reduce((sum, t) => sum + t.amount, 0);
  const pendingWithdrawals = db.transactions
    .filter((t) => t.type === 'withdrawal' && t.status === 'pending')
    .reduce((sum, t) => sum + t.amount, 0);

  res.json({
    currentPeriod: db.currentPeriod,
    timeLeft,
    manualNextResult,
    currentPeriod1m: db.currentPeriod1m,
    timeLeft1m,
    manualNextResult1m,
    stats: {
      totalUsers: db.users.length,
      pendingDeposits,
      pendingWithdrawals,
      activeBetsCount: db.bets.filter((b) => (b.mode || '30s') === '30s' && b.period === db.currentPeriod).length,
      activeBetsCount1m: db.bets.filter((b) => b.mode === '1min' && b.period === db.currentPeriod1m).length
    },
    users: db.users.map(({ passwordHash, ...safe }) => safe),
    transactions: db.transactions.slice(0, 50),
    currentBets: db.bets.filter((b) => (b.mode || '30s') === '30s' && b.period === db.currentPeriod),
    currentBets1m: db.bets.filter((b) => b.mode === '1min' && b.period === db.currentPeriod1m)
  });
});

app.post('/api/admin/txn', requireAdmin, (req, res) => {
  const { txnId, status } = req.body;
  const txn = db.transactions.find((t) => t.id === txnId);
  if (!txn || txn.status !== 'pending') {
    return res.status(400).json({ error: 'Transaction not found ya already processed' });
  }

  txn.status = status;
  const user = db.users.find((u) => u.id === txn.userId);
  if (user) {
    if (txn.type === 'deposit' && status === 'approved') { user.balance += txn.amount; user.deposited = (user.deposited || 0) + txn.amount; }
    if (txn.type === 'withdrawal' && status === 'rejected') user.balance += txn.amount;
  }
  saveDB();
  res.json({ message: `Transaction ${status}` });
});

app.post('/api/admin/user-toggle', requireAdmin, (req, res) => {
  const user = db.users.find((u) => u.id === req.body.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.blocked = !user.blocked;
  saveDB();
  res.json({ message: 'User status updated', blocked: user.blocked });
});

app.post('/api/admin/set-result', requireAdmin, (req, res) => {
  const num = Number(req.body.number);
  if (isNaN(num) || num < 0 || num > 9) {
    return res.status(400).json({ error: 'Number 0 se 9 ke beech hona chahiye' });
  }
  const mode = req.body.mode === '1min' ? '1min' : '30s';
  if (mode === '1min') {
    manualNextResult1m = num;
    res.json({ message: `1 Min Period ${db.currentPeriod1m} ka result ${num} set ho gaya.` });
  } else {
    manualNextResult = num;
    res.json({ message: `Period ${db.currentPeriod} ka result ${num} set ho gaya.` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`User App:  http://localhost:${PORT}`);
  console.log(`Admin UI:  http://localhost:${PORT}/admin.html`);
});
