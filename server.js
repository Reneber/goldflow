const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'database.json');

function defaultDB() {
    return {
        users: [{
            id: 1, name: 'Professor (Admin)', email: 'admin', password: 'admin',
            inviteCode: 'PROF-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
            recruiterId: null, level: 0, plan: 0, planName: 'Fundador',
            balance: 0, totalDeposited: 0, totalWithdrawn: 0, totalEarnings: 0,
            createdAt: Date.now(), isAdmin: true, status: 'active'
        }],
        sessions: [],  // {token, userId, createdAt}
        transactions: [],
        withdrawRequests: [], // {id, userId, amount, fee, status, createdAt}
        systemCash: 0, totalInvested: 0, totalPaidOut: 0,
        collapsed: false, nextId: 2, nextWrId: 1,
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
        // Migrations
        db.users.forEach(u => { if (!u.status) u.status = 'active'; });
        if (!db.sessions) db.sessions = [];
        if (!db.withdrawRequests) db.withdrawRequests = [];
        if (!db.nextWrId) db.nextWrId = 1;
        if (!db.config.pixKey && db.config.pixKey !== '') db.config.pixKey = '';
        if (!db.config.pixName) db.config.pixName = 'GoldFlow';
        if (!db.config.pixType) db.config.pixType = 'CPF';
    } else { db = defaultDB(); }
} catch { db = defaultDB(); }

