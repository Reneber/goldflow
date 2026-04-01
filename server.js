const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'database.json');

function defaultDB() {
    const adminCode = 'PROF-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    return {
        users: [{
            id: 1, name: 'Professor (Admin)', email: 'admin', password: 'admin',
            inviteCode: adminCode, recruiterId: null, level: 0,
            plan: 0, planName: 'Fundador',
            balance: 0, totalDeposited: 0, totalWithdrawn: 0, totalEarnings: 0,
            createdAt: Date.now(), isAdmin: true, status: 'active'
        }],
        transactions: [],
        systemCash: 0, totalInvested: 0, totalPaidOut: 0,
        collapsed: false, nextId: 2,
        config: {
            commissionL1: 0.10, commissionL2: 0.05, commissionL3: 0.02,
            withdrawFee: 0.05,
            pixKey: '', pixName: 'GoldFlow', pixType: 'CPF',
            plans: [
                { value: 2, name: 'Bronze (R$2)' },
                { value: 5, name: 'Prata (R$5)' },
                { value: 10, name: 'Ouro (R$10)' },
                { value: 20, name: 'Diamante (R$20)' }
            ],
            bonuses: [
                { directs: 3, amount: 1 },
                { directs: 5, amount: 3 },
                { directs: 10, amount: 10 }
            ]
        }
    };
}

let db;
try {
    if (fs.existsSync(DB_FILE)) {
        db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!db.users) throw new Error();
        // Migrate: add status to old users
        db.users.forEach(u => { if (!u.status) u.status = 'active'; });
        if (!db.config.pixKey && db.config.pixKey !== '') db.config.pixKey = '';
        if (!db.config.pixName) db.config.pixName = 'GoldFlow';
        if (!db.config.pixType) db.config.pixType = 'CPF';
    } else {
        db = defaultDB();
    }
} catch { db = defaultDB(); }

function save() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function genCode() { return 'GF-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

const sessions = new Map();

function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Não autenticado' });
    req.user = db.users.find(u => u.id === sessions.get(token).id) || sessions.get(token);
    next();
}

// Only count active users in network
function getDirects(userId) {
    return db.users.filter(u => u.recruiterId === userId && u.status === 'active');
}
function getDescendants(userId) {
    const directs = getDirects(userId);
    let all = [...directs];
    directs.forEach(d => { all = all.concat(getDescendants(d.id)); });
    return all;
}
// All directs including pending (for admin view)
function getAllDirects(userId) {
    return db.users.filter(u => u.recruiterId === userId);
}

function addTx(userId, type, desc, amount, balanceAfter) {
    db.transactions.push({ id: db.transactions.length + 1, userId, type, desc, amount, balanceAfter, time: Date.now() });
}

function payUser(user, amount, desc) {
    if (amount <= 0) return;
    const actual = Math.min(amount, db.systemCash);
    if (actual <= 0) return;
    user.balance += actual;
    user.totalEarnings += actual;
    db.systemCash -= actual;
    db.totalPaidOut += actual;
    addTx(user.id, actual < amount ? 'commission_partial' : 'commission', desc, actual, user.balance);
    if (actual < amount) checkCollapse();
}

function processCommissions(newUser) {
    const recruiter = db.users.find(u => u.id === newUser.recruiterId);
    if (!recruiter) return;

    // L1 commission
    payUser(recruiter, newUser.plan * db.config.commissionL1,
        `Comissão direta: ${newUser.name} (${newUser.planName})`);

    // L2
    if (recruiter.recruiterId) {
        const l2 = db.users.find(u => u.id === recruiter.recruiterId);
        if (l2) payUser(l2, newUser.plan * db.config.commissionL2, `Comissão nível 2: ${newUser.name}`);
        // L3
        if (l2 && l2.recruiterId) {
            const l3 = db.users.find(u => u.id === l2.recruiterId);
            if (l3) payUser(l3, newUser.plan * db.config.commissionL3, `Comissão nível 3: ${newUser.name}`);
        }
    }

    // Bonus
    const directCount = getDirects(recruiter.id).length;
    for (const bonus of db.config.bonuses) {
        if (directCount === bonus.directs) {
            payUser(recruiter, bonus.amount, `Bônus: ${bonus.directs} recrutados diretos!`);
        }
    }
}

function checkCollapse() {
    const totalBalances = db.users.reduce((s, u) => s + u.balance, 0);
    if (db.systemCash < totalBalances * 0.05 && db.users.filter(u => u.status === 'active').length > 5) {
        db.collapsed = true;
    }
}

