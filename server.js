const express = require('express');
const crypto = require('crypto');
const db = require('./db');
require('dotenv').config();

const app = express();

// Raw payload read karna HMAC check ke liye
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: true }));

let PLAN_RATES = JSON.parse(process.env.PLAN_RATES || '{"50":1,"300":15,"500":30}');

// ==========================================
// 1. INDEX PAGE (Payment Form)
// ==========================================
app.get('/', (req, res) => res.send(renderIndexHtml()));

app.post('/', async (req, res) => {
    try {
        const selectedAmount = req.body.amount;
        if (!PLAN_RATES.hasOwnProperty(selectedAmount)) return res.send(renderIndexHtml("Invalid plan."));

        const successUrl = encodeURIComponent(process.env.SUCCESS_URL);
        const apiUrl = `https://xwalletbot.shop/wallet/getway/pay.php?key=${process.env.API_KEY}&amount=${selectedAmount}&redirect_url=${successUrl}`;
        
        const response = await fetch(apiUrl);
        const data = await response.json();

        if (data.payment_link && data.order_id) {
            // Cookie ki jagah URL me Order ID pass kiya
            res.redirect(`${data.payment_link}`); 
            // Note: Gateway se redirect hoke success.php par aayenge, hum wahan query param handle karenge
        } else {
            res.send(renderIndexHtml("Payment failed."));
        }
    } catch (e) { res.send(renderIndexHtml("Gateway down.")); }
});

// ==========================================
// 2. WEBHOOK (Atomic Database Insert)
// ==========================================
app.post('/webhook', async (req, res) => {
    const rawPayload = req.rawBody;
    const receivedSignature = req.headers['x-xwallet-signature'] || '';
    const data = req.body;

    // Security Verification
    const calcSig = crypto.createHmac('sha256', process.env.SECRET_KEY).update(rawPayload).digest('hex');
    let isSecure = (crypto.timingSafeEqual(Buffer.from(calcSig), Buffer.from(receivedSignature || ''))) || 
                   (data.secret_key === process.env.SECRET_KEY);

    if (!isSecure) return res.status(401).json({ status: "error" });

    const orderId = (data.order_id || '').trim();
    if (!orderId || (data.status !== 'SUCCESS' && data.status !== 'TXN_SUCCESS')) return res.json({ status: "ignored" });

    try {
        const duration = PLAN_RATES[data.amount] || 0;
        const markNote = `OrderID: ${orderId}`;
        const newCard = crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');

        // INSERT (Duplicate check handled by DB UNIQUE Index)
        await db.execute("INSERT INTO single_card (card, value, type, mark, usable, soft_id) VALUES (?, ?, 3, ?, 1, ?)",
            [newCard, duration, markNote, process.env.SOFT_ID]);
            
        return res.json({ status: "ok" });
    } catch (e) {
        if (e.code === 'ER_DUP_ENTRY') return res.json({ status: "ok", message: "Already processed" });
        return res.status(500).send("DB Error");
    }
});

// ==========================================
// 3. API STATUS CHECKER (Polling)
// ==========================================
app.get('/api/check-status', async (req, res) => {
    const orderId = req.query.order_id;
    const [rows] = await db.execute("SELECT card FROM single_card WHERE mark = ?", [`OrderID: ${orderId}`]);
    if (rows.length > 0) return res.json({ status: "success", card: rows[0].card });
    return res.json({ status: "waiting" });
});

// ==========================================
// 4. SUCCESS PAGE (With Auto-Refresh Logic)
// ==========================================
app.get('/success', (req, res) => {
    const orderId = req.query.order_id; // URL se OrderID uthao
    res.send(renderSuccessHtml(orderId));
});

function renderSuccessHtml(orderId) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>Payment Success</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <style>
        /* AAKAR WAHI OLD DESIGN HAI */
        body { background:#0f1319; color:#fff; font-family:sans-serif; display:flex; justify-content:center; align-items:center; min-height:100vh; }
        .payment-card { background:#181d29; width:100%; max-width:400px; padding:25px; border-radius:16px; border:1px solid #232a3b; text-align:center; }
        .status-box { background: #131722; border: 1px solid #232a3b; padding: 15px; border-radius: 10px; margin: 20px 0; }
        .key-container { background: #0f1319; border: 1px dashed #3b82f6; padding: 20px; border-radius: 12px; }
        .btn-action { background:#3b82f6; color:#fff; border:none; padding:15px; border-radius:10px; width:100%; cursor:pointer; }
    </style>
</head>
<body>
    <div class="payment-card">
        <h3><i class="fas fa-check-circle" style="color:#10b981;"></i> Payment Processing</h3>
        <div id="ui-container">
            <div class="status-box"><i class="fas fa-spinner fa-spin"></i> Generating your key...</div>
        </div>
    </div>
    <script>
        const orderId = "${orderId}";
        const poll = setInterval(async () => {
            const res = await fetch('/api/check-status?order_id=' + orderId);
            const data = await res.json();
            if(data.status === 'success') {
                clearInterval(poll);
                document.getElementById('ui-container').innerHTML = 
                '<div class="status-box" style="color:#10b981;">Key Generated!</div>' +
                '<div class="key-container"><div style="font-size:18px; font-weight:bold;">' + data.card + '</div></div>' +
                '<button class="btn-action" onclick="navigator.clipboard.writeText(\''+data.card+'\')">Copy Key</button>';
            }
        }, 3000);
    </script>
</body>
</html>`;
}

module.exports = app;