function save() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
function genCode() { return 'GF-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

// Persistent sessions - stored in db.sessions
function createSession(userId) {
    const token = genToken();
    db.sessions.push({ token, userId, createdAt: Date.now() });
    // Keep max 500 sessions (cleanup old)
    if (db.sessions.length > 500) db.sessions = db.sessions.slice(-300);
    save();
    return token;
}

function auth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Nao autenticado' });
    const session = db.sessions.find(s => s.token === token);
    if (!session) return res.status(401).json({ error: 'Sessao expirada. Faca login novamente.' });
    const user = db.users.find(u => u.id === session.userId);
    if (!user) return res.status(401).json({ error: 'Usuario nao encontrado' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Conta suspensa pelo administrador' });
    req.user = user;
    next();
}

function getDirects(userId) {
    return db.users.filter(u => u.recruiterId === userId && u.status === 'active');
}
function getDescendants(userId) {
    const directs = getDirects(userId);
    let all = [...directs];
    directs.forEach(d => { all = all.concat(getDescendants(d.id)); });
    return all;
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
    payUser(recruiter, newUser.plan * db.config.commissionL1, `Comissao direta: ${newUser.name} (${newUser.planName})`);
    if (recruiter.recruiterId) {
        const l2 = db.users.find(u => u.id === recruiter.recruiterId);
        if (l2) payUser(l2, newUser.plan * db.config.commissionL2, `Comissao nivel 2: ${newUser.name}`);
        if (l2 && l2.recruiterId) {
            const l3 = db.users.find(u => u.id === l2.recruiterId);
            if (l3) payUser(l3, newUser.plan * db.config.commissionL3, `Comissao nivel 3: ${newUser.name}`);
        }
    }
    const directCount = getDirects(recruiter.id).length;
    for (const bonus of db.config.bonuses) {
        if (directCount === bonus.directs) payUser(recruiter, bonus.amount, `Bonus: ${bonus.directs} recrutados!`);
    }
}

function checkCollapse() {
    const totalBal = db.users.reduce((s, u) => s + u.balance, 0);
    if (db.systemCash < totalBal * 0.05 && db.users.filter(u => u.status === 'active').length > 5) db.collapsed = true;
}

// ==================== AUTH ====================
app.post('/api/register', (req, res) => {
    const { name, email, password, inviteCode, plan } = req.body;
    if (!name || name.length < 2) return res.status(400).json({ error: 'Nome obrigatorio (min 2)' });
    if (!email) return res.status(400).json({ error: 'Login obrigatorio' });
    if (!password || password.length < 3) return res.status(400).json({ error: 'Senha minima: 3 caracteres' });
    if (!inviteCode) return res.status(400).json({ error: 'Codigo de convite obrigatorio' });
    if (!plan) return res.status(400).json({ error: 'Selecione um plano' });
    // Check duplicate email/login
    if (db.users.find(u => u.email.toLowerCase() === email.trim().toLowerCase()))
        return res.status(400).json({ error: 'Login ja cadastrado' });
    // Check duplicate name
    if (db.users.find(u => u.name.toLowerCase() === name.trim().toLowerCase()))
        return res.status(400).json({ error: 'Ja existe alguem com esse nome. Use um nome diferente.' });

    const recruiter = db.users.find(u => u.inviteCode === inviteCode.toUpperCase().trim());
    if (!recruiter) return res.status(400).json({ error: 'Codigo de convite invalido' });
    if (db.collapsed) return res.status(400).json({ error: 'Sistema temporariamente fechado' });
    const planConfig = db.config.plans.find(p => p.value === parseInt(plan));
    if (!planConfig) return res.status(400).json({ error: 'Plano invalido' });

    const newUser = {
        id: db.nextId++, name: name.trim(), email: email.trim().toLowerCase(), password,
        inviteCode: genCode(), recruiterId: recruiter.id, level: recruiter.level + 1,
        plan: planConfig.value, planName: planConfig.name,
        balance: 0, totalDeposited: 0, totalWithdrawn: 0, totalEarnings: 0,
        createdAt: Date.now(), isAdmin: false, status: 'pending_payment'
    };
    db.users.push(newUser);
    const token = createSession(newUser.id);
    res.json({ token, user: sanitizeUser(newUser) });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    const user = db.users.find(u =>
        (u.email.toLowerCase() === email?.trim().toLowerCase() || u.name.toLowerCase() === email?.trim().toLowerCase())
        && u.password === password
    );
    if (!user) return res.status(401).json({ error: 'Credenciais invalidas' });
    if (user.status === 'banned') return res.status(403).json({ error: 'Conta suspensa pelo administrador' });
    const token = createSession(user.id);
    res.json({ token, user: sanitizeUser(user) });
});

app.post('/api/logout', auth, (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    db.sessions = db.sessions.filter(s => s.token !== token);
    save();
    res.json({ ok: true });
});

// ==================== PAYMENT FLOW ====================
app.get('/api/pix-info', auth, (req, res) => {
    res.json({ pixKey: db.config.pixKey, pixName: db.config.pixName, pixType: db.config.pixType, plan: req.user.plan, planName: req.user.planName, status: req.user.status });
});

app.post('/api/confirm-payment', auth, (req, res) => {
    if (req.user.status !== 'pending_payment') return res.status(400).json({ error: 'Pagamento ja confirmado' });
    req.user.status = 'pending_approval';
    save();
    res.json({ status: req.user.status, message: 'Pagamento informado! Aguarde aprovacao.' });
});

// ==================== USER ====================
app.get('/api/me', auth, (req, res) => {
    const u = req.user;
    const directs = getDirects(u.id);
    const desc = getDescendants(u.id);
    res.json({
        user: sanitizeUser(u),
        stats: { directCount: directs.length, indirectCount: desc.length - directs.length, networkTotal: desc.length, roi: u.plan > 0 ? ((u.totalEarnings / u.plan) * 100).toFixed(1) : '0', netProfit: u.totalEarnings - u.plan },
        collapsed: db.collapsed,
        pendingWithdrawals: db.withdrawRequests.filter(w => w.userId === u.id && w.status === 'pending').length
    });
});

app.get('/api/my-network', auth, (req, res) => {
    const directs = getDirects(req.user.id).map(u => ({ id: u.id, name: u.name, level: u.level, plan: u.planName, recruits: getDirects(u.id).length, relation: 'Direto' }));
    const indirects = [];
    directs.forEach(d => { getDirects(d.id).forEach(u => { indirects.push({ id: u.id, name: u.name, level: u.level, plan: u.planName, recruits: getDirects(u.id).length, relation: 'Indireto' }); }); });
    res.json({ directs, indirects });
});

app.get('/api/my-transactions', auth, (req, res) => {
    res.json({ transactions: db.transactions.filter(t => t.userId === req.user.id).slice(-100).reverse() });
});
app.get('/api/invite-code', auth, (req, res) => { res.json({ code: req.user.inviteCode }); });
app.get('/api/ranking', auth, (req, res) => {
    const ranked = db.users.filter(u => !u.isAdmin && u.status === 'active')
        .map(u => ({ id: u.id, name: u.name, level: u.level, directs: getDirects(u.id).length, network: getDescendants(u.id).length, earnings: u.totalEarnings, isMe: u.id === req.user.id }))
        .sort((a, b) => b.earnings - a.earnings).slice(0, 30);
    res.json({ ranking: ranked });
});
app.get('/api/plans', (req, res) => { res.json({ plans: db.config.plans, collapsed: db.collapsed }); });

// ==================== WITHDRAW REQUEST ====================
app.post('/api/request-withdraw', auth, (req, res) => {
    if (req.user.status !== 'active') return res.status(403).json({ error: 'Conta nao ativa' });
    const amount = parseFloat(req.body.amount);
    if (!amount || amount < 0.5) return res.status(400).json({ error: 'Valor minimo: R$ 0,50' });
    const fee = amount * db.config.withdrawFee;
    const total = amount + fee;
    if (total > req.user.balance) return res.status(400).json({ error: `Saldo insuficiente. Tem R$ ${req.user.balance.toFixed(2)}, precisa R$ ${total.toFixed(2)} (taxa 5%)` });
    // Check pending requests
    const pendingAmt = db.withdrawRequests.filter(w => w.userId === req.user.id && w.status === 'pending').reduce((s, w) => s + w.amount + w.fee, 0);
    if (pendingAmt + total > req.user.balance) return res.status(400).json({ error: 'Voce ja tem saques pendentes que comprometem seu saldo' });

    // Reserve the balance (deduct now, refund if rejected)
    req.user.balance -= total;
    const wr = { id: db.nextWrId++, userId: req.user.id, userName: req.user.name, amount, fee, total, status: 'pending', createdAt: Date.now() };
    db.withdrawRequests.push(wr);
    addTx(req.user.id, 'withdraw_pending', `Saque solicitado: R$ ${amount.toFixed(2)} (aguardando)`, amount, req.user.balance);
    save();
    res.json({ message: `Saque de R$ ${amount.toFixed(2)} solicitado! Aguarde aprovacao.`, balance: req.user.balance });
});

app.get('/api/my-withdrawals', auth, (req, res) => {
    res.json({ withdrawals: db.withdrawRequests.filter(w => w.userId === req.user.id).slice(-20).reverse() });
});

// ==================== ADMIN ====================
app.get('/api/admin/pending', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const pending = db.users.filter(u => u.status === 'pending_approval').map(u => ({
        id: u.id, name: u.name, email: u.email, plan: u.plan, planName: u.planName,
        recruiterName: db.users.find(x => x.id === u.recruiterId)?.name || '-', createdAt: u.createdAt
    }));
    res.json({ pending });
});

app.post('/api/admin/approve/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const user = db.users.find(u => u.id === parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Nao encontrado' });
    if (user.status === 'active') return res.status(400).json({ error: 'Ja ativo' });
    user.status = 'active';
    user.totalDeposited = user.plan;
    db.systemCash += user.plan;
    db.totalInvested += user.plan;
    addTx(user.id, 'investment', `Investimento: ${user.planName}`, user.plan, 0);
    processCommissions(user);
    save();
    res.json({ message: `${user.name} aprovado!` });
});