// ============================================================
// AUTH
// ============================================================
app.post('/api/register', (req, res) => {
    const { name, email, password, inviteCode, plan } = req.body;
    if (!name || name.length < 2) return res.status(400).json({ error: 'Nome obrigatório (min 2 caracteres)' });
    if (!email) return res.status(400).json({ error: 'Email/usuário obrigatório' });
    if (!password || password.length < 3) return res.status(400).json({ error: 'Senha mínima: 3 caracteres' });
    if (!inviteCode) return res.status(400).json({ error: 'Código de convite obrigatório' });
    if (!plan) return res.status(400).json({ error: 'Selecione um plano' });
    if (db.users.find(u => u.email.toLowerCase() === email.toLowerCase()))
        return res.status(400).json({ error: 'Email/usuário já cadastrado' });

    const recruiter = db.users.find(u => u.inviteCode === inviteCode.toUpperCase().trim());
    if (!recruiter) return res.status(400).json({ error: 'Código de convite inválido' });
    if (db.collapsed) return res.status(400).json({ error: 'Sistema temporariamente fechado' });

    const planConfig = db.config.plans.find(p => p.value === parseInt(plan));
    if (!planConfig) return res.status(400).json({ error: 'Plano inválido' });

    const newUser = {
        id: db.nextId++, name: name.trim(), email: email.trim().toLowerCase(), password,
        inviteCode: genCode(), recruiterId: recruiter.id, level: recruiter.level + 1,
        plan: planConfig.value, planName: planConfig.name,
        balance: 0, totalDeposited: 0, totalWithdrawn: 0, totalEarnings: 0,
        createdAt: Date.now(), isAdmin: false,
        status: 'pending_payment' // NOT active yet
    };

    db.users.push(newUser);
    save();

    const token = genToken();
    sessions.set(token, newUser);
    res.json({ token, user: sanitizeUser(newUser) });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = db.users.find(u =>
        (u.email.toLowerCase() === email?.toLowerCase() || u.name.toLowerCase() === email?.toLowerCase())
        && u.password === password
    );
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
    const token = genToken();
    sessions.set(token, user);
    res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/logout', auth, (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    sessions.delete(token);
    res.json({ ok: true });
});

// ============================================================
// PAYMENT FLOW
// ============================================================
app.get('/api/pix-info', auth, (req, res) => {
    res.json({
        pixKey: db.config.pixKey,
        pixName: db.config.pixName,
        pixType: db.config.pixType,
        plan: req.user.plan,
        planName: req.user.planName,
        status: req.user.status
    });
});

app.post('/api/confirm-payment', auth, (req, res) => {
    const u = req.user;
    if (u.status !== 'pending_payment')
        return res.status(400).json({ error: 'Pagamento já confirmado ou conta já ativa' });
    u.status = 'pending_approval';
    save();
    res.json({ status: u.status, message: 'Pagamento informado! Aguarde aprovação do administrador.' });
});

// ============================================================
// USER
// ============================================================
app.get('/api/me', auth, (req, res) => {
    const u = req.user;
    const directs = getDirects(u.id);
    const descendants = getDescendants(u.id);
    const roi = u.plan > 0 ? ((u.totalEarnings / u.plan) * 100) : 0;
    res.json({
        user: sanitizeUser(u),
        stats: {
            directCount: directs.length,
            indirectCount: descendants.length - directs.length,
            networkTotal: descendants.length,
            roi: roi.toFixed(1),
            netProfit: u.totalEarnings - u.plan
        },
        collapsed: db.collapsed
    });
});

app.get('/api/my-network', auth, (req, res) => {
    const directs = getDirects(req.user.id).map(u => ({
        id: u.id, name: u.name, level: u.level, plan: u.planName,
        planValue: u.plan, createdAt: u.createdAt,
        recruits: getDirects(u.id).length, relation: 'Direto'
    }));
    const indirects = [];
    directs.forEach(d => {
        getDirects(d.id).forEach(u => {
            indirects.push({
                id: u.id, name: u.name, level: u.level, plan: u.planName,
                planValue: u.plan, createdAt: u.createdAt,
                recruits: getDirects(u.id).length, relation: 'Indireto'
            });
        });
    });
    res.json({ directs, indirects });
});

app.get('/api/my-transactions', auth, (req, res) => {
    res.json({ transactions: db.transactions.filter(t => t.userId === req.user.id).slice(-100).reverse() });
});