app.post('/api/admin/reject/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const idx = db.users.findIndex(u => u.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Nao encontrado' });
    if (db.users[idx].status === 'active') return res.status(400).json({ error: 'Ja ativo' });
    const name = db.users[idx].name;
    db.users.splice(idx, 1);
    db.sessions = db.sessions.filter(s => s.userId !== parseInt(req.params.id));
    save();
    res.json({ message: `${name} rejeitado e removido.` });
});

app.post('/api/admin/set-pix', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const { pixKey, pixName, pixType } = req.body;
    if (pixKey !== undefined) db.config.pixKey = pixKey;
    if (pixName !== undefined) db.config.pixName = pixName;
    if (pixType !== undefined) db.config.pixType = pixType;
    save();
    res.json({ message: 'PIX atualizado!' });
});

// Admin: withdraw requests
app.get('/api/admin/withdraw-requests', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const requests = db.withdrawRequests.filter(w => w.status === 'pending').map(w => {
        const u = db.users.find(x => x.id === w.userId);
        return { ...w, userName: u?.name || '?', userEmail: u?.email || '?' };
    });
    res.json({ requests });
});

app.post('/api/admin/approve-withdraw/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const wr = db.withdrawRequests.find(w => w.id === parseInt(req.params.id));
    if (!wr || wr.status !== 'pending') return res.status(400).json({ error: 'Solicitacao nao encontrada' });
    const user = db.users.find(u => u.id === wr.userId);
    if (!user) return res.status(404).json({ error: 'Usuario nao encontrado' });

    // Check system cash
    if (wr.amount > db.systemCash) {
        db.collapsed = true;
        save();
        return res.status(400).json({ error: 'CAIXA VAZIO! Nao ha fundos para este saque.', collapsed: true });
    }

    wr.status = 'approved';
    user.totalWithdrawn += wr.amount;
    db.systemCash -= wr.amount;
    db.totalPaidOut += wr.amount;
    addTx(user.id, 'withdraw', `Saque aprovado: R$ ${wr.amount.toFixed(2)} (taxa: R$ ${wr.fee.toFixed(2)})`, wr.amount, user.balance);
    save();
    res.json({ message: `Saque de R$ ${wr.amount.toFixed(2)} para ${user.name} aprovado!` });
});

app.post('/api/admin/reject-withdraw/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const wr = db.withdrawRequests.find(w => w.id === parseInt(req.params.id));
    if (!wr || wr.status !== 'pending') return res.status(400).json({ error: 'Nao encontrada' });
    const user = db.users.find(u => u.id === wr.userId);
    wr.status = 'rejected';
    // Refund reserved balance
    if (user) {
        user.balance += wr.total;
        addTx(user.id, 'withdraw_refund', `Saque rejeitado: R$ ${wr.amount.toFixed(2)} devolvido`, wr.total, user.balance);
    }
    save();
    res.json({ message: `Saque rejeitado. Saldo devolvido.` });
});

// Admin: ban user
app.post('/api/admin/ban/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const user = db.users.find(u => u.id === parseInt(req.params.id));
    if (!user) return res.status(404).json({ error: 'Nao encontrado' });
    if (user.isAdmin) return res.status(400).json({ error: 'Nao pode banir admin' });
    user.status = user.status === 'banned' ? 'active' : 'banned';
    db.sessions = db.sessions.filter(s => s.userId !== user.id);
    save();
    res.json({ message: user.status === 'banned' ? `${user.name} banido!` : `${user.name} desbanido!` });
});

// Admin: delete user
app.post('/api/admin/delete-user/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const idx = db.users.findIndex(u => u.id === parseInt(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Nao encontrado' });
    if (db.users[idx].isAdmin) return res.status(400).json({ error: 'Nao pode excluir admin' });
    const name = db.users[idx].name;
    db.users.splice(idx, 1);
    db.sessions = db.sessions.filter(s => s.userId !== parseInt(req.params.id));
    save();
    res.json({ message: `${name} excluido!` });
});

// Admin: force logout
app.post('/api/admin/force-logout/:id', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const count = db.sessions.filter(s => s.userId === parseInt(req.params.id)).length;
    db.sessions = db.sessions.filter(s => s.userId !== parseInt(req.params.id));
    save();
    res.json({ message: `${count} sessao(oes) encerrada(s).` });
});