app.get('/api/invite-code', auth, (req, res) => {
    res.json({ code: req.user.inviteCode });
});

app.get('/api/ranking', auth, (req, res) => {
    const ranked = db.users
        .filter(u => !u.isAdmin && u.status === 'active')
        .map(u => ({
            id: u.id, name: u.name, level: u.level,
            directs: getDirects(u.id).length,
            network: getDescendants(u.id).length,
            earnings: u.totalEarnings,
            isMe: u.id === req.user.id
        }))
        .sort((a, b) => b.earnings - a.earnings)
        .slice(0, 30);
    res.json({ ranking: ranked });
});

app.get('/api/plans', (req, res) => {
    res.json({ plans: db.config.plans, collapsed: db.collapsed });
});

// ============================================================
// WALLET
// ============================================================
app.post('/api/deposit', auth, (req, res) => {
    if (req.user.status !== 'active') return res.status(403).json({ error: 'Conta não ativada' });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < 1) return res.status(400).json({ error: 'Valor mínimo: R$ 1' });
    const u = req.user;
    u.balance += amount; u.totalDeposited += amount;
    db.systemCash += amount; db.totalInvested += amount;
    addTx(u.id, 'deposit', `Depósito: R$ ${amount.toFixed(2)}`, amount, u.balance);
    save();
    res.json({ balance: u.balance, message: `Depósito de R$ ${amount.toFixed(2)} realizado` });
});

app.post('/api/withdraw', auth, (req, res) => {
    if (req.user.status !== 'active') return res.status(403).json({ error: 'Conta não ativada' });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < 1) return res.status(400).json({ error: 'Valor mínimo: R$ 1' });
    const u = req.user;
    const fee = amount * db.config.withdrawFee;
    const total = amount + fee;
    if (total > u.balance)
        return res.status(400).json({ error: `Saldo insuficiente. Tem R$ ${u.balance.toFixed(2)}, precisa R$ ${total.toFixed(2)} (taxa ${(db.config.withdrawFee*100)}%)` });
    if (amount > db.systemCash) {
        addTx(u.id, 'withdraw_denied', `SAQUE NEGADO: Sistema sem fundos`, 0, u.balance);
        db.collapsed = true; save();
        return res.status(400).json({ error: 'SAQUE NEGADO! O sistema não possui fundos suficientes.', collapsed: true });
    }
    u.balance -= total; u.totalWithdrawn += amount;
    db.systemCash -= amount; db.totalPaidOut += amount;
    addTx(u.id, 'withdraw', `Saque: R$ ${amount.toFixed(2)} (taxa: R$ ${fee.toFixed(2)})`, amount, u.balance);
    save();
    res.json({ balance: u.balance, message: `Saque de R$ ${amount.toFixed(2)} processado! (taxa: R$ ${fee.toFixed(2)})` });
});

// ============================================================
// ADMIN
// ============================================================
app.get('/api/admin/pending', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const pending = db.users
        .filter(u => u.status === 'pending_approval')
        .map(u => ({
            id: u.id, name: u.name, email: u.email, plan: u.plan, planName: u.planName,
            recruiterId: u.recruiterId,
            recruiterName: db.users.find(x => x.id === u.recruiterId)?.name || '-',
            createdAt: u.createdAt
        }));
    res.json({ pending });
});

app.post('/api/admin/approve/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const user = db.users.find(u => u.id === parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.status === 'active') return res.status(400).json({ error: 'Já está ativo' });

    user.status = 'active';
    user.totalDeposited = user.plan;

    // Money enters the system NOW
    db.systemCash += user.plan;
    db.totalInvested += user.plan;
    addTx(user.id, 'investment', `Investimento: ${user.planName}`, user.plan, 0);

    // Process commissions NOW
    processCommissions(user);
    save();

    res.json({ message: `${user.name} aprovado! Comissões processadas.` });
});

app.post('/api/admin/reject/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const idx = db.users.findIndex(u => u.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Usuário não encontrado' });
    const user = db.users[idx];
    if (user.status === 'active') return res.status(400).json({ error: 'Já está ativo, não pode rejeitar' });
    db.users.splice(idx, 1);
    save();
    res.json({ message: `${user.name} rejeitado e removido.` });
});