app.get('/api/admin/overview', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const active = db.users.filter(u => u.status === 'active');
    const paying = active.filter(u => u.plan > 0);
    const profiting = paying.filter(u => u.totalEarnings >= u.plan);
    const losing = paying.filter(u => u.totalEarnings < u.plan);
    const totalBal = db.users.reduce((s, u) => s + u.balance, 0);
    const maxLevel = active.length > 1 ? Math.max(...active.map(u => u.level)) : 0;
    const pendingCount = db.users.filter(u => u.status === 'pending_approval').length;
    const pendingWithdrawals = db.withdrawRequests.filter(w => w.status === 'pending').length;
    const levels = [];
    for (let i = 0; i <= maxLevel; i++) {
        const at = active.filter(u => u.level === i);
        levels.push({ level: i, count: at.length, losers: at.filter(u => u.plan > 0 && u.totalEarnings < u.plan).length, invested: at.reduce((s, u) => s + u.totalDeposited, 0) });
    }
    res.json({
        totalMembers: active.length, pendingCount, pendingWithdrawals,
        totalInvested: db.totalInvested, totalPaidOut: db.totalPaidOut,
        systemCash: db.systemCash, totalBalances: totalBal,
        profiting: profiting.length, losing: losing.length,
        lossPct: paying.length > 0 ? ((losing.length / paying.length) * 100).toFixed(1) : '0',
        maxLevel, levels, collapsed: db.collapsed,
        cashCoverage: totalBal > 0 ? ((db.systemCash / totalBal) * 100).toFixed(1) : '100',
        pixKey: db.config.pixKey, pixName: db.config.pixName, pixType: db.config.pixType
    });
});

app.get('/api/admin/users', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    res.json({ users: db.users.map(u => ({
        id: u.id, name: u.name, email: u.email, level: u.level, plan: u.plan, planName: u.planName,
        balance: u.balance, totalDeposited: u.totalDeposited, totalWithdrawn: u.totalWithdrawn,
        totalEarnings: u.totalEarnings, directs: getDirects(u.id).length, network: getDescendants(u.id).length,
        inviteCode: u.inviteCode, recruiterName: u.recruiterId ? db.users.find(x => x.id === u.recruiterId)?.name : null,
        createdAt: u.createdAt, isAdmin: u.isAdmin, userStatus: u.status,
        status: u.isAdmin ? 'admin' : u.status !== 'active' ? u.status : u.totalEarnings >= u.plan ? 'profit' : 'loss'
    }))});
});

app.post('/api/admin/reset', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    const pix = { pixKey: db.config.pixKey, pixName: db.config.pixName, pixType: db.config.pixType };
    db = defaultDB();
    Object.assign(db.config, pix);
    save();
    res.json({ message: 'Resetado! Todos deslogados.' });
});

app.post('/api/admin/toggle-collapse', auth, (req, res) => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Acesso negado' });
    db.collapsed = !db.collapsed; save();
    res.json({ collapsed: db.collapsed, message: db.collapsed ? 'COLAPSADO' : 'Reaberto' });
});

function sanitizeUser(u) {
    return { id: u.id, name: u.name, email: u.email, inviteCode: u.inviteCode, level: u.level, plan: u.plan, planName: u.planName, balance: u.balance, totalDeposited: u.totalDeposited, totalWithdrawn: u.totalWithdrawn, totalEarnings: u.totalEarnings, isAdmin: u.isAdmin, createdAt: u.createdAt, status: u.status };
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`GoldFlow rodando em http://localhost:${PORT}`);
    const os = require('os'), nets = os.networkInterfaces();
    for (const n of Object.keys(nets)) for (const net of nets[n]) if (net.family === 'IPv4' && !net.internal) console.log(`  http://${net.address}:${PORT}`);
    console.log(`Admin: admin/admin | Convite: ${db.users[0].inviteCode}`);
    save();
});