app.post('/api/admin/set-pix', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const { pixKey, pixName, pixType } = req.body;
    if (pixKey !== undefined) db.config.pixKey = pixKey;
    if (pixName !== undefined) db.config.pixName = pixName;
    if (pixType !== undefined) db.config.pixType = pixType;
    save();
    res.json({ message: 'Chave PIX atualizada!', config: { pixKey: db.config.pixKey, pixName: db.config.pixName, pixType: db.config.pixType } });
});

app.get('/api/admin/overview', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const active = db.users.filter(u => u.status === 'active');
    const paying = active.filter(u => u.plan > 0);
    const profiting = paying.filter(u => u.totalEarnings >= u.plan);
    const losing = paying.filter(u => u.totalEarnings < u.plan);
    const totalBalances = db.users.reduce((s, u) => s + u.balance, 0);
    const maxLevel = active.length > 1 ? Math.max(...active.map(u => u.level)) : 0;
    const pendingCount = db.users.filter(u => u.status === 'pending_approval').length;

    const levels = [];
    for (let i = 0; i <= maxLevel; i++) {
        const atLevel = active.filter(u => u.level === i);
        const losersAtLevel = atLevel.filter(u => u.plan > 0 && u.totalEarnings < u.plan);
        levels.push({
            level: i, count: atLevel.length, losers: losersAtLevel.length,
            invested: atLevel.reduce((s, u) => s + u.totalDeposited, 0),
            earnings: atLevel.reduce((s, u) => s + u.totalEarnings, 0)
        });
    }

    res.json({
        totalMembers: active.length, pendingCount,
        totalInvested: db.totalInvested, totalPaidOut: db.totalPaidOut,
        systemCash: db.systemCash, totalBalances,
        profiting: profiting.length, losing: losing.length,
        lossPct: paying.length > 0 ? ((losing.length / paying.length) * 100).toFixed(1) : '0',
        maxLevel, levels, collapsed: db.collapsed,
        cashCoverage: totalBalances > 0 ? ((db.systemCash / totalBalances) * 100).toFixed(1) : '100',
        pixKey: db.config.pixKey, pixName: db.config.pixName, pixType: db.config.pixType
    });
});

app.get('/api/admin/users', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const users = db.users.map(u => ({
        id: u.id, name: u.name, email: u.email, level: u.level,
        plan: u.plan, planName: u.planName,
        balance: u.balance, totalDeposited: u.totalDeposited,
        totalWithdrawn: u.totalWithdrawn, totalEarnings: u.totalEarnings,
        netProfit: u.totalEarnings - u.plan,
        directs: getDirects(u.id).length, network: getDescendants(u.id).length,
        inviteCode: u.inviteCode, recruiterId: u.recruiterId,
        recruiterName: u.recruiterId ? db.users.find(x => x.id === u.recruiterId)?.name : null,
        createdAt: u.createdAt, isAdmin: u.isAdmin, userStatus: u.status,
        status: u.isAdmin ? 'admin' : u.status !== 'active' ? u.status : u.totalEarnings >= u.plan ? 'profit' : 'loss'
    }));
    res.json({ users });
});

app.post('/api/admin/reset', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const oldPix = { pixKey: db.config.pixKey, pixName: db.config.pixName, pixType: db.config.pixType };
    db = defaultDB();
    db.config.pixKey = oldPix.pixKey;
    db.config.pixName = oldPix.pixName;
    db.config.pixType = oldPix.pixType;
    sessions.clear(); save();
    res.json({ message: 'Sistema resetado. Todos deslogados.' });
});

app.post('/api/admin/toggle-collapse', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    db.collapsed = !db.collapsed; save();
    res.json({ collapsed: db.collapsed, message: db.collapsed ? 'Sistema COLAPSADO' : 'Sistema reaberto' });
});

// ============================================================
function sanitizeUser(u) {
    return {
        id: u.id, name: u.name, email: u.email,
        inviteCode: u.inviteCode, level: u.level,
        plan: u.plan, planName: u.planName,
        balance: u.balance, totalDeposited: u.totalDeposited,
        totalWithdrawn: u.totalWithdrawn, totalEarnings: u.totalEarnings,
        isAdmin: u.isAdmin, createdAt: u.createdAt, status: u.status
    };
}

const PORT = process.env.PORT || 3000;
const os = require('os');

app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('=== GoldFlow Rodando ===');
    console.log(`http://localhost:${PORT}`);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal)
                console.log(`http://${net.address}:${PORT}`);
        }
    }
    console.log(`Admin: admin / admin | Convite: ${db.users[0].inviteCode}`);
    console.log('========================');
    save();
});
